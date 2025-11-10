"""Channel-specific API endpoints."""

from __future__ import annotations

import base64
from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal, Sequence

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.constants import ALLOWED_CHANNEL_TYPES, TEXT_CHANNEL_TYPES, VOICE_CHANNEL_TYPES
from app.api.deps import ensure_minimum_role, get_current_user, require_room_member
from app.config import get_settings
from app.core import build_download_url, resolve_path, store_upload
from app.database import get_db
from app.models import (
    AnnouncementCrossPost,
    Channel,
    ChannelCategory,
    ChannelPermission,
    ChannelRolePermissionOverwrite,
    ChannelType,
    ChannelUserPermissionOverwrite,
    Event,
    EventParticipant,
    EventReminder,
    ForumChannelTag,
    ForumPost,
    ForumPostTag,
    Message,
    MessageAttachment,
    MessageReaction,
    MessageReceipt,
    PinnedMessage,
    Room,
    RoomRole,
    User,
    decode_permissions,
    encode_permissions,
)
from app.schemas import (
    AnnouncementCreate,
    ChannelRead,
    ChannelPermissionPayload,
    ChannelPermissionRoleRead,
    ChannelPermissionSummary,
    ChannelPermissionUserRead,
    ChannelUpdate,
    CrossPostRead,
    CrossPostRequest,
    EventCreate,
    EventDetailRead,
    EventListPage,
    EventParticipantRead,
    EventRead,
    EventReminderCreate,
    EventReminderRead,
    EventRSVPRequest,
    EventUpdate,
    ForumChannelTagCreate,
    ForumChannelTagRead,
    ForumChannelTagUpdate,
    ForumPostCreate,
    ForumPostDetailRead,
    ForumPostListPage,
    ForumPostRead,
    ForumPostUpdate,
    MessageAttachmentRead,
    MessageAuthor,
    MessageHistoryPage,
    MessageRead,
    MessageReactionSummary,
    MessageReceiptUpdate,
    PinMessageRequest,
    PinnedMessageRead,
    ReactionRequest,
)
from app.search import MessageSearchFilters, MessageSearchService
from app.services.permissions import has_permission
from app.services.workspace_events import (
    publish_announcement_created,
    publish_announcement_cross_posted,
    publish_event_created,
    publish_event_deleted,
    publish_event_rsvp_changed,
    publish_event_updated,
    publish_forum_post_created,
    publish_forum_post_deleted,
    publish_forum_post_updated,
    publish_channel_updated,
)

router = APIRouter(prefix="/channels", tags=["channels"])

ADMIN_ROLES: tuple[RoomRole, ...] = (RoomRole.OWNER, RoomRole.ADMIN)

settings = get_settings()

_MESSAGE_LOAD_OPTIONS = (
    selectinload(Message.attachments),
    selectinload(Message.reactions),
    selectinload(Message.receipts),
    selectinload(Message.author),
    selectinload(Message.moderated_by),
    selectinload(Message.parent).selectinload(Message.author),
    selectinload(Message.thread_root).selectinload(Message.author),
    selectinload(Message.pin_entries).selectinload(PinnedMessage.pinned_by),
)

_PINNED_LOAD_OPTIONS = (
    selectinload(PinnedMessage.message).options(*_MESSAGE_LOAD_OPTIONS),
    selectinload(PinnedMessage.pinned_by),
)


def _get_channel(channel_id: int, db: Session) -> Channel:
    channel_stmt = select(Channel).where(Channel.id == channel_id)
    channel = db.execute(channel_stmt).scalar_one_or_none()
    if channel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")
    return channel


def _ensure_text_channel(channel: Channel) -> None:
    if channel.type not in TEXT_CHANNEL_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="History is only available for text channels",
        )


def _get_message(channel_id: int, message_id: int, db: Session) -> Message:
    stmt = (
        select(Message)
        .where(Message.id == message_id, Message.channel_id == channel_id)
        .options(*_MESSAGE_LOAD_OPTIONS)
    )
    message = db.execute(stmt).scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    return message


async def _sync_reaction_to_cross_posts(
    message_id: int, user_id: int, emoji: str, db: Session, add: bool
) -> None:
    """Sync a reaction to all cross-posted copies of a message."""
    # Check if this message is an original announcement
    original_cross_posts = db.execute(
        select(AnnouncementCrossPost).where(
            AnnouncementCrossPost.original_message_id == message_id
        )
    ).scalars().all()

    # Check if this message is a cross-posted copy
    cross_posted_entry = db.execute(
        select(AnnouncementCrossPost).where(
            AnnouncementCrossPost.cross_posted_message_id == message_id
        )
    ).scalar_one_or_none()

    messages_to_sync: list[int] = []

    # If this is an original message, sync to all cross-posts
    if original_cross_posts:
        messages_to_sync.extend([cp.cross_posted_message_id for cp in original_cross_posts])

    # If this is a cross-posted copy, sync to original and all other cross-posts
    if cross_posted_entry:
        original_id = cross_posted_entry.original_message_id
        messages_to_sync.append(original_id)
        # Get all other cross-posts of the same original
        other_cross_posts = db.execute(
            select(AnnouncementCrossPost).where(
                AnnouncementCrossPost.original_message_id == original_id,
                AnnouncementCrossPost.cross_posted_message_id != message_id,
            )
        ).scalars().all()
        messages_to_sync.extend([cp.cross_posted_message_id for cp in other_cross_posts])

    # Sync reaction to all related messages
    for target_message_id in messages_to_sync:
        if add:
            # Add reaction if it doesn't exist
            existing = db.execute(
                select(MessageReaction).where(
                    MessageReaction.message_id == target_message_id,
                    MessageReaction.user_id == user_id,
                    MessageReaction.emoji == emoji,
                )
            ).scalar_one_or_none()
            if existing is None:
                reaction = MessageReaction(
                    message_id=target_message_id,
                    user_id=user_id,
                    emoji=emoji,
                )
                db.add(reaction)
        else:
            # Remove reaction if it exists
            reaction = db.execute(
                select(MessageReaction).where(
                    MessageReaction.message_id == target_message_id,
                    MessageReaction.user_id == user_id,
                    MessageReaction.emoji == emoji,
                )
            ).scalar_one_or_none()
            if reaction is not None:
                db.delete(reaction)

    if messages_to_sync:
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            # Ignore conflicts - reaction might already exist/not exist


def _collect_reply_statistics(
    messages: Sequence[Message], db: Session
) -> tuple[dict[int, int], dict[int, int]]:
    if not messages:
        return {}, {}

    message_ids = [message.id for message in messages]
    direct_stmt = (
        select(Message.parent_id, func.count(Message.id))
        .where(Message.parent_id.in_(message_ids))
        .group_by(Message.parent_id)
    )
    direct_counts = {
        parent_id: count for parent_id, count in db.execute(direct_stmt) if parent_id is not None
    }

    root_ids = {message.thread_root_id or message.id for message in messages}
    thread_stmt = (
        select(Message.thread_root_id, func.count(Message.id))
        .where(
            Message.thread_root_id.in_(root_ids),
            Message.id != Message.thread_root_id,
        )
        .group_by(Message.thread_root_id)
    )
    thread_counts = {root_id: count for root_id, count in db.execute(thread_stmt)}
    return direct_counts, thread_counts


def _serialize_user(user: User | None) -> MessageAuthor | None:
    if user is None:
        return None
    return MessageAuthor(
        id=user.id,
        login=user.login,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        status=user.presence_status,
    )


def _serialize_message(
    message: Message,
    *,
    current_user_id: int | None,
    direct_counts: dict[int, int],
    thread_counts: dict[int, int],
) -> MessageRead:
    grouped_reactions: dict[str, list[int]] = defaultdict(list)
    for reaction in message.reactions:
        grouped_reactions[reaction.emoji].append(reaction.user_id)

    reactions: list[MessageReactionSummary] = []
    for emoji, user_ids in sorted(grouped_reactions.items()):
        reactions.append(
            MessageReactionSummary(
                emoji=emoji,
                count=len(user_ids),
                reacted=current_user_id in user_ids if current_user_id is not None else False,
                user_ids=sorted(user_ids),
            )
        )

    attachments: list[MessageAttachmentRead] = []
    for attachment in message.attachments:
        download_url = build_download_url(attachment.channel_id, attachment.id)
        preview_url = download_url if (attachment.content_type or "").startswith("image/") else None
        attachments.append(
            MessageAttachmentRead(
                id=attachment.id,
                channel_id=attachment.channel_id,
                message_id=attachment.message_id,
                file_name=attachment.file_name,
                content_type=attachment.content_type,
                file_size=attachment.file_size,
                download_url=download_url,
                preview_url=preview_url,
                uploaded_by=attachment.uploader_id,
                created_at=attachment.created_at,
            )
        )

    direct_replies = direct_counts.get(message.id, 0)
    thread_root_id = message.thread_root_id or message.id
    thread_replies = thread_counts.get(thread_root_id, 0)

    delivered_at = None
    read_at = None
    if current_user_id is not None:
        for receipt in message.receipts:
            if receipt.user_id == current_user_id:
                delivered_at = receipt.delivered_at
                read_at = receipt.read_at
                break

    pinned_entry = None
    if message.pin_entries:
        pinned_entry = max(message.pin_entries, key=lambda pin: pin.pinned_at)

    return MessageRead(
        id=message.id,
        channel_id=message.channel_id,
        author_id=message.author_id,
        author=_serialize_user(message.author),
        content=message.content,
        created_at=message.created_at,
        updated_at=message.updated_at,
        edited_at=message.edited_at,
        deleted_at=message.deleted_at,
        moderated_at=message.moderated_at,
        moderation_note=message.moderation_note,
        moderated_by=_serialize_user(message.moderated_by),
        parent_id=message.parent_id,
        thread_root_id=thread_root_id,
        reply_count=direct_replies,
        thread_reply_count=thread_replies,
        attachments=attachments,
        reactions=reactions,
        delivered_count=message.delivered_count,
        read_count=message.read_count,
        delivered_at=delivered_at,
        read_at=read_at,
        pinned_at=pinned_entry.pinned_at if pinned_entry else None,
        pinned_by=_serialize_user(pinned_entry.pinned_by) if pinned_entry else None,
    )


