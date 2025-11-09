"""WebSocket endpoints for real-time chat communication."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Iterable, Sequence

from fastapi import APIRouter, Depends, WebSocket, status
from fastapi.exceptions import HTTPException
from fastapi.websockets import WebSocketDisconnect, WebSocketState
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from charge.voice.signaling import build_signal_envelope

from app.api.channels import (
    TEXT_CHANNEL_TYPES,
    fetch_channel_history,
    serialize_message_by_id,
)
from app.api.dm import load_user_conversations, serialize_conversation
from app.api.deps import get_user_from_token, require_room_member
from app.config import get_settings
from app.database import get_db
from app.models import (
    Channel,
    ChannelType,
    FriendLink,
    FriendRequestStatus,
    Message,
    MessageAttachment,
    MessageReaction,
    Room,
    RoomMember,
    RoomRole,
    User,
)
from app.services import direct_event_hub
from app.services.presence import presence_hub
from app.services.workspace_events import build_workspace_snapshot, workspace_event_hub

router = APIRouter(prefix="/ws", tags=["ws"])

settings = get_settings()

logger = logging.getLogger(__name__)

from charge.realtime.managers import (
    get_channel_manager,
    get_presence_manager,
    get_typing_manager,
    get_voice_manager,
)

manager = get_channel_manager()
presence_manager = get_presence_manager()
typing_manager = get_typing_manager()
signal_manager = get_voice_manager()



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


def _friend_ids(user_id: int, db: Session) -> list[int]:
    stmt = select(FriendLink).where(
        FriendLink.status == FriendRequestStatus.ACCEPTED,
        or_(
            FriendLink.requester_id == user_id,
            FriendLink.addressee_id == user_id,
        ),
    )
    links = db.execute(stmt).scalars().all()
    friends: list[int] = []
    for link in links:
        if link.requester_id == user_id:
            friends.append(link.addressee_id)
        else:
            friends.append(link.requester_id)
    return friends


def _serialize_presence_user(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "login": user.login,
        "display_name": user.display_name or user.login,
        "avatar_url": user.avatar_url,
        "status": user.presence_status.value,
    }


async def _send_presence_snapshot(
    user: User, websocket: WebSocket, db: Session
) -> list[int]:
    friend_ids = _friend_ids(user.id, db)
    target_ids = {user.id, *friend_ids}
    if not target_ids:
        return friend_ids

    stmt = select(User).where(User.id.in_(target_ids))
    users = db.execute(stmt).scalars().all()
    payload = {
        "type": "status_snapshot",
        "users": [_serialize_presence_user(candidate) for candidate in users],
    }
    if websocket.application_state == WebSocketState.CONNECTED:
        await websocket.send_json(payload)
    return friend_ids


async def _send_direct_snapshot(user_id: int, websocket: WebSocket, db: Session) -> None:
    conversations = load_user_conversations(user_id, db)
    payload = [
        serialize_conversation(conversation, user_id, db).model_dump(mode="json")
        for conversation in conversations
    ]
    if websocket.application_state == WebSocketState.CONNECTED:
        await websocket.send_json({"type": "direct_snapshot", "conversations": payload})


@router.websocket("/rooms/{room_slug}")
async def websocket_workspace_updates(
    websocket: WebSocket,
    room_slug: str,
    db: Session = Depends(get_db),
) -> None:
    """Stream structural workspace updates for the given room."""

    user = await _resolve_user(websocket, db)
    if user is None:
        return

    room = _get_room_by_slug(room_slug, db)
    if room is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Room not found")
        return

    try:
        require_room_member(room.id, user.id, db)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Not a room member")
        return

    await websocket.accept()
    await workspace_event_hub.connect(room.slug, websocket)

    snapshot = build_workspace_snapshot(room.id, db)
    if websocket.application_state == WebSocketState.CONNECTED:
        await websocket.send_json({"type": "workspace_snapshot", "room": room.slug, **snapshot})

    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            except RuntimeError:
                break
            except json.JSONDecodeError:
                await _send_error(websocket, "Invalid payload")
                continue

            if isinstance(payload, dict) and payload.get("type") == "ping":
                if websocket.application_state == WebSocketState.CONNECTED:
                    await websocket.send_json({"type": "pong"})
    finally:
        await workspace_event_hub.disconnect(room.slug, websocket)


@router.websocket("/presence")
async def websocket_presence(
    websocket: WebSocket,
    db: Session = Depends(get_db),
) -> None:
    """Stream global presence updates for the authenticated user and their friends."""

    user = await _resolve_user(websocket, db)
    if user is None:
        return

    await websocket.accept()
    await presence_hub.connect(user.id, websocket)
    try:
        await _send_presence_snapshot(user, websocket, db)
        while True:
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                break
            except RuntimeError:
                break
    finally:
        await presence_hub.disconnect(user.id, websocket)


@router.websocket("/direct")
async def websocket_direct(
    websocket: WebSocket,
    db: Session = Depends(get_db),
) -> None:
    """Stream direct conversation updates for the authenticated user."""

    user = await _resolve_user(websocket, db)
    if user is None:
        return

    await websocket.accept()
    await direct_event_hub.connect(user.id, websocket)
    try:
        await _send_direct_snapshot(user.id, websocket, db)
        while True:
            try:
                payload = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            except RuntimeError:
                break
            except json.JSONDecodeError:
                await _send_error(websocket, "Invalid payload")
                continue

            if isinstance(payload, dict) and payload.get("type") == "ping":
                if websocket.application_state == WebSocketState.CONNECTED:
                    await websocket.send_json({"type": "pong"})
                continue
            if isinstance(payload, dict) and payload.get("type") == "refresh":
                await _send_direct_snapshot(user.id, websocket, db)
    finally:
        await direct_event_hub.disconnect(user.id, websocket)


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
    if channel is None or channel.type not in TEXT_CHANNEL_TYPES:
        await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA, reason="Invalid channel")
        return

    if not _ensure_membership(channel, user, db):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Not a room member")
        return

    await websocket.accept()
    await manager.connect(channel.id, websocket)

    history_page = fetch_channel_history(
        channel.id,
        settings.chat_history_default_limit,
        db,
        current_user_id=user.id,
    )
    await websocket.send_json(
        {
            "type": "history",
            "page": history_page.model_dump(mode="json"),
        }
    )

    await presence_manager.join(channel.id, user, websocket)
    await typing_manager.send_snapshot(channel.id, websocket)

    try:
        timeout_seconds = settings.websocket_receive_timeout_seconds
        keepalive_payload = {"type": "ping"}
        while True:
            try:
                if timeout_seconds and timeout_seconds > 0:
                    raw_message = await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=timeout_seconds,
                    )
                else:
                    raw_message = await websocket.receive_text()
            except asyncio.TimeoutError:
                if websocket.application_state != WebSocketState.CONNECTED:
                    break
                try:
                    await websocket.send_json(keepalive_payload)
                except RuntimeError:
                    break
                continue
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
            elif payload_type == "typing":
                is_typing = payload.get("is_typing")
                if not isinstance(is_typing, bool):
                    await _send_error(
                        websocket, "Typing payload must include boolean 'is_typing'"
                    )
                    continue
                await typing_manager.set_status(
                    channel.id, user, is_typing, source=websocket
                )
            elif payload_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            else:
                await _send_error(websocket, "Unsupported payload type")
    except WebSocketDisconnect:
        pass
    finally:
        await typing_manager.clear_user(channel.id, user.id)
        await presence_manager.leave(channel.id, user.id)
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

    membership_stmt = select(RoomMember).where(
        RoomMember.room_id == room.id, RoomMember.user_id == user.id
    )
    membership = db.execute(membership_stmt).scalar_one_or_none()
    if membership is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Not a room member")
        return

    await websocket.accept()
    participant_state, snapshot, stats, recording_state = await signal_manager.register(
        room.slug,
        websocket,
        user_id=user.id,
        display_name=user.display_name or user.login,
    )

    participant_payload = participant_state.to_public()

    await websocket.send_json(
        {
            "type": "system",
            "event": "welcome",
            "user": participant_payload,
            "role": membership.role.value,
            "features": {
                "recording": settings.voice_recording_enabled,
                "qualityMonitoring": settings.voice_quality_monitoring_enabled,
            },
        }
    )
    await websocket.send_json(
        {
            "type": "state",
            "event": "participants",
            "participants": snapshot,
            "stats": stats,
        }
    )
    if recording_state is not None:
        await websocket.send_json({"type": "state", "event": "recording", **recording_state})

    await signal_manager.broadcast(
        room.slug,
        {"type": "system", "event": "peer-joined", "user": participant_payload},
        exclude={websocket},
        publish=True,
    )
    await signal_manager.broadcast_state(room.slug, exclude={websocket}, publish=True)

    try:
        timeout_seconds = settings.websocket_receive_timeout_seconds
        keepalive_payload = {"type": "ping"}
        while True:
            try:
                if timeout_seconds and timeout_seconds > 0:
                    raw_message = await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=timeout_seconds,
                    )
                else:
                    raw_message = await websocket.receive_text()
            except asyncio.TimeoutError:
                if websocket.application_state != WebSocketState.CONNECTED:
                    break
                try:
                    await websocket.send_json(keepalive_payload)
                except RuntimeError:
                    break
                continue
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

            participant_payload = participant_state.to_public()

            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if message_type in {"offer", "answer", "candidate", "bye"}:
                signal_body = build_signal_envelope(
                    message_type, {key: value for key, value in payload.items() if key != "type"}
                )
                forwarded_payload = {
                    "type": "signal",
                    "signal": signal_body,
                    "from": participant_payload,
                }
                await signal_manager.relay_signal(
                    room.slug, forwarded_payload, exclude={websocket}
                )
                continue

            if message_type == "signal":
                signal_body = payload.get("signal")
                if not isinstance(signal_body, dict):
                    signal_body = {
                        key: value for key, value in payload.items() if key != "type"
                    }
                forwarded_payload = {
                    "type": "signal",
                    "signal": signal_body,
                    "from": participant_payload,
                }
                await signal_manager.relay_signal(
                    room.slug, forwarded_payload, exclude={websocket}
                )
                continue

            if message_type != "state":
                await _send_error(websocket, "Unsupported payload type")
                continue

            event = payload.get("event")
            if not isinstance(event, str) or not event:
                await _send_error(websocket, "State event must be provided")
                continue

            if event == "set-role":
                target_raw = payload.get("target") or payload.get("target_id") or user.id
                try:
                    target_id = int(target_raw)
                except (TypeError, ValueError):
                    await _send_error(websocket, "target must be a valid identifier")
                    continue
                requested_role = str(payload.get("role", "")).lower()
                _, changed, error = await signal_manager.set_role(
                    room.slug,
                    target_id=target_id,
                    new_role=requested_role,
                    actor_id=user.id,
                    actor_role=membership.role,
                )
                if error is not None:
                    await _send_error(websocket, error)
                    continue
                if changed:
                    await signal_manager.broadcast_state(room.slug, publish=True)
                continue

            if event in {"set-muted", "set-deafened"}:
                target_raw = payload.get("target") or payload.get("target_id") or user.id
                try:
                    target_id = int(target_raw)
                except (TypeError, ValueError):
                    await _send_error(websocket, "target must be a valid identifier")
                    continue
                target_state = await signal_manager.get_participant(room.slug, target_id)
                if target_state is None:
                    await _send_error(websocket, "Participant not found")
                    continue
                key = "muted" if event == "set-muted" else "deafened"
                current_value = target_state.muted if event == "set-muted" else target_state.deafened
                desired = payload.get(key)
                desired_value = (not current_value) if desired is None else bool(desired)
                if event == "set-muted":
                    _, changed, error = await signal_manager.set_muted(
                        room.slug,
                        target_id=target_id,
                        muted=desired_value,
                        actor_id=user.id,
                        actor_role=membership.role,
                    )
                else:
                    _, changed, error = await signal_manager.set_deafened(
                        room.slug,
                        target_id=target_id,
                        deafened=desired_value,
                        actor_id=user.id,
                        actor_role=membership.role,
                    )
                if error is not None:
                    await _send_error(websocket, error)
                    continue
                if changed:
                    await signal_manager.broadcast_state(room.slug, publish=True)
                continue

            if event == "stage":
                action = str(payload.get("action") or "").lower()
                if action in {"status", "set-status"}:
                    target_raw = payload.get("target") or payload.get("target_id") or user.id
                    try:
                        target_id = int(target_raw)
                    except (TypeError, ValueError):
                        await _send_error(websocket, "target must be a valid identifier")
                        continue
                    status_value = payload.get("status") or payload.get("stageStatus")
                    if not isinstance(status_value, str) or not status_value:
                        await _send_error(websocket, "Stage status must be provided")
                        continue
                    _, changed, error = await signal_manager.set_stage_status(
                        room.slug,
                        target_id=target_id,
                        status=status_value,
                        actor_id=user.id,
                        actor_role=membership.role,
                    )
                    if error is not None:
                        await _send_error(websocket, error)
                        continue
                    if changed:
                        await signal_manager.broadcast_state(room.slug, publish=True)
                    continue

                if action in {"hand", "raise-hand"}:
                    target_raw = payload.get("target") or payload.get("target_id") or user.id
                    try:
                        target_id = int(target_raw)
                    except (TypeError, ValueError):
                        await _send_error(websocket, "target must be a valid identifier")
                        continue
                    raised_value = payload.get("raised")
                    if raised_value is None:
                        raised_value = payload.get("value")
                    desired_value = bool(raised_value)
                    _, changed, error = await signal_manager.set_hand_raised(
                        room.slug,
                        target_id=target_id,
                        raised=desired_value,
                        actor_id=user.id,
                        actor_role=membership.role,
                    )
                    if error is not None:
                        await _send_error(websocket, error)
                        continue
                    if changed:
                        await signal_manager.broadcast_state(room.slug, publish=True)
                    continue

                await _send_error(websocket, "Unsupported stage action")
                continue

            if event == "media":
                target_raw = payload.get("target") or payload.get("target_id") or user.id
                try:
                    target_id = int(target_raw)
                except (TypeError, ValueError):
                    await _send_error(websocket, "target must be a valid identifier")
                    continue
                target_state = await signal_manager.get_participant(room.slug, target_id)
                if target_state is None:
                    await _send_error(websocket, "Participant not found")
                    continue
                if target_id != user.id and membership.role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                    await _send_error(websocket, "Недостаточно прав для изменения видео")
                    continue
                desired = payload.get("videoEnabled")
                desired_value = (
                    not target_state.video_enabled if desired is None else bool(desired)
                )
                _, changed = await signal_manager.set_video_state(
                    room.slug, target_id=target_id, video_enabled=desired_value
                )
                if changed:
                    await signal_manager.broadcast_state(room.slug, publish=True)
                continue

            if event == "quality-report":
                metrics = payload.get("metrics")
                if not isinstance(metrics, dict):
                    await _send_error(websocket, "Quality metrics payload is invalid")
                    continue
                await signal_manager.record_quality(room.slug, user.id, metrics)
                continue

            if event == "recording":
                if not settings.voice_recording_enabled:
                    await _send_error(websocket, "Запись недоступна на сервере")
                    continue
                if membership.role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                    await _send_error(websocket, "Недостаточно прав для управления записью")
                    continue
                active = bool(payload.get("active"))
                await signal_manager.set_recording_state(
                    room.slug, active, actor=participant_state.to_public()
                )
                continue

            await _send_error(websocket, "Unsupported state event")
    except WebSocketDisconnect:
        pass
    finally:
        snapshot, stats, departed = await signal_manager.unregister(room.slug, user.id)
        await signal_manager.broadcast(
            room.slug,
            {
                "type": "system",
                "event": "peer-left",
                "user": (
                    departed.to_public() if departed is not None else participant_state.to_public()
                ),
            },
            publish=True,
        )
        if snapshot is not None:
            await signal_manager.broadcast(
                room.slug,
                {
                    "type": "state",
                    "event": "participants",
                    "participants": snapshot,
                    "stats": stats,
                },
                publish=True,
            )
