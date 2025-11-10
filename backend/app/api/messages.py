"""HTTP endpoints for managing chat messages."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable, Literal

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from pydantic import BaseModel

from app.api.channels import _ensure_text_channel, _get_channel, serialize_message_by_id
from app.api.deps import ensure_minimum_role, get_current_user, require_room_member
from app.api.ws import manager
from app.config import get_settings
from app.core import store_upload
from app.core.storage import StoredFile
from app.database import get_db
from app.models import Message, MessageAttachment, RoomRole, User
from app.schemas import MessageRead

router = APIRouter(prefix="/messages", tags=["messages"])

settings = get_settings()

ADMIN_ROLES: tuple[RoomRole, ...] = (RoomRole.OWNER, RoomRole.ADMIN)


def _cleanup_files(stored_files: Iterable[StoredFile]) -> None:
    for stored in stored_files:
        try:
            if stored.absolute_path.exists():
                stored.absolute_path.unlink()
        except OSError:
            continue


def _get_message(message_id: int, db: Session) -> Message:
    stmt = (
        select(Message)
        .where(Message.id == message_id)
        .options(
            selectinload(Message.attachments),
            selectinload(Message.reactions),
            selectinload(Message.receipts),
            selectinload(Message.author),
            selectinload(Message.moderated_by),
        )
    )
    message = db.execute(stmt).scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    return message


async def _create_attachments(
    channel_id: int,
    uploads: list[UploadFile],
    uploader_id: int,
    db: Session,
) -> list[MessageAttachment]:
    stored_files: list[StoredFile] = []
    attachments: list[MessageAttachment] = []
    try:
        for upload in uploads:
            stored = await store_upload(channel_id, upload)
            stored_files.append(stored)
            attachment = MessageAttachment(
                channel_id=channel_id,
                uploader_id=uploader_id,
                file_name=stored.file_name,
                content_type=stored.content_type,
                file_size=stored.file_size,
                storage_path=stored.relative_path,
            )
            db.add(attachment)
            attachments.append(attachment)
    except Exception:
        _cleanup_files(stored_files)
        raise
    return attachments


@router.post("", response_model=MessageRead, status_code=status.HTTP_201_CREATED)
async def create_message(
    *,
    channel_id: int = Form(...),
    content: str = Form(""),
    parent_id: int | None = Form(default=None),
    files: list[UploadFile] | UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Create a new message with optional file attachments."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    # Check if channel is archived
    if channel.is_archived:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot send messages to archived channels",
        )

    # Check slowmode
    if channel.slowmode_seconds > 0:
        last_message = (
            db.execute(
                select(Message)
                .where(Message.channel_id == channel.id, Message.author_id == current_user.id)
                .order_by(Message.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()
        )
        if last_message:
            time_since_last = datetime.now(timezone.utc) - last_message.created_at
            if time_since_last < timedelta(seconds=channel.slowmode_seconds):
                remaining = channel.slowmode_seconds - int(time_since_last.total_seconds())
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Slowmode active. Please wait {remaining} seconds before sending another message.",
                )

    parent_message = None
    if parent_id is not None:
        parent_message = _get_message(parent_id, db)
        if parent_message.channel_id != channel.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent message mismatch")

    normalized = content.rstrip()
    uploads_input = files
    if uploads_input is None:
        uploads: list[UploadFile] = []
    elif isinstance(uploads_input, (list, tuple)):
        uploads = list(uploads_input)
    else:
        uploads = [uploads_input]
    if not normalized.strip() and not uploads:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message content is required")

    if len(normalized) > settings.chat_message_max_length:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Message exceeds maximum length of {settings.chat_message_max_length} characters",
        )

    attachments = await _create_attachments(channel.id, uploads, current_user.id, db)

    message = Message(
        channel_id=channel.id,
        author_id=current_user.id,
        content=normalized,
        parent_id=parent_message.id if parent_message else None,
        thread_root_id=(
            parent_message.thread_root_id
            if parent_message and parent_message.thread_root_id
            else (parent_message.id if parent_message else None)
        ),
    )
    db.add(message)
    db.flush()

    if message.thread_root_id is None:
        message.thread_root_id = message.id

    for attachment in attachments:
        attachment.message_id = message.id

    db.commit()

    serialized = serialize_message_by_id(message.id, db, current_user.id)
    await manager.broadcast(
        channel.id,
        {"type": "message", "message": serialized.model_dump(mode="json")},
    )
    return serialized


class MessageUpdatePayload(BaseModel):
    content: str


@router.patch("/{message_id}", response_model=MessageRead)
async def update_message(
    message_id: int,
    payload: MessageUpdatePayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Edit message content."""

    message = _get_message(message_id, db)
    channel = _get_channel(message.channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)

    if message.author_id != current_user.id:
        ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    normalized = payload.content.rstrip()
    if not normalized:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message content cannot be empty")
    if len(normalized) > settings.chat_message_max_length:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Message exceeds maximum length of {settings.chat_message_max_length} characters",
        )

    message.content = normalized
    message.edited_at = datetime.now(timezone.utc)
    db.add(message)
    db.commit()

    serialized = serialize_message_by_id(message.id, db, current_user.id)
    await manager.broadcast(
        channel.id,
        {"type": "message", "message": serialized.model_dump(mode="json")},
    )
    return serialized


@router.delete("/{message_id}", response_model=MessageRead)
async def delete_message(
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Soft-delete a message."""

    message = _get_message(message_id, db)
    channel = _get_channel(message.channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)

    if message.author_id != current_user.id:
        ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    message.deleted_at = datetime.now(timezone.utc)
    db.add(message)
    db.commit()

    serialized = serialize_message_by_id(message.id, db, current_user.id)
    await manager.broadcast(
        channel.id,
        {"type": "message", "message": serialized.model_dump(mode="json")},
    )
    return serialized


class MessageModerationPayload(BaseModel):
    action: Literal["suppress", "restore"]
    note: str | None = None


@router.post("/{message_id}/moderate", response_model=MessageRead)
async def moderate_message(
    message_id: int,
    payload: MessageModerationPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MessageRead:
    """Moderate a message as an administrator."""

    message = _get_message(message_id, db)
    channel = _get_channel(message.channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)

    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    now = datetime.now(timezone.utc)
    if payload.action == "suppress":
        message.moderated_at = now
        message.moderated_by_id = current_user.id
        message.moderation_note = payload.note
    else:
        message.moderated_at = None
        message.moderated_by_id = None
        message.moderation_note = None

    db.add(message)
    db.commit()

    serialized = serialize_message_by_id(message.id, db, current_user.id)
    await manager.broadcast(
        channel.id,
        {"type": "message", "message": serialized.model_dump(mode="json")},
    )
    return serialized