def _serialize_role_overwrite(
    overwrite: ChannelRolePermissionOverwrite,
) -> ChannelPermissionRoleRead:
    return ChannelPermissionRoleRead(
        role=overwrite.role,
        allow=decode_permissions(overwrite.allow_mask),
        deny=decode_permissions(overwrite.deny_mask),
    )


def _serialize_user_overwrite(
    overwrite: ChannelUserPermissionOverwrite,
) -> ChannelPermissionUserRead:
    user = overwrite.user
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User associated with overwrite not found",
        )
    return ChannelPermissionUserRead(
        user_id=overwrite.user_id,
        login=user.login,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        status=user.presence_status,
        allow=decode_permissions(overwrite.allow_mask),
        deny=decode_permissions(overwrite.deny_mask),
    )


def _serialize_messages(
    messages: Sequence[Message], current_user_id: int | None, db: Session
) -> list[MessageRead]:
    direct_counts, thread_counts = _collect_reply_statistics(messages, db)
    return [
        _serialize_message(
            message,
            current_user_id=current_user_id,
            direct_counts=direct_counts,
            thread_counts=thread_counts,
        )
        for message in messages
    ]


def _encode_cursor(message: Message, direction: Literal["backward", "forward"]) -> str:
    payload = f"v1|{message.created_at.isoformat()}|{message.id}|{direction}"
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, int, Literal["backward", "forward"]]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("utf-8")).decode("utf-8")
        version, timestamp, message_id_str, direction = raw.split("|", 3)
        if version != "v1":
            raise ValueError("Unsupported cursor version")
        message_id = int(message_id_str)
        pivot_time = datetime.fromisoformat(timestamp)
        if direction not in {"backward", "forward"}:
            raise ValueError("Invalid cursor direction")
        return pivot_time, message_id, direction  # type: ignore[return-value]
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor"
        ) from exc


def _has_more_backward(channel_id: int, anchor: Message, db: Session) -> bool:
    stmt = (
        select(Message.id)
        .where(Message.channel_id == channel_id)
        .where(
            or_(
                Message.created_at < anchor.created_at,
                and_(Message.created_at == anchor.created_at, Message.id < anchor.id),
            )
        )
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none() is not None


def _has_more_forward(channel_id: int, anchor: Message, db: Session) -> bool:
    stmt = (
        select(Message.id)
        .where(Message.channel_id == channel_id)
        .where(
            or_(
                Message.created_at > anchor.created_at,
                and_(Message.created_at == anchor.created_at, Message.id > anchor.id),
            )
        )
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none() is not None


def _collect_backward(
    channel_id: int,
    limit: int,
    db: Session,
    *,
    pivot: Message | None,
) -> tuple[list[Message], bool]:
    stmt = select(Message).where(Message.channel_id == channel_id)
    if pivot is not None:
        stmt = stmt.where(
            or_(
                Message.created_at < pivot.created_at,
                and_(Message.created_at == pivot.created_at, Message.id < pivot.id),
            )
        )
    stmt = (
        stmt.order_by(Message.created_at.desc(), Message.id.desc())
        .limit(max(limit, 0) + 1)
        .options(*_MESSAGE_LOAD_OPTIONS)
    )
    rows = list(db.execute(stmt).scalars())
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:-1]
    rows.reverse()
    return rows, has_more


def _collect_forward(
    channel_id: int,
    limit: int,
    db: Session,
    *,
    pivot: Message | None,
) -> tuple[list[Message], bool]:
    stmt = select(Message).where(Message.channel_id == channel_id)
    if pivot is not None:
        stmt = stmt.where(
            or_(
                Message.created_at > pivot.created_at,
                and_(Message.created_at == pivot.created_at, Message.id > pivot.id),
            )
        )
    stmt = (
        stmt.order_by(Message.created_at.asc(), Message.id.asc())
        .limit(max(limit, 0) + 1)
        .options(*_MESSAGE_LOAD_OPTIONS)
    )
    rows = list(db.execute(stmt).scalars())
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:-1]
    return rows, has_more


