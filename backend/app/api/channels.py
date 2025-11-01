"""Channel-specific API endpoints."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Sequence

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.deps import ensure_minimum_role, get_current_user, require_room_member
from app.config import get_settings
from app.core import build_download_url, resolve_path, store_upload
from app.database import get_db
from app.models import (
    Channel,
    ChannelCategory,
    ChannelRolePermissionOverwrite,
    ChannelType,
    ChannelUserPermissionOverwrite,
    Message,
    MessageAttachment,
    MessageReaction,
    MessageReceipt,
    Room,
    RoomRole,
    User,
    decode_permissions,
    encode_permissions,
)
from app.schemas import (
    ChannelRead,
    ChannelPermissionPayload,
    ChannelPermissionRoleRead,
    ChannelPermissionSummary,
    ChannelPermissionUserRead,
    ChannelUpdate,
    MessageAttachmentRead,
    MessageAuthor,
    MessageRead,
    MessageReactionSummary,
    MessageReceiptUpdate,
    ReactionRequest,
)
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
        parent_id: count
        for parent_id, count in db.execute(direct_stmt)
        if parent_id is not None
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
        preview_url = (
            download_url if (attachment.content_type or "").startswith("image/") else None
        )
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


def serialize_message_by_id(
    message_id: int, db: Session, current_user_id: int | None
) -> MessageRead:
    stmt = (
        select(Message)
        .where(Message.id == message_id)
        .options(*_MESSAGE_LOAD_OPTIONS)
    )
    message = db.execute(stmt).scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    return _serialize_messages([message], current_user_id, db)[0]


def fetch_channel_history(
    channel_id: int, limit: int, db: Session, *, current_user_id: int | None
) -> list[MessageRead]:
    stmt = (
        select(Message)
        .where(Message.channel_id == channel_id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit)
        .options(*_MESSAGE_LOAD_OPTIONS)
    )
    messages = list(db.execute(stmt).scalars())
    messages.reverse()
    return _serialize_messages(messages, current_user_id, db)


@router.get("/{channel_id}/history", response_model=list[MessageRead])
def get_channel_history(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    limit: int | None = Query(default=None, ge=1),
) -> list[MessageRead]:
    """Return the latest messages from a channel."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    effective_limit = limit or settings.chat_history_default_limit
    effective_limit = min(effective_limit, settings.chat_history_max_limit)

    return fetch_channel_history(channel_id, effective_limit, db, current_user_id=current_user.id)


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

    stmt = select(Message).where(Message.channel_id == channel.id)

    if query:
        stmt = stmt.where(Message.content.ilike(f"%{query}%"))
    if author_id is not None:
        stmt = stmt.where(Message.author_id == author_id)
    if has_attachments is True:
        stmt = stmt.where(Message.attachments.any())
    elif has_attachments is False:
        stmt = stmt.where(~Message.attachments.any())
    if start is not None:
        stmt = stmt.where(Message.created_at >= start)
    if end is not None:
        stmt = stmt.where(Message.created_at <= end)
    if thread_root_id is not None:
        stmt = stmt.where(or_(Message.id == thread_root_id, Message.thread_root_id == thread_root_id))

    stmt = (
        stmt.order_by(Message.created_at.desc(), Message.id.desc())
        .limit(effective_limit)
        .options(*_MESSAGE_LOAD_OPTIONS)
    )

    messages = list(db.execute(stmt).scalars())
    return _serialize_messages(messages, current_user.id, db)


@router.post("/{channel_id}/attachments", response_model=MessageAttachmentRead, status_code=status.HTTP_201_CREATED)
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not accessible")

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
def add_reaction(
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

    return serialize_message_by_id(message.id, db, current_user.id)


@router.delete("/{channel_id}/messages/{message_id}/reactions", response_model=MessageRead)
def remove_reaction(
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
            _serialize_user_overwrite(entry)
            for entry in user_overwrites
            if entry.user is not None
        ],
    )


@router.put(
    "/{channel_id}/permissions/roles/{role}", response_model=ChannelPermissionRoleRead
)
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


@router.put(
    "/{channel_id}/permissions/users/{user_id}", response_model=ChannelPermissionUserRead
)
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
