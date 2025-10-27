"""WebSocket endpoints for real-time chat communication."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Dict, Iterable, Sequence, Set

from fastapi import APIRouter, Depends, WebSocket, status
from fastapi.exceptions import HTTPException
from fastapi.websockets import WebSocketDisconnect, WebSocketState
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.channels import fetch_channel_history, serialize_message_by_id
from app.api.deps import get_user_from_token
from app.config import get_settings
from app.database import get_db
from app.models import (
    Channel,
    ChannelType,
    Message,
    MessageAttachment,
    MessageReaction,
    Room,
    RoomMember,
    User,
)

router = APIRouter(prefix="/ws", tags=["ws"])

settings = get_settings()


class ChannelConnectionManager:
    """Utility managing active WebSocket connections per channel."""

    def __init__(self) -> None:
        self._connections: Dict[int, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, channel_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[channel_id].add(websocket)

    async def disconnect(self, channel_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            connections = self._connections.get(channel_id)
            if connections and websocket in connections:
                connections.remove(websocket)
                if not connections:
                    self._connections.pop(channel_id, None)

    async def broadcast(self, channel_id: int, payload: dict) -> None:
        connections: Iterable[WebSocket] = self._connections.get(channel_id, set()).copy()
        for connection in connections:
            if connection.application_state == WebSocketState.CONNECTED:
                try:
                    await connection.send_json(payload)
                except RuntimeError:
                    # Connection might be closing; ignore individual failures.
                    continue


manager = ChannelConnectionManager()


class RoomSignalManager:
    """Manage WebSocket connections used for WebRTC signalling per room."""

    def __init__(self) -> None:
        self._connections: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, room_slug: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[room_slug].add(websocket)

    async def disconnect(self, room_slug: str, websocket: WebSocket) -> None:
        async with self._lock:
            connections = self._connections.get(room_slug)
            if connections and websocket in connections:
                connections.remove(websocket)
                if not connections:
                    self._connections.pop(room_slug, None)

    async def broadcast(
        self,
        room_slug: str,
        payload: dict,
        *,
        exclude: Iterable[WebSocket] | None = None,
    ) -> None:
        exclude_set = set(exclude or [])
        async with self._lock:
            connections = list(self._connections.get(room_slug, set()))

        for connection in connections:
            if connection in exclude_set:
                continue
            if connection.application_state == WebSocketState.CONNECTED:
                try:
                    await connection.send_json(payload)
                except RuntimeError:
                    continue


signal_manager = RoomSignalManager()


async def _resolve_user(websocket: WebSocket, db: Session) -> User | None:
    token = websocket.query_params.get("token")
    if not token:
        auth_header = websocket.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Missing token")
        return None

    try:
        return get_user_from_token(token, db)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid token")
        return None


def _get_channel(channel_id: int, db: Session) -> Channel | None:
    stmt = select(Channel).where(Channel.id == channel_id)
    return db.execute(stmt).scalar_one_or_none()


def _get_room_by_slug(room_slug: str, db: Session) -> Room | None:
    stmt = select(Room).where(Room.slug == room_slug)
    return db.execute(stmt).scalar_one_or_none()


def _get_message(channel_id: int, message_id: int, db: Session) -> Message | None:
    stmt = select(Message).where(Message.channel_id == channel_id, Message.id == message_id)
    return db.execute(stmt).scalar_one_or_none()


def _fetch_attachments(
    channel_id: int, attachment_ids: Sequence[int], db: Session
) -> list[MessageAttachment]:
    if not attachment_ids:
        return []
    stmt = select(MessageAttachment).where(
        MessageAttachment.channel_id == channel_id,
        MessageAttachment.id.in_(attachment_ids),
    )
    attachments = list(db.execute(stmt).scalars())
    return attachments


def _ensure_membership(channel: Channel, user: User, db: Session) -> bool:
    membership_stmt = select(RoomMember.id).where(
        RoomMember.room_id == channel.room_id,
        RoomMember.user_id == user.id,
    )
    membership = db.execute(membership_stmt).scalar_one_or_none()
    return membership is not None


async def _send_error(websocket: WebSocket, detail: str) -> None:
    if websocket.application_state == WebSocketState.CONNECTED:
        await websocket.send_json({"type": "error", "detail": detail})


@router.websocket("/text/{channel_id}")
async def websocket_text_channel(
    websocket: WebSocket,
    channel_id: int,
    db: Session = Depends(get_db),
) -> None:
    """Handle WebSocket communication for text channels."""

    user = await _resolve_user(websocket, db)
    if user is None:
        return

    channel = _get_channel(channel_id, db)
    if channel is None or channel.type != ChannelType.TEXT:
        await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA, reason="Invalid channel")
        return

    if not _ensure_membership(channel, user, db):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Not a room member")
        return

    await websocket.accept()
    await manager.connect(channel.id, websocket)

    history = fetch_channel_history(
        channel.id,
        settings.chat_history_default_limit,
        db,
        current_user_id=user.id,
    )
    await websocket.send_json(
        {
            "type": "history",
            "messages": [message.model_dump(mode="json") for message in history],
        }
    )

    try:
        while True:
            try:
                raw_message = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=settings.websocket_receive_timeout_seconds,
                )
            except asyncio.TimeoutError:
                await _send_error(websocket, "Connection timed out due to inactivity")
                await websocket.close(code=status.WS_1001_GOING_AWAY)
                break
            except WebSocketDisconnect:
                break

            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await _send_error(websocket, "Invalid message format")
                continue

            if not isinstance(payload, dict):
                await _send_error(websocket, "Message payload must be a JSON object")
                continue

            payload_type = payload.get("type", "message")

            if payload_type == "message":
                content = str(payload.get("content", ""))
                attachment_ids_raw = payload.get("attachments", [])
                parent_id_raw = payload.get("parent_id")

                if not isinstance(attachment_ids_raw, list) or any(
                    not isinstance(item, int) for item in attachment_ids_raw
                ):
                    await _send_error(
                        websocket, "Attachments must be provided as a list of integers"
                    )
                    continue

                attachments = _fetch_attachments(channel.id, attachment_ids_raw, db)
                if len(attachments) != len(set(attachment_ids_raw)):
                    await _send_error(websocket, "One or more attachments were not found")
                    continue

                invalid_attachment = next(
                    (
                        attachment
                        for attachment in attachments
                        if attachment.uploader_id != user.id or attachment.message_id is not None
                    ),
                    None,
                )
                if invalid_attachment is not None:
                    await _send_error(websocket, "Attachment is not available for use")
                    continue

                parent_message = None
                if parent_id_raw is not None:
                    if not isinstance(parent_id_raw, int):
                        await _send_error(websocket, "parent_id must be an integer")
                        continue
                    parent_message = _get_message(channel.id, parent_id_raw, db)
                    if parent_message is None:
                        await _send_error(websocket, "Parent message not found")
                        continue

                if not content.strip() and not attachments:
                    await _send_error(
                        websocket, "Message must contain content or attachments"
                    )
                    continue

                if len(content) > settings.chat_message_max_length:
                    await _send_error(
                        websocket,
                        f"Message exceeds maximum length of {settings.chat_message_max_length} characters",
                    )
                    continue

                message = Message(
                    channel_id=channel.id,
                    author_id=user.id,
                    content=content,
                    parent_id=parent_message.id if parent_message else None,
                    thread_root_id=(
                        parent_message.thread_root_id
                        if parent_message and parent_message.thread_root_id
                        else (parent_message.id if parent_message else None)
                    ),
                )
                db.add(message)
                try:
                    db.flush()
                except Exception:  # pragma: no cover - defensive rollback
                    db.rollback()
                    await _send_error(websocket, "Failed to store message")
                    continue

                if message.thread_root_id is None:
                    message.thread_root_id = message.id

                for attachment in attachments:
                    attachment.message_id = message.id

                try:
                    db.commit()
                except Exception:  # pragma: no cover - defensive rollback
                    db.rollback()
                    await _send_error(websocket, "Failed to store message")
                    continue

                serialized = serialize_message_by_id(message.id, db, None)
                await manager.broadcast(
                    channel.id,
                    {"type": "message", "message": serialized.model_dump(mode="json")},
                )
            elif payload_type == "reaction":
                message_id = payload.get("message_id")
                emoji = str(payload.get("emoji", "")).strip()
                operation = str(payload.get("operation", "add")).lower()

                if not isinstance(message_id, int):
                    await _send_error(websocket, "Reaction payload must include integer 'message_id'")
                    continue
                if not emoji:
                    await _send_error(websocket, "Reaction payload must include 'emoji'")
                    continue

                target_message = _get_message(channel.id, message_id, db)
                if target_message is None:
                    await _send_error(websocket, "Message not found")
                    continue

                if operation == "remove":
                    stmt = select(MessageReaction).where(
                        MessageReaction.message_id == target_message.id,
                        MessageReaction.user_id == user.id,
                        MessageReaction.emoji == emoji,
                    )
                    reaction = db.execute(stmt).scalar_one_or_none()
                    if reaction is None:
                        await _send_error(websocket, "Reaction not found")
                        continue
                    db.delete(reaction)
                    try:
                        db.commit()
                    except Exception:  # pragma: no cover - defensive rollback
                        db.rollback()
                        await _send_error(websocket, "Failed to update reaction")
                        continue
                else:
                    reaction = MessageReaction(
                        message_id=target_message.id,
                        user_id=user.id,
                        emoji=emoji,
                    )
                    db.add(reaction)
                    try:
                        db.commit()
                    except IntegrityError:
                        db.rollback()
                        # Reaction already exists; fetch latest state without broadcasting error
                    except Exception:  # pragma: no cover - defensive rollback
                        db.rollback()
                        await _send_error(websocket, "Failed to update reaction")
                        continue

                serialized = serialize_message_by_id(target_message.id, db, None)
                await manager.broadcast(
                    channel.id,
                    {"type": "reaction", "message": serialized.model_dump(mode="json")},
                )
            else:
                await _send_error(websocket, "Unsupported payload type")
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(channel.id, websocket)


@router.websocket("/signal/{room_slug}")
async def websocket_signal_room(
    websocket: WebSocket,
    room_slug: str,
    db: Session = Depends(get_db),
) -> None:
    """Handle WebRTC SDP/ICE signalling inside a room."""

    user = await _resolve_user(websocket, db)
    if user is None:
        return

    room = _get_room_by_slug(room_slug, db)
    if room is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Room not found")
        return

    membership_stmt = select(RoomMember.id).where(
        RoomMember.room_id == room.id, RoomMember.user_id == user.id
    )
    if db.execute(membership_stmt).scalar_one_or_none() is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Not a room member")
        return

    await websocket.accept()
    await signal_manager.connect(room.slug, websocket)

    user_payload = {
        "id": user.id,
        "displayName": user.display_name or user.login,
    }

    await websocket.send_json({"type": "system", "event": "welcome", "user": user_payload})
    await signal_manager.broadcast(
        room.slug,
        {"type": "system", "event": "peer-joined", "user": user_payload},
        exclude={websocket},
    )

    try:
        while True:
            try:
                raw_message = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=settings.websocket_receive_timeout_seconds,
                )
            except asyncio.TimeoutError:
                await _send_error(websocket, "Connection timed out due to inactivity")
                await websocket.close(code=status.WS_1001_GOING_AWAY)
                break
            except WebSocketDisconnect:
                break

            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await _send_error(websocket, "Invalid message format")
                continue

            if not isinstance(payload, dict):
                await _send_error(websocket, "Message payload must be a JSON object")
                continue

            message_type = payload.get("type")
            if not isinstance(message_type, str) or not message_type:
                await _send_error(websocket, "Message type must be provided")
                continue

            forwarded_payload = {**payload, "from": user_payload}
            await signal_manager.broadcast(
                room.slug,
                forwarded_payload,
                exclude={websocket},
            )
    except WebSocketDisconnect:
        pass
    finally:
        await signal_manager.disconnect(room.slug, websocket)
        await signal_manager.broadcast(
            room.slug,
            {"type": "system", "event": "peer-left", "user": user_payload},
        )