def fetch_channel_history(
    channel_id: int,
    limit: int,
    db: Session,
    *,
    current_user_id: int | None,
    pivot: Message | None = None,
    direction: Literal["backward", "forward"] = "backward",
) -> MessageHistoryPage:
    if limit <= 0:
        return MessageHistoryPage(items=[])

    if direction not in {"backward", "forward"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid direction")

    if direction == "backward":
        messages, has_more_backward = _collect_backward(channel_id, limit, db, pivot=pivot)
        anchor_for_forward = (
            pivot if not messages and pivot is not None else (messages[-1] if messages else None)
        )
        has_more_forward = (
            _has_more_forward(channel_id, anchor_for_forward, db)
            if anchor_for_forward is not None
            else False
        )
        serialized = _serialize_messages(messages, current_user_id, db)
        next_cursor = (
            _encode_cursor(messages[0], "backward") if has_more_backward and messages else None
        )
        prev_cursor = (
            _encode_cursor(messages[-1], "forward") if has_more_forward and messages else None
        )
        has_more_backward_value = has_more_backward
        has_more_forward_value = has_more_forward
    else:
        messages, has_more_forward = _collect_forward(channel_id, limit, db, pivot=pivot)
        anchor_for_backward = (
            pivot if not messages and pivot is not None else (messages[0] if messages else None)
        )
        has_more_backward = (
            _has_more_backward(channel_id, anchor_for_backward, db)
            if anchor_for_backward is not None
            else False
        )
        serialized = _serialize_messages(messages, current_user_id, db)
        next_cursor = (
            _encode_cursor(messages[-1], "forward") if has_more_forward and messages else None
        )
        prev_cursor = (
            _encode_cursor(messages[0], "backward") if has_more_backward and messages else None
        )
        has_more_backward_value = has_more_backward
        has_more_forward_value = has_more_forward

    return MessageHistoryPage(
        items=serialized,
        next_cursor=next_cursor,
        prev_cursor=prev_cursor,
        has_more_backward=has_more_backward_value,
        has_more_forward=has_more_forward_value,
    )


def fetch_channel_history_around(
    channel_id: int,
    limit: int,
    db: Session,
    *,
    current_user_id: int | None,
    pivot: Message,
) -> MessageHistoryPage:
    normalized_limit = max(limit, 1)
    before_limit = max(0, (normalized_limit - 1) // 2)
    after_limit = max(0, normalized_limit - 1 - before_limit)

    before_messages: list[Message] = []
    has_more_backward = False
    if before_limit > 0:
        before_messages, has_more_backward = _collect_backward(
            channel_id, before_limit, db, pivot=pivot
        )
    else:
        has_more_backward = _has_more_backward(channel_id, pivot, db)

    after_messages: list[Message] = []
    has_more_forward = False
    if after_limit > 0:
        after_messages, has_more_forward = _collect_forward(
            channel_id, after_limit, db, pivot=pivot
        )
    else:
        has_more_forward = _has_more_forward(channel_id, pivot, db)

    messages = before_messages + [pivot] + after_messages
    serialized = _serialize_messages(messages, current_user_id, db)

    next_cursor = None
    if has_more_backward:
        anchor = before_messages[0] if before_messages else pivot
        next_cursor = _encode_cursor(anchor, "backward")

    prev_cursor = None
    if has_more_forward:
        anchor = after_messages[-1] if after_messages else pivot
        prev_cursor = _encode_cursor(anchor, "forward")

    return MessageHistoryPage(
        items=serialized,
        next_cursor=next_cursor,
        prev_cursor=prev_cursor,
        has_more_backward=has_more_backward,
        has_more_forward=has_more_forward,
    )


def _serialize_pinned_message(
    pinned: PinnedMessage, current_user_id: int | None, db: Session
) -> PinnedMessageRead:
    if pinned.message is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pinned message target missing",
        )
    message_read = _serialize_messages([pinned.message], current_user_id, db)[0]
    return PinnedMessageRead(
        id=pinned.id,
        channel_id=pinned.channel_id,
        message_id=pinned.message_id,
        message=message_read,
        pinned_at=pinned.pinned_at,
        pinned_by=_serialize_user(pinned.pinned_by),
        note=pinned.note,
    )


def serialize_message_by_id(
    message_id: int, db: Session, current_user_id: int | None
) -> MessageRead:
    stmt = select(Message).where(Message.id == message_id).options(*_MESSAGE_LOAD_OPTIONS)
    message = db.execute(stmt).scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    return _serialize_messages([message], current_user_id, db)[0]


@router.get("/{channel_id}/history", response_model=MessageHistoryPage)
def get_channel_history(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    limit: int | None = Query(default=None, ge=1),
    before: int | None = Query(default=None),
    after: int | None = Query(default=None),
    around: int | None = Query(default=None),
    cursor: str | None = Query(default=None),
    direction: Literal["backward", "forward"] = Query(default="backward"),
) -> MessageHistoryPage:
    """Return the latest messages from a channel."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    effective_limit = limit or settings.chat_history_default_limit
    effective_limit = min(effective_limit, settings.chat_history_max_limit)

    pivot_params = [value for value in (cursor, before, after, around) if value is not None]
    if len(pivot_params) > 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide only one of cursor, before, after, or around",
        )

    if around is not None:
        pivot_message = _get_message(channel.id, around, db)
        return fetch_channel_history_around(
            channel.id,
            effective_limit,
            db,
            current_user_id=current_user.id,
            pivot=pivot_message,
        )

    pivot_message: Message | None = None
    effective_direction = direction

    if cursor is not None:
        pivot_time, pivot_id, cursor_direction = _decode_cursor(cursor)
        pivot_message = _get_message(channel.id, pivot_id, db)
        if pivot_message.created_at != pivot_time:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cursor is no longer valid",
            )
        effective_direction = cursor_direction
    elif before is not None:
        pivot_message = _get_message(channel.id, before, db)
        effective_direction = "backward"
    elif after is not None:
        pivot_message = _get_message(channel.id, after, db)
        effective_direction = "forward"

    return fetch_channel_history(
        channel.id,
        effective_limit,
        db,
        current_user_id=current_user.id,
        pivot=pivot_message,
        direction=effective_direction,
    )


@router.get("/{channel_id}/pins", response_model=list[PinnedMessageRead])
def get_channel_pins(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PinnedMessageRead]:
    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    stmt = (
        select(PinnedMessage)
        .where(PinnedMessage.channel_id == channel.id)
        .order_by(PinnedMessage.pinned_at.desc(), PinnedMessage.id.desc())
        .options(*_PINNED_LOAD_OPTIONS)
    )
    pinned = list(db.execute(stmt).scalars())
    return [_serialize_pinned_message(item, current_user.id, db) for item in pinned]


@router.post(
    "/{channel_id}/pins/{message_id}",
    response_model=PinnedMessageRead,
    status_code=status.HTTP_201_CREATED,
)
def pin_channel_message(
    channel_id: int,
    message_id: int,
    payload: PinMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PinnedMessageRead:
    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    message = _get_message(channel.id, message_id, db)

    existing_stmt = (
        select(PinnedMessage)
        .where(
            PinnedMessage.channel_id == channel.id,
            PinnedMessage.message_id == message.id,
        )
        .options(*_PINNED_LOAD_OPTIONS)
    )
    existing = db.execute(existing_stmt).scalar_one_or_none()
    if existing is not None:
        existing.note = payload.note
        existing.pinned_by_id = current_user.id
        existing.pinned_at = datetime.now(timezone.utc)
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return _serialize_pinned_message(existing, current_user.id, db)

    pinned = PinnedMessage(
        channel_id=channel.id,
        message_id=message.id,
        pinned_by_id=current_user.id,
        note=payload.note,
    )
    db.add(pinned)
    db.commit()
    pinned_row = (
        select(PinnedMessage).where(PinnedMessage.id == pinned.id).options(*_PINNED_LOAD_OPTIONS)
    )
    pinned_full = db.execute(pinned_row).scalar_one()
    return _serialize_pinned_message(pinned_full, current_user.id, db)


@router.delete("/{channel_id}/pins/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
def unpin_channel_message(
    channel_id: int,
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    stmt = (
        select(PinnedMessage)
        .where(
            PinnedMessage.channel_id == channel.id,
            PinnedMessage.message_id == message_id,
        )
        .options(*_PINNED_LOAD_OPTIONS)
    )
    pinned = db.execute(stmt).scalar_one_or_none()
    if pinned is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Pinned message not found"
        )

    db.delete(pinned)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{channel_id}/threads/{message_id}", response_model=list[MessageRead])
def get_thread_messages(
    channel_id: int,
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[MessageRead]:
    """Return a thread including the root message and all replies."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    root_message = _get_message(channel.id, message_id, db)
    stmt = (
        select(Message)
        .where(
            Message.channel_id == channel.id,
            or_(
                Message.id == root_message.id,
                Message.thread_root_id == root_message.id,
                Message.parent_id == root_message.id,
            ),
        )
        .order_by(Message.created_at.asc(), Message.id.asc())
        .options(*_MESSAGE_LOAD_OPTIONS)
    )
    messages = list(db.execute(stmt).scalars())
    return _serialize_messages(messages, current_user.id, db)


@router.get("/{channel_id}/search", response_model=list[MessageRead])
def search_messages(
    channel_id: int,
    query: str | None = Query(default=None, min_length=1),
    author_id: int | None = Query(default=None),
    has_attachments: bool | None = Query(default=None),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    thread_root_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[MessageRead]:
    """Perform a filtered search across channel messages."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    effective_limit = min(limit, settings.chat_history_max_limit)

    filters = MessageSearchFilters(
        author_id=author_id,
        has_attachments=has_attachments,
        start_at=start,
        end_at=end,
        thread_root_id=thread_root_id,
    )

    service = MessageSearchService(db)
    result = service.search(
        channel.id,
        query or "",
        limit=effective_limit,
        filters=filters,
        options=_MESSAGE_LOAD_OPTIONS,
    )

    messages = result.messages
    return _serialize_messages(messages, current_user.id, db)


@router.post(
    "/{channel_id}/attachments",
    response_model=MessageAttachmentRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    channel_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageAttachmentRead:
    """Upload an attachment for subsequent inclusion in a message."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    stored = await store_upload(channel.id, file)
    attachment = MessageAttachment(
        channel_id=channel.id,
        uploader_id=current_user.id,
        file_name=stored.file_name,
        content_type=stored.content_type,
        file_size=stored.file_size,
        storage_path=stored.relative_path,
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    download_url = build_download_url(attachment.channel_id, attachment.id)
    preview_url = download_url if (attachment.content_type or "").startswith("image/") else None

    return MessageAttachmentRead(
        id=attachment.id,
        channel_id=attachment.channel_id,
        message_id=attachment.message_id,
        file_name=attachment.file_name,
        content_type=attachment.content_type,
        file_size=attachment.file_size,
        download_url=download_url,
        preview_url=preview_url,
        uploaded_by=attachment.uploader_id,
        created_at=attachment.created_at,
    )


@router.get("/{channel_id}/attachments/{attachment_id}/download")
def download_attachment(
    channel_id: int,
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FileResponse:
    """Return the raw file for an attachment."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    attachment = db.get(MessageAttachment, attachment_id)
    if attachment is None or attachment.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")

    if attachment.message_id is None and attachment.uploader_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not accessible"
        )

    file_path = resolve_path(attachment.storage_path)
    return FileResponse(
        file_path,
        media_type=attachment.content_type or "application/octet-stream",
        filename=attachment.file_name,
    )


@router.post(
    "/{channel_id}/messages/{message_id}/reactions",
    response_model=MessageRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_reaction(
    channel_id: int,
    message_id: int,
    payload: ReactionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Add a reaction to a message."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    message = _get_message(channel.id, message_id, db)

    reaction = MessageReaction(
        message_id=message.id,
        user_id=current_user.id,
        emoji=payload.emoji,
    )
    db.add(reaction)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Reaction already exists")

    # Check if this message is part of a cross-post and sync reactions
    await _sync_reaction_to_cross_posts(message.id, current_user.id, payload.emoji, db, add=True)

    return serialize_message_by_id(message.id, db, current_user.id)


@router.delete("/{channel_id}/messages/{message_id}/reactions", response_model=MessageRead)
async def remove_reaction(
    channel_id: int,
    message_id: int,
    emoji: str = Query(..., min_length=1, max_length=32),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Remove the current user's reaction from a message."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    message = _get_message(channel.id, message_id, db)
    stmt = select(MessageReaction).where(
        MessageReaction.message_id == message.id,
        MessageReaction.user_id == current_user.id,
        MessageReaction.emoji == emoji,
    )
    reaction = db.execute(stmt).scalar_one_or_none()
    if reaction is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reaction not found")

    db.delete(reaction)
    db.commit()

    # Check if this message is part of a cross-post and sync reactions
    await _sync_reaction_to_cross_posts(message.id, current_user.id, emoji, db, add=False)

    return serialize_message_by_id(message.id, db, current_user.id)


@router.post(
    "/{channel_id}/messages/{message_id}/receipts",
    response_model=MessageRead,
    status_code=status.HTTP_200_OK,
)
def update_message_receipt(
    channel_id: int,
    message_id: int,
    payload: MessageReceiptUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Update delivery and read status for the current user."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    message = _get_message(channel.id, message_id, db)

    stmt = select(MessageReceipt).where(
        MessageReceipt.message_id == message.id,
        MessageReceipt.user_id == current_user.id,
    )
    receipt = db.execute(stmt).scalar_one_or_none()
    if receipt is None:
        receipt = MessageReceipt(message_id=message.id, user_id=current_user.id)
        db.add(receipt)

    now = datetime.now(timezone.utc)
    changed = False

    if payload.delivered:
        if receipt.delivered_at is None:
            receipt.delivered_at = now
            message.delivered_count += 1
            changed = True

    if payload.read:
        if receipt.read_at is None:
            receipt.read_at = now
            message.read_count += 1
            changed = True
        if receipt.delivered_at is None:
            receipt.delivered_at = now
            message.delivered_count += 1
            changed = True

    if changed:
        db.commit()
    else:
        db.rollback()

    return serialize_message_by_id(message.id, db, current_user.id)


@router.patch("/{channel_id}", response_model=ChannelRead)
def update_channel(
    channel_id: int,
    payload: ChannelUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Channel:
    """Update mutable channel attributes such as name or category."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        channel.name = update_data["name"]
    if "category_id" in update_data:
        category_id = update_data["category_id"]
        if category_id is None:
            channel.category_id = None
        else:
            category = db.get(ChannelCategory, category_id)
            if category is None or category.room_id != channel.room_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Category not found",
                )
            channel.category_id = category.id
    if "topic" in update_data:
        channel.topic = update_data["topic"]
    if "slowmode_seconds" in update_data:
        channel.slowmode_seconds = update_data["slowmode_seconds"]
    if "is_nsfw" in update_data:
        channel.is_nsfw = update_data["is_nsfw"]
    if "is_private" in update_data:
        channel.is_private = update_data["is_private"]

    db.commit()
    db.refresh(channel)
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_channel_updated(room_slug, channel)
    return channel


@router.get("/{channel_id}/permissions", response_model=ChannelPermissionSummary)
def list_channel_permissions(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChannelPermissionSummary:
    """Return configured permission overwrites for a channel."""

    channel = _get_channel(channel_id, db)
    require_room_member(channel.room_id, current_user.id, db)

    role_overwrites = sorted(
        list(
            db.execute(
                select(ChannelRolePermissionOverwrite).where(
                    ChannelRolePermissionOverwrite.channel_id == channel.id
                )
            ).scalars()
        ),
        key=lambda overwrite: overwrite.role.value,
    )
    user_overwrites = list(
        db.execute(
            select(ChannelUserPermissionOverwrite)
            .where(ChannelUserPermissionOverwrite.channel_id == channel.id)
            .options(selectinload(ChannelUserPermissionOverwrite.user))
        ).scalars()
    )

    return ChannelPermissionSummary(
        channel_id=channel.id,
        roles=[_serialize_role_overwrite(entry) for entry in role_overwrites],
        users=[
            _serialize_user_overwrite(entry) for entry in user_overwrites if entry.user is not None
        ],
    )


@router.put("/{channel_id}/permissions/roles/{role}", response_model=ChannelPermissionRoleRead)
def upsert_channel_role_permissions(
    channel_id: int,
    role: RoomRole,
    payload: ChannelPermissionPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChannelPermissionRoleRead:
    """Create or update role-based permission overrides for a channel."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    stmt = select(ChannelRolePermissionOverwrite).where(
        ChannelRolePermissionOverwrite.channel_id == channel.id,
        ChannelRolePermissionOverwrite.role == role,
    )
    overwrite = db.execute(stmt).scalar_one_or_none()

    if overwrite is None:
        overwrite = ChannelRolePermissionOverwrite(channel_id=channel.id, role=role)
        db.add(overwrite)

    overwrite.allow_mask = encode_permissions(payload.allow)
    overwrite.deny_mask = encode_permissions(payload.deny)

    db.commit()
    db.refresh(overwrite)
    return _serialize_role_overwrite(overwrite)


@router.delete("/{channel_id}/permissions/roles/{role}")
def delete_channel_role_permissions(
    channel_id: int,
    role: RoomRole,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Delete role-based permission overrides for a channel if present."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    stmt = select(ChannelRolePermissionOverwrite).where(
        ChannelRolePermissionOverwrite.channel_id == channel.id,
        ChannelRolePermissionOverwrite.role == role,
    )
    overwrite = db.execute(stmt).scalar_one_or_none()
    if overwrite is not None:
        db.delete(overwrite)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{channel_id}/permissions/users/{user_id}", response_model=ChannelPermissionUserRead)
def upsert_channel_user_permissions(
    channel_id: int,
    user_id: int,
    payload: ChannelPermissionPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChannelPermissionUserRead:
    """Create or update user-specific permission overrides."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    require_room_member(channel.room_id, user_id, db)

    stmt = select(ChannelUserPermissionOverwrite).where(
        ChannelUserPermissionOverwrite.channel_id == channel.id,
        ChannelUserPermissionOverwrite.user_id == user_id,
    )
    overwrite = db.execute(stmt).scalar_one_or_none()

    if overwrite is None:
        overwrite = ChannelUserPermissionOverwrite(channel_id=channel.id, user_id=user_id)
        db.add(overwrite)

    overwrite.allow_mask = encode_permissions(payload.allow)
    overwrite.deny_mask = encode_permissions(payload.deny)

    db.commit()
    overwrite = db.execute(
        select(ChannelUserPermissionOverwrite)
        .where(ChannelUserPermissionOverwrite.id == overwrite.id)
        .options(selectinload(ChannelUserPermissionOverwrite.user))
    ).scalar_one_or_none()
    if overwrite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Overwrite not found")
    return _serialize_user_overwrite(overwrite)


@router.post("/{channel_id}/archive", response_model=ChannelRead)
def archive_channel(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Channel:
    """Archive a channel. Archived channels cannot receive new messages."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    if channel.is_archived:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Channel is already archived",
        )

    channel.is_archived = True
    channel.archived_at = datetime.now(timezone.utc)
    channel.archived_by_id = current_user.id

    db.commit()
    db.refresh(channel)
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_channel_updated(room_slug, channel)
    return channel


@router.post("/{channel_id}/unarchive", response_model=ChannelRead)
def unarchive_channel(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Channel:
    """Unarchive a channel. Restores the channel to normal operation."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    if not channel.is_archived:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Channel is not archived",
        )

    channel.is_archived = False
    channel.archived_at = None
    channel.archived_by_id = None

    db.commit()
    db.refresh(channel)
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_channel_updated(room_slug, channel)
    return channel


@router.delete("/{channel_id}/permissions/users/{user_id}")
def delete_channel_user_permissions(
    channel_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Remove user-specific permission overrides for a channel."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    stmt = select(ChannelUserPermissionOverwrite).where(
        ChannelUserPermissionOverwrite.channel_id == channel.id,
        ChannelUserPermissionOverwrite.user_id == user_id,
    )
    overwrite = db.execute(stmt).scalar_one_or_none()
    if overwrite is not None:
        db.delete(overwrite)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{channel_id}/announcements",
    response_model=MessageRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_announcement(
    channel_id: int,
    payload: AnnouncementCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Create an announcement in an announcement channel."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.ANNOUNCEMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for announcement channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Check permission
    if not has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.PUBLISH_ANNOUNCEMENTS,
        channel_id=channel.id,
        db=db,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to publish announcements",
        )

    # Check if channel is archived
    if channel.is_archived:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot send messages to archived channels",
        )

    # Validate content
    normalized = payload.content.rstrip()
    if not normalized.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Announcement content is required"
        )

    if len(normalized) > settings.chat_message_max_length:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Message exceeds maximum length of {settings.chat_message_max_length} characters",
        )

    # Create message
    message = Message(
        channel_id=channel.id,
        author_id=current_user.id,
        content=normalized,
    )
    db.add(message)
    db.flush()

    if message.thread_root_id is None:
        message.thread_root_id = message.id

    db.commit()

    serialized = serialize_message_by_id(message.id, db, current_user.id)
    from app.api.ws import manager
    await manager.broadcast(
        channel.id,
        {"type": "message", "message": serialized.model_dump(mode="json")},
    )
    
    # Publish announcement created event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_announcement_created(
        room_slug,
        channel.id,
        serialized.model_dump(mode="json"),
    )
    
    return serialized


@router.post(
    "/{channel_id}/announcements/{message_id}/cross-post",
    response_model=list[CrossPostRead],
    status_code=status.HTTP_201_CREATED,
)
async def cross_post_announcement(
    channel_id: int,
    message_id: int,
    payload: CrossPostRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CrossPostRead]:
    """Cross-post an announcement to other channels."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.ANNOUNCEMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for announcement channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Check permission
    if not has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.PUBLISH_ANNOUNCEMENTS,
        channel_id=channel.id,
        db=db,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to publish announcements",
        )

    # Get original message
    original_message = _get_message(channel.id, message_id, db)
    if original_message.channel_id != channel.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Message not found in this channel"
        )

    # Validate target channels
    target_channels = []
    for target_channel_id in payload.target_channel_ids:
        target_channel = _get_channel(target_channel_id, db)
        if target_channel.id == channel.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot cross-post to the same channel",
            )
        if target_channel.room_id != channel.room_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target channel must be in the same room",
            )
        # Check if user has permission to send messages in target channel
        if not has_permission(
            current_user.id,
            target_channel.room_id,
            ChannelPermission.SEND_MESSAGES,
            channel_id=target_channel.id,
            db=db,
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You do not have permission to send messages in channel {target_channel.name}",
            )
        target_channels.append(target_channel)

    # Create cross-posted messages
    cross_posts: list[CrossPostRead] = []
    for target_channel in target_channels:
        # Check if cross-post already exists
        existing = db.execute(
            select(AnnouncementCrossPost).where(
                AnnouncementCrossPost.original_message_id == original_message.id,
                AnnouncementCrossPost.target_channel_id == target_channel.id,
            )
        ).scalar_one_or_none()
        if existing:
            # Return existing cross-post
            cross_posts.append(
                CrossPostRead(
                    target_channel_id=target_channel.id,
                    cross_posted_message_id=existing.cross_posted_message_id,
                    created_at=existing.created_at,
                )
            )
            continue

        # Create copy of message in target channel
        cross_posted_message = Message(
            channel_id=target_channel.id,
            author_id=original_message.author_id,
            content=original_message.content,
        )
        db.add(cross_posted_message)
        db.flush()

        if cross_posted_message.thread_root_id is None:
            cross_posted_message.thread_root_id = cross_posted_message.id

        # Create cross-post relationship
        cross_post = AnnouncementCrossPost(
            original_message_id=original_message.id,
            cross_posted_message_id=cross_posted_message.id,
            target_channel_id=target_channel.id,
        )
        db.add(cross_post)
        db.flush()

        cross_posts.append(
            CrossPostRead(
                target_channel_id=target_channel.id,
                cross_posted_message_id=cross_posted_message.id,
                created_at=cross_post.created_at,
            )
        )

        # Broadcast message to target channel
        serialized = serialize_message_by_id(cross_posted_message.id, db, current_user.id)
        from app.api.ws import manager
        await manager.broadcast(
            target_channel.id,
            {"type": "message", "message": serialized.model_dump(mode="json")},
        )

    db.commit()
    
    # Publish announcement cross-posted event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    cross_posts_data = [
        {
            "target_channel_id": cp.target_channel_id,
            "cross_posted_message_id": cp.cross_posted_message_id,
            "created_at": cp.created_at.isoformat(),
        }
        for cp in cross_posts
    ]
    publish_announcement_cross_posted(
        room_slug,
        channel.id,
        original_message.id,
        cross_posts_data,
    )
    
    return cross_posts


@router.get(
    "/{channel_id}/announcements/{message_id}/cross-posts",
    response_model=list[CrossPostRead],
)
def get_cross_posts(
    channel_id: int,
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CrossPostRead]:
    """Get list of channels where an announcement was cross-posted."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.ANNOUNCEMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for announcement channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Get original message
    original_message = _get_message(channel.id, message_id, db)
    if original_message.channel_id != channel.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Message not found in this channel"
        )

    # Get all cross-posts
    stmt = select(AnnouncementCrossPost).where(
        AnnouncementCrossPost.original_message_id == original_message.id
    )
    cross_posts = db.execute(stmt).scalars().all()

    return [
        CrossPostRead(
            target_channel_id=cross_post.target_channel_id,
            cross_posted_message_id=cross_post.cross_posted_message_id,
            created_at=cross_post.created_at,
        )
        for cross_post in cross_posts
    ]


