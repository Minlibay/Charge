"""Channel-specific API endpoints."""

from __future__ import annotations

import base64
from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal, Sequence

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

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
from app.api.ws import manager
from app.search import MessageSearchFilters, MessageSearchService
from app.services.permissions import has_permission
from app.services.workspace_events import publish_channel_updated

router = APIRouter(prefix="/channels", tags=["channels"])

ADMIN_ROLES: tuple[RoomRole, ...] = (RoomRole.OWNER, RoomRole.ADMIN)

settings = get_settings()

TEXT_CHANNEL_TYPES: set[ChannelType] = {
    ChannelType.TEXT,
    ChannelType.ANNOUNCEMENTS,
    ChannelType.FORUMS,
    ChannelType.EVENTS,
}
VOICE_CHANNEL_TYPES: set[ChannelType] = {ChannelType.VOICE, ChannelType.STAGE}
ALLOWED_CHANNEL_TYPES: set[ChannelType] = TEXT_CHANNEL_TYPES | VOICE_CHANNEL_TYPES

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
    await manager.broadcast(
        channel.id,
        {"type": "message", "message": serialized.model_dump(mode="json")},
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
        await manager.broadcast(
            target_channel.id,
            {"type": "message", "message": serialized.model_dump(mode="json")},
        )

    db.commit()
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