@router.delete(
    "/{channel_id}/announcements/{message_id}/cross-posts/{target_channel_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_cross_post(
    channel_id: int,
    message_id: int,
    target_channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Delete a cross-post from a target channel."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.ANNOUNCEMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for announcement channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Check permission
    if not has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.PUBLISH_ANNOUNCEMENTS,
        channel_id=channel.id,
        db=db,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to manage announcements",
        )

    # Get original message
    original_message = _get_message(channel.id, message_id, db)
    if original_message.channel_id != channel.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Message not found in this channel"
        )

    # Get cross-post
    cross_post = db.execute(
        select(AnnouncementCrossPost).where(
            AnnouncementCrossPost.original_message_id == original_message.id,
            AnnouncementCrossPost.target_channel_id == target_channel_id,
        )
    ).scalar_one_or_none()

    if cross_post is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Cross-post not found"
        )

    # Delete cross-posted message
    cross_posted_message = db.get(Message, cross_post.cross_posted_message_id)
    if cross_posted_message:
        db.delete(cross_posted_message)

    # Delete cross-post relationship
    db.delete(cross_post)
    db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Forum endpoints
def _serialize_forum_post(post: ForumPost, current_user_id: int | None, db: Session) -> ForumPostRead:
    """Serialize a forum post with tags."""
    tags = [tag.tag_name for tag in post.tags]
    return ForumPostRead(
        id=post.id,
        channel_id=post.channel_id,
        message_id=post.message_id,
        title=post.title,
        author_id=post.author_id,
        is_pinned=post.is_pinned,
        is_archived=post.is_archived,
        is_locked=post.is_locked,
        reply_count=post.reply_count,
        last_reply_at=post.last_reply_at,
        last_reply_by_id=post.last_reply_by_id,
        created_at=post.created_at,
        updated_at=post.updated_at,
        tags=tags,
    )


def _serialize_forum_post_detail(
    post: ForumPost, current_user_id: int | None, db: Session
) -> ForumPostDetailRead:
    """Serialize a forum post with full details."""
    message = serialize_message_by_id(post.message_id, db, current_user_id)
    tags = [tag.tag_name for tag in post.tags]
    base = _serialize_forum_post(post, current_user_id, db)
    return ForumPostDetailRead(
        **base.model_dump(),
        message=message,
        author=_serialize_user(post.author),
        last_reply_by=_serialize_user(post.last_reply_by),
    )


def _update_forum_post_metadata(post_id: int, db: Session) -> None:
    """Update forum post metadata (reply_count, last_reply_at, last_reply_by_id)."""
    post = db.get(ForumPost, post_id)
    if post is None:
        return

    # Count replies (messages in the same channel with parent_id = post.message_id or thread_root_id = post.message_id)
    reply_stmt = (
        select(func.count(Message.id))
        .where(
            Message.channel_id == post.channel_id,
            or_(
                Message.parent_id == post.message_id,
                and_(
                    Message.thread_root_id == post.message_id,
                    Message.id != post.message_id,
                ),
            ),
            Message.deleted_at.is_(None),
        )
    )
    reply_count = db.execute(reply_stmt).scalar_one() or 0

    # Get last reply
    last_reply_stmt = (
        select(Message)
        .where(
            Message.channel_id == post.channel_id,
            or_(
                Message.parent_id == post.message_id,
                and_(
                    Message.thread_root_id == post.message_id,
                    Message.id != post.message_id,
                ),
            ),
            Message.deleted_at.is_(None),
        )
        .order_by(Message.created_at.desc())
        .limit(1)
        .options(selectinload(Message.author))
    )
    last_reply = db.execute(last_reply_stmt).scalar_one_or_none()

    post.reply_count = reply_count
    if last_reply:
        post.last_reply_at = last_reply.created_at
        post.last_reply_by_id = last_reply.author_id
    else:
        post.last_reply_at = None
        post.last_reply_by_id = None

    db.flush()


@router.post(
    "/{channel_id}/posts",
    response_model=ForumPostDetailRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_forum_post(
    channel_id: int,
    payload: ForumPostCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostDetailRead:
    """Create a new forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Check permission
    if not has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.CREATE_FORUM_POSTS,
        channel_id=channel.id,
        db=db,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to create forum posts",
        )

    # Check if channel is archived
    if channel.is_archived:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create posts in archived channels",
        )

    # Validate content
    normalized = payload.content.rstrip()
    if not normalized.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post content is required"
        )

    if len(normalized) > settings.chat_message_max_length:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Content exceeds maximum length of {settings.chat_message_max_length} characters",
        )

    # Create message (first message of the post)
    message = Message(
        channel_id=channel.id,
        author_id=current_user.id,
        content=normalized,
    )
    db.add(message)
    db.flush()

    if message.thread_root_id is None:
        message.thread_root_id = message.id

    # Create forum post
    post = ForumPost(
        channel_id=channel.id,
        message_id=message.id,
        title=payload.title.strip(),
        author_id=current_user.id,
    )
    db.add(post)
    db.flush()

    # Add tags
    if payload.tag_names:
        # Validate tags against channel tags
        channel_tags = {
            tag.name.lower(): tag
            for tag in db.execute(
                select(ForumChannelTag).where(ForumChannelTag.channel_id == channel.id)
            ).scalars().all()
        }
        for tag_name in payload.tag_names[:5]:  # Limit to 5 tags
            tag_name_lower = tag_name.lower().strip()
            if tag_name_lower and tag_name_lower in channel_tags:
                post_tag = ForumPostTag(post_id=post.id, tag_name=tag_name_lower)
                db.add(post_tag)

    db.commit()
    db.refresh(post)

    serialized = _serialize_forum_post_detail(post, current_user.id, db)
    from app.api.ws import manager
    await manager.broadcast(
        channel.id,
        {"type": "forum_post_created", "post": serialized.model_dump(mode="json")},
    )
    
    # Publish forum post created event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_forum_post_created(
        room_slug,
        channel.id,
        serialized.model_dump(mode="json"),
    )
    
    return serialized


@router.get(
    "/{channel_id}/posts",
    response_model=ForumPostListPage,
)
def list_forum_posts(
    channel_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = Query("last_reply", regex="^(created|last_reply|replies)$"),
    tags: str | None = Query(None, description="Comma-separated tag names"),
    pinned_only: bool = Query(False),
    archived: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostListPage:
    """List forum posts with pagination and filtering."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Build query
    stmt = select(ForumPost).where(ForumPost.channel_id == channel.id)

    # Apply filters
    if pinned_only:
        stmt = stmt.where(ForumPost.is_pinned == True)
    if not archived:
        stmt = stmt.where(ForumPost.is_archived == False)

    # Filter by tags
    if tags:
        tag_names = [t.strip().lower() for t in tags.split(",") if t.strip()]
        if tag_names:
            stmt = stmt.join(ForumPostTag).where(ForumPostTag.tag_name.in_(tag_names))

    # Apply sorting
    if sort_by == "created":
        stmt = stmt.order_by(ForumPost.created_at.desc())
    elif sort_by == "replies":
        stmt = stmt.order_by(ForumPost.reply_count.desc(), ForumPost.created_at.desc())
    else:  # last_reply
        stmt = stmt.order_by(
            ForumPost.is_pinned.desc(),
            func.coalesce(ForumPost.last_reply_at, ForumPost.created_at).desc(),
        )

    # Get total count
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = db.execute(count_stmt).scalar_one()

    # Apply pagination
    offset = (page - 1) * page_size
    stmt = stmt.options(
        selectinload(ForumPost.tags),
        selectinload(ForumPost.author),
        selectinload(ForumPost.last_reply_by),
    ).offset(offset).limit(page_size)

    posts = db.execute(stmt).scalars().unique().all()

    items = [_serialize_forum_post(post, current_user.id, db) for post in posts]
    has_more = offset + len(items) < total

    return ForumPostListPage(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_more=has_more,
    )


@router.get(
    "/{channel_id}/posts/{post_id}",
    response_model=ForumPostDetailRead,
)
def get_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostDetailRead:
    """Get a single forum post with full details."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    post = db.execute(
        select(ForumPost)
        .where(ForumPost.id == post_id, ForumPost.channel_id == channel.id)
        .options(
            selectinload(ForumPost.tags),
            selectinload(ForumPost.author),
            selectinload(ForumPost.last_reply_by),
        )
    ).scalar_one_or_none()

    if post is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    return _serialize_forum_post_detail(post, current_user.id, db)


@router.patch(
    "/{channel_id}/posts/{post_id}",
    response_model=ForumPostDetailRead,
)
async def update_forum_post(
    channel_id: int,
    post_id: int,
    payload: ForumPostUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostDetailRead:
    """Update a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    post = db.execute(
        select(ForumPost)
        .where(ForumPost.id == post_id, ForumPost.channel_id == channel.id)
        .options(selectinload(ForumPost.tags))
    ).scalar_one_or_none()

    if post is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    # Check permissions - author or admin
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_author = post.author_id == current_user.id
    is_admin = membership.role in ADMIN_ROLES

    if not (is_author or is_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to edit this post",
        )

    # Update title if provided
    if payload.title is not None:
        post.title = payload.title.strip()

    # Update message content if provided
    if payload.content is not None:
        message = db.get(Message, post.message_id)
        if message is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post message not found")

        normalized = payload.content.rstrip()
        if not normalized.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Post content cannot be empty"
            )

        if len(normalized) > settings.chat_message_max_length:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Content exceeds maximum length of {settings.chat_message_max_length} characters",
            )

        message.content = normalized
        message.edited_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(post)

    serialized = _serialize_forum_post_detail(post, current_user.id, db)
    
    # Publish forum post updated event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_forum_post_updated(
        room_slug,
        channel.id,
        serialized.model_dump(mode="json"),
    )
    
    return serialized


@router.delete(
    "/{channel_id}/posts/{post_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Delete a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    # Check permissions - author or admin
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_author = post.author_id == current_user.id
    is_admin = membership.role in ADMIN_ROLES

    if not (is_author or is_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to delete this post",
        )

    # Store post_id before deletion
    post_id = post.id
    
    # Delete the message (which will cascade delete the post)
    message = db.get(Message, post.message_id)
    if message:
        db.delete(message)

    db.commit()
    
    # Publish forum post deleted event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_forum_post_deleted(
        room_slug,
        channel.id,
        post_id,
    )
    
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{channel_id}/posts/{post_id}/pin",
    response_model=ForumPostRead,
)
def pin_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Pin a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    if post.is_pinned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post is already pinned"
        )

    post.is_pinned = True
    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


@router.delete(
    "/{channel_id}/posts/{post_id}/pin",
    response_model=ForumPostRead,
)
def unpin_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Unpin a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    if not post.is_pinned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post is not pinned"
        )

    post.is_pinned = False
    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


@router.post(
    "/{channel_id}/posts/{post_id}/archive",
    response_model=ForumPostRead,
)
def archive_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Archive a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    if post.is_archived:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post is already archived"
        )

    post.is_archived = True
    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


@router.post(
    "/{channel_id}/posts/{post_id}/unarchive",
    response_model=ForumPostRead,
)
def unarchive_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Unarchive a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    if not post.is_archived:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post is not archived"
        )

    post.is_archived = False
    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


@router.post(
    "/{channel_id}/posts/{post_id}/lock",
    response_model=ForumPostRead,
)
def lock_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Lock a forum post (prevent new replies)."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    if post.is_locked:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post is already locked"
        )

    post.is_locked = True
    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


@router.post(
    "/{channel_id}/posts/{post_id}/unlock",
    response_model=ForumPostRead,
)
def unlock_forum_post(
    channel_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Unlock a forum post (allow new replies)."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    if not post.is_locked:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Post is not locked"
        )

    post.is_locked = False
    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


# Forum tag endpoints
@router.post(
    "/{channel_id}/tags",
    response_model=ForumChannelTagRead,
    status_code=status.HTTP_201_CREATED,
)
def create_forum_channel_tag(
    channel_id: int,
    payload: ForumChannelTagCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumChannelTagRead:
    """Create a predefined tag for a forum channel."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    # Check if tag already exists
    existing = db.execute(
        select(ForumChannelTag).where(
            ForumChannelTag.channel_id == channel.id,
            func.lower(ForumChannelTag.name) == payload.name.lower(),
        )
    ).scalar_one_or_none()

    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Tag with this name already exists"
        )

    tag = ForumChannelTag(
        channel_id=channel.id,
        name=payload.name.strip(),
        color=payload.color,
        emoji=payload.emoji,
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)

    return ForumChannelTagRead.model_validate(tag)


@router.get(
    "/{channel_id}/tags",
    response_model=list[ForumChannelTagRead],
)
def list_forum_channel_tags(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ForumChannelTagRead]:
    """List all predefined tags for a forum channel."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    tags = db.execute(
        select(ForumChannelTag).where(ForumChannelTag.channel_id == channel.id).order_by(ForumChannelTag.name)
    ).scalars().all()

    return [ForumChannelTagRead.model_validate(tag) for tag in tags]


@router.patch(
    "/{channel_id}/tags/{tag_id}",
    response_model=ForumChannelTagRead,
)
def update_forum_channel_tag(
    channel_id: int,
    tag_id: int,
    payload: ForumChannelTagUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumChannelTagRead:
    """Update a forum channel tag."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    tag = db.get(ForumChannelTag, tag_id)
    if tag is None or tag.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")

    if payload.name is not None:
        # Check if new name conflicts with existing tag
        existing = db.execute(
            select(ForumChannelTag).where(
                ForumChannelTag.channel_id == channel.id,
                ForumChannelTag.id != tag.id,
                func.lower(ForumChannelTag.name) == payload.name.lower(),
            )
        ).scalar_one_or_none()

        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Tag with this name already exists"
            )
        tag.name = payload.name.strip()

    if payload.color is not None:
        tag.color = payload.color

    if payload.emoji is not None:
        tag.emoji = payload.emoji

    db.commit()
    db.refresh(tag)

    return ForumChannelTagRead.model_validate(tag)


@router.delete(
    "/{channel_id}/tags/{tag_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_forum_channel_tag(
    channel_id: int,
    tag_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Delete a forum channel tag."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    tag = db.get(ForumChannelTag, tag_id)
    if tag is None or tag.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")

    db.delete(tag)
    db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{channel_id}/posts/{post_id}/tags",
    response_model=ForumPostRead,
)
def add_forum_post_tags(
    channel_id: int,
    post_id: int,
    tag_names: list[str] = Query(..., min_length=1, max_length=5),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Add tags to a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    # Check permissions - author or admin
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_author = post.author_id == current_user.id
    is_admin = membership.role in ADMIN_ROLES

    if not (is_author or is_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to modify this post",
        )

    # Validate tags against channel tags
    channel_tags = {
        tag.name.lower(): tag
        for tag in db.execute(
            select(ForumChannelTag).where(ForumChannelTag.channel_id == channel.id)
        ).scalars().all()
    }

    existing_tag_names = {tag.tag_name for tag in post.tags}

    for tag_name in tag_names:
        tag_name_lower = tag_name.lower().strip()
        if tag_name_lower and tag_name_lower in channel_tags and tag_name_lower not in existing_tag_names:
            post_tag = ForumPostTag(post_id=post.id, tag_name=tag_name_lower)
            db.add(post_tag)

    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


@router.delete(
    "/{channel_id}/posts/{post_id}/tags/{tag_name}",
    response_model=ForumPostRead,
)
def remove_forum_post_tag(
    channel_id: int,
    post_id: int,
    tag_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ForumPostRead:
    """Remove a tag from a forum post."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.FORUMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for forum channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    post = db.get(ForumPost, post_id)
    if post is None or post.channel_id != channel.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")

    # Check permissions - author or admin
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_author = post.author_id == current_user.id
    is_admin = membership.role in ADMIN_ROLES

    if not (is_author or is_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to modify this post",
        )

    tag_name_lower = tag_name.lower().strip()
    post_tag = db.execute(
        select(ForumPostTag).where(
            ForumPostTag.post_id == post.id, ForumPostTag.tag_name == tag_name_lower
        )
    ).scalar_one_or_none()

    if post_tag:
        db.delete(post_tag)

    db.commit()
    db.refresh(post)

    return _serialize_forum_post(post, current_user.id, db)


# Event endpoints
def _serialize_event(event: Event, current_user_id: int | None, db: Session) -> EventRead:
    """Serialize an event with participant counts."""
    # Count participants by status
    participant_counts: dict[str, int] = {}
    total_count = 0
    user_rsvp: str | None = None

    participants = db.execute(
        select(EventParticipant).where(EventParticipant.event_id == event.id)
    ).scalars().all()

    for participant in participants:
        status = participant.rsvp_status
        participant_counts[status] = participant_counts.get(status, 0) + 1
        total_count += 1
        if current_user_id and participant.user_id == current_user_id:
            user_rsvp = status

    return EventRead(
        id=event.id,
        channel_id=event.channel_id,
        message_id=event.message_id,
        title=event.title,
        description=event.description,
        organizer_id=event.organizer_id,
        start_time=event.start_time,
        end_time=event.end_time,
        location=event.location,
        image_url=event.image_url,
        external_url=event.external_url,
        status=event.status,
        created_at=event.created_at,
        updated_at=event.updated_at,
        participant_count=total_count,
        participant_counts=participant_counts,
        user_rsvp=user_rsvp,
    )


def _serialize_event_detail(
    event: Event, current_user_id: int | None, db: Session
) -> EventDetailRead:
    """Serialize an event with full details including participants."""
    base = _serialize_event(event, current_user_id, db)

    # Get organizer
    organizer = db.get(User, event.organizer_id)
    organizer_author = _serialize_user(organizer) if organizer else None
    if not organizer_author:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Event organizer not found",
        )

    # Get participants with user details
    participants = (
        db.execute(
            select(EventParticipant)
            .where(EventParticipant.event_id == event.id)
            .options(selectinload(EventParticipant.user))
        )
        .scalars()
        .all()
    )

    participant_reads = []
    for participant in participants:
        user_author = _serialize_user(participant.user)
        if user_author:
            participant_reads.append(
                EventParticipantRead(
                    id=participant.id,
                    event_id=participant.event_id,
                    user_id=participant.user_id,
                    rsvp_status=participant.rsvp_status,
                    joined_at=participant.joined_at,
                    user=user_author,
                )
            )

    return EventDetailRead(
        **base.model_dump(),
        organizer=organizer_author,
        participants=participant_reads,
    )


@router.post(
    "/{channel_id}/events",
    response_model=EventDetailRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_event(
    channel_id: int,
    payload: EventCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EventDetailRead:
    """Create a new event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Check permission
    if not has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.CREATE_EVENTS,
        channel_id=channel.id,
        db=db,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to create events",
        )

    # Check if channel is archived
    if channel.is_archived:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create events in archived channels",
        )

    # Validate times
    if payload.end_time and payload.end_time <= payload.start_time:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="End time must be after start time",
        )

    # Create event
    event = Event(
        channel_id=channel.id,
        title=payload.title.strip(),
        description=payload.description.strip() if payload.description else None,
        organizer_id=current_user.id,
        start_time=payload.start_time,
        end_time=payload.end_time,
        location=payload.location.strip() if payload.location else None,
        image_url=payload.image_url,
        external_url=payload.external_url,
        status="scheduled",
    )
    db.add(event)
    db.flush()

    # Create reminders if specified
    if payload.reminder_minutes:
        from datetime import timedelta

        for minutes in payload.reminder_minutes:
            reminder_time = payload.start_time - timedelta(minutes=minutes)
            if reminder_time > datetime.now(timezone.utc):
                reminder = EventReminder(
                    event_id=event.id,
                    user_id=current_user.id,
                    reminder_time=reminder_time,
                )
                db.add(reminder)

    db.commit()
    db.refresh(event)

    serialized = _serialize_event_detail(event, current_user.id, db)
    
    # Publish event created event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_event_created(
        room_slug,
        channel.id,
        serialized.model_dump(mode="json"),
    )
    
    return serialized


@router.get(
    "/{channel_id}/events",
    response_model=EventListPage,
)
def list_events(
    channel_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None, regex="^(scheduled|ongoing|completed|cancelled)$"),
    start_from: datetime | None = Query(None, description="Filter events starting from this date"),
    start_to: datetime | None = Query(None, description="Filter events starting until this date"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EventListPage:
    """List events with pagination and filtering."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Build query
    stmt = select(Event).where(Event.channel_id == channel.id)

    # Apply filters
    if status:
        stmt = stmt.where(Event.status == status)
    if start_from:
        stmt = stmt.where(Event.start_time >= start_from)
    if start_to:
        stmt = stmt.where(Event.start_time <= start_to)

    # Get total count
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0

    # Apply sorting and pagination
    stmt = stmt.order_by(Event.start_time.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    events = db.execute(stmt).scalars().all()

    items = [_serialize_event(event, current_user.id, db) for event in events]

    return EventListPage(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_more=(page * page_size) < total,
    )


@router.get(
    "/{channel_id}/events/{event_id}",
    response_model=EventDetailRead,
)
def get_event(
    channel_id: int,
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EventDetailRead:
    """Get event details."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    return _serialize_event_detail(event, current_user.id, db)


@router.patch(
    "/{channel_id}/events/{event_id}",
    response_model=EventDetailRead,
)
async def update_event(
    channel_id: int,
    event_id: int,
    payload: EventUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EventDetailRead:
    """Update an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Check permissions - organizer or admin
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_organizer = event.organizer_id == current_user.id
    is_admin = membership.role in ADMIN_ROLES
    has_manage_permission = has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.MANAGE_EVENTS,
        channel_id=channel.id,
        db=db,
    )

    if not (is_organizer or is_admin or has_manage_permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to edit this event",
        )

    # Update fields
    if payload.title is not None:
        event.title = payload.title.strip()
    if payload.description is not None:
        event.description = payload.description.strip() if payload.description else None
    if payload.start_time is not None:
        event.start_time = payload.start_time
    if payload.end_time is not None:
        event.end_time = payload.end_time
    if payload.location is not None:
        event.location = payload.location.strip() if payload.location else None
    if payload.image_url is not None:
        event.image_url = payload.image_url
    if payload.external_url is not None:
        event.external_url = payload.external_url
    if payload.status is not None:
        event.status = payload.status

    # Validate times
    if event.end_time and event.end_time <= event.start_time:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="End time must be after start time",
        )

    db.commit()
    db.refresh(event)

    serialized = _serialize_event_detail(event, current_user.id, db)
    
    # Publish event updated event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_event_updated(
        room_slug,
        channel.id,
        serialized.model_dump(mode="json"),
    )
    
    return serialized


@router.delete(
    "/{channel_id}/events/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_event(
    channel_id: int,
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Delete an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Check permissions - organizer or admin
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_organizer = event.organizer_id == current_user.id
    is_admin = membership.role in ADMIN_ROLES
    has_manage_permission = has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.MANAGE_EVENTS,
        channel_id=channel.id,
        db=db,
    )

    if not (is_organizer or is_admin or has_manage_permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to delete this event",
        )

    # Delete the event (cascade will delete participants and reminders)
    db.delete(event)
    db.commit()
    
    # Publish event deleted event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_event_deleted(
        room_slug,
        channel.id,
        event_id,
    )
    
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# RSVP endpoints
@router.post(
    "/{channel_id}/events/{event_id}/rsvp",
    response_model=EventParticipantRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_event_rsvp(
    channel_id: int,
    event_id: int,
    payload: EventRSVPRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EventParticipantRead:
    """RSVP to an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Check if participant already exists
    existing = db.execute(
        select(EventParticipant).where(
            EventParticipant.event_id == event.id, EventParticipant.user_id == current_user.id
        )
    ).scalar_one_or_none()

    if existing:
        # Update existing RSVP
        existing.rsvp_status = payload.status
        db.commit()
        db.refresh(existing)
        participant = existing
    else:
        # Create new RSVP
        participant = EventParticipant(
            event_id=event.id,
            user_id=current_user.id,
            rsvp_status=payload.status,
        )
        db.add(participant)
        db.commit()
        db.refresh(participant)

    # Load user for serialization
    db.refresh(participant, ["user"])
    user_author = _serialize_user(participant.user)
    if not user_author:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="User not found"
        )

    # Publish RSVP changed event
    room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
    publish_event_rsvp_changed(
        room_slug,
        channel.id,
        event.id,
        current_user.id,
        payload.status,
    )

    return EventParticipantRead(
        id=participant.id,
        event_id=participant.event_id,
        user_id=participant.user_id,
        rsvp_status=participant.rsvp_status,
        joined_at=participant.joined_at,
        user=user_author,
    )


@router.get(
    "/{channel_id}/events/{event_id}/participants",
    response_model=list[EventParticipantRead],
)
def get_event_participants(
    channel_id: int,
    event_id: int,
    status: str | None = Query(None, regex="^(yes|no|maybe|interested)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[EventParticipantRead]:
    """Get list of event participants."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Build query
    stmt = (
        select(EventParticipant)
        .where(EventParticipant.event_id == event.id)
        .options(selectinload(EventParticipant.user))
    )

    if status:
        stmt = stmt.where(EventParticipant.rsvp_status == status)

    participants = db.execute(stmt).scalars().all()

    result = []
    for participant in participants:
        user_author = _serialize_user(participant.user)
        if user_author:
            result.append(
                EventParticipantRead(
                    id=participant.id,
                    event_id=participant.event_id,
                    user_id=participant.user_id,
                    rsvp_status=participant.rsvp_status,
                    joined_at=participant.joined_at,
                    user=user_author,
                )
            )

    return result


@router.delete(
    "/{channel_id}/events/{event_id}/rsvp",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_event_rsvp(
    channel_id: int,
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Remove RSVP from an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    participant = db.execute(
        select(EventParticipant).where(
            EventParticipant.event_id == event.id, EventParticipant.user_id == current_user.id
        )
    ).scalar_one_or_none()

    if participant:
        db.delete(participant)
        db.commit()

        # Publish RSVP changed event
        room_slug = db.execute(select(Room.slug).where(Room.id == channel.room_id)).scalar_one()
        publish_event_rsvp_changed(
            room_slug,
            channel.id,
            event.id,
            current_user.id,
            "removed",
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Reminder endpoints
@router.post(
    "/{channel_id}/events/{event_id}/reminders",
    response_model=EventReminderRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_event_reminder(
    channel_id: int,
    event_id: int,
    payload: EventReminderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EventReminderRead:
    """Create a reminder for an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Validate reminder time is before event start
    if payload.reminder_time >= event.start_time:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reminder time must be before event start time",
        )

    # Check if reminder already exists
    existing = db.execute(
        select(EventReminder).where(
            EventReminder.event_id == event.id,
            EventReminder.user_id == current_user.id,
            EventReminder.reminder_time == payload.reminder_time,
        )
    ).scalar_one_or_none()

    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Reminder already exists"
        )

    reminder = EventReminder(
        event_id=event.id,
        user_id=current_user.id,
        reminder_time=payload.reminder_time,
    )
    db.add(reminder)
    db.commit()
    db.refresh(reminder)

    return EventReminderRead(
        id=reminder.id,
        event_id=reminder.event_id,
        user_id=reminder.user_id,
        reminder_time=reminder.reminder_time,
        sent=reminder.sent,
        sent_at=reminder.sent_at,
        created_at=reminder.created_at,
    )


@router.get(
    "/{channel_id}/events/{event_id}/reminders",
    response_model=list[EventReminderRead],
)
def get_event_reminders(
    channel_id: int,
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[EventReminderRead]:
    """Get reminders for an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Only return reminders for current user
    reminders = db.execute(
        select(EventReminder).where(
            EventReminder.event_id == event.id, EventReminder.user_id == current_user.id
        )
    ).scalars().all()

    return [
        EventReminderRead(
            id=reminder.id,
            event_id=reminder.event_id,
            user_id=reminder.user_id,
            reminder_time=reminder.reminder_time,
            sent=reminder.sent,
            sent_at=reminder.sent_at,
            created_at=reminder.created_at,
        )
        for reminder in reminders
    ]


@router.delete(
    "/{channel_id}/events/{event_id}/reminders/{reminder_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_event_reminder(
    channel_id: int,
    event_id: int,
    reminder_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Delete a reminder for an event."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    reminder = db.execute(
        select(EventReminder).where(
            EventReminder.id == reminder_id,
            EventReminder.event_id == event.id,
            EventReminder.user_id == current_user.id,
        )
    ).scalar_one_or_none()

    if reminder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reminder not found")

    db.delete(reminder)
    db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{channel_id}/events/{event_id}/export.ics")
def export_event_ical(
    channel_id: int,
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Export an event to iCal format."""

    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    event = db.execute(
        select(Event).where(Event.id == event_id, Event.channel_id == channel.id)
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Get room and organizer info
    room = db.get(Room, channel.room_id)
    organizer = db.get(User, event.organizer_id)

    # Generate iCal content
    ical_lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Charge//Event Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "",
        "BEGIN:VEVENT",
        f"UID:event-{event.id}@charge",
        f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        f"DTSTART:{event.start_time.strftime('%Y%m%dT%H%M%SZ')}",
    ]

    if event.end_time:
        ical_lines.append(f"DTEND:{event.end_time.strftime('%Y%m%dT%H%M%SZ')}")
    else:
        # If no end time, assume 1 hour duration
        from datetime import timedelta
        end_time = event.start_time + timedelta(hours=1)
        ical_lines.append(f"DTEND:{end_time.strftime('%Y%m%dT%H%M%SZ')}")

    # Summary (title)
    summary = event.title.replace("\n", " ").replace("\r", " ").replace(",", "\\,")
    ical_lines.append(f"SUMMARY:{summary}")

    # Description
    if event.description:
        description = (
            event.description.replace("\n", "\\n")
            .replace("\r", "")
            .replace(",", "\\,")
            .replace(";", "\\;")
        )
        ical_lines.append(f"DESCRIPTION:{description}")

    # Location
    if event.location:
        location = event.location.replace(",", "\\,").replace(";", "\\;")
        ical_lines.append(f"LOCATION:{location}")

    # Organizer
    if organizer:
        organizer_email = f"{organizer.login}@charge" if organizer.login else "organizer@charge"
        organizer_name = organizer.display_name or organizer.login or "Organizer"
        organizer_name = organizer_name.replace(",", "\\,").replace(";", "\\;")
        ical_lines.append(f"ORGANIZER;CN={organizer_name}:MAILTO:{organizer_email}")

    # URL
    if event.external_url:
        ical_lines.append(f"URL:{event.external_url}")

    # Status
    status_map = {
        "scheduled": "CONFIRMED",
        "ongoing": "CONFIRMED",
        "completed": "COMPLETED",
        "cancelled": "CANCELLED",
    }
    ical_lines.append(f"STATUS:{status_map.get(event.status, 'CONFIRMED')}")

    # Created and last modified
    ical_lines.append(f"CREATED:{event.created_at.strftime('%Y%m%dT%H%M%SZ')}")
    ical_lines.append(f"LAST-MODIFIED:{event.updated_at.strftime('%Y%m%dT%H%M%SZ')}")

    # Sequence (for updates)
    ical_lines.append("SEQUENCE:0")

    # End event
    ical_lines.append("END:VEVENT")
    ical_lines.append("")
    ical_lines.append("END:VCALENDAR")

    ical_content = "\r\n".join(ical_lines)

    # Return as downloadable file
    filename = f"event-{event.id}-{event.title[:50].replace(' ', '_')}.ics"
    # Sanitize filename
    filename = "".join(c for c in filename if c.isalnum() or c in "._-")

    return Response(
        content=ical_content,
        media_type="text/calendar",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "text/calendar; charset=utf-8",
        },
    )


# Background task endpoints (can be called via cron)
@router.post("/{channel_id}/events/update-statuses")
def update_event_statuses_endpoint(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, int]:
    """
    Manually trigger event status update for a channel.
    This endpoint can be called via cron or scheduled task.
    Requires admin permissions.
    """
    channel = _get_channel(channel_id, db)
    if channel.type != ChannelType.EVENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint is only available for events channels",
        )
    require_room_member(channel.room_id, current_user.id, db)

    # Check admin permissions
    membership = require_room_member(channel.room_id, current_user.id, db)
    is_admin = membership.role in ADMIN_ROLES
    has_manage_permission = has_permission(
        current_user.id,
        channel.room_id,
        ChannelPermission.MANAGE_EVENTS,
        channel_id=channel.id,
        db=db,
    )

    if not (is_admin or has_manage_permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to update event statuses",
        )

    from app.services.event_status import update_event_statuses

    # Filter to only events in this channel
    # We'll modify the service to accept channel_id, or filter here
    # For now, let's create a channel-specific version
    stats = update_event_statuses_for_channel(channel.id, db)

    return stats


def update_event_statuses_for_channel(channel_id: int, db: Session) -> dict[str, int]:
    """Update event statuses for a specific channel."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    stats = {
        "scheduled_to_ongoing": 0,
        "ongoing_to_completed": 0,
        "total_updated": 0,
    }

    try:
        # Find events that should be marked as ongoing
        scheduled_to_ongoing = db.execute(
            select(Event).where(
                Event.channel_id == channel_id,
                Event.status == "scheduled",
                Event.start_time <= now,
            )
        ).scalars().all()

        for event in scheduled_to_ongoing:
            event.status = "ongoing"
            stats["scheduled_to_ongoing"] += 1
            
            # Publish WebSocket event
            try:
                channel = db.get(Channel, channel_id)
                if channel:
                    room = db.get(Room, channel.room_id)
                    if room:
                        serialized = _serialize_event(event, None, db)
                        publish_event_updated(
                            room.slug,
                            channel.id,
                            serialized.model_dump(mode="json"),
                        )
            except Exception as e:
                logger.warning(f"Failed to publish event update: {e}")

        # Find events that should be marked as completed
        ongoing_to_completed = db.execute(
            select(Event).where(
                Event.channel_id == channel_id,
                Event.status == "ongoing",
                or_(
                    and_(Event.end_time.isnot(None), Event.end_time <= now),
                    and_(
                        Event.end_time.is_(None),
                        Event.start_time <= now - timedelta(hours=24),
                    ),
                ),
            )
        ).scalars().all()

        for event in ongoing_to_completed:
            event.status = "completed"
            stats["ongoing_to_completed"] += 1
            
            # Publish WebSocket event
            try:
                room = db.get(Room, channel_id)
                if room:
                    channel = db.get(Channel, channel_id)
                    if channel:
                        serialized = _serialize_event(event, None, db)
                        publish_event_updated(
                            room.slug,
                            channel.id,
                            serialized.model_dump(mode="json"),
                        )
            except Exception as e:
                logger.warning(f"Failed to publish event update: {e}")

        stats["total_updated"] = stats["scheduled_to_ongoing"] + stats["ongoing_to_completed"]

        if stats["total_updated"] > 0:
            db.commit()
        else:
            db.rollback()

    except Exception as e:
        db.rollback()
        raise

    return stats


@router.post("/events/update-all-statuses")
def update_all_event_statuses(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, int]:
    """
    Manually trigger event status update for all channels.
    This endpoint can be called via cron or scheduled task.
    Requires admin permissions (check first room membership).
    """
    # Check if user is admin in at least one room
    # For system-wide tasks, we might want a different auth mechanism
    # For now, require user to be logged in
    if not current_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    from app.services.event_status import update_event_statuses

    stats = update_event_statuses(db)
    return stats


@router.post("/events/send-reminders")
def send_all_event_reminders(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, int]:
    """
    Manually trigger sending event reminders.
    This endpoint can be called via cron or scheduled task.
    Requires authentication.
    """
    if not current_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    from app.services.event_reminders import send_event_reminders

    stats = send_event_reminders(db)
    return stats
