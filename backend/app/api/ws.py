"""WebSocket endpoints for real-time chat communication."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Sequence, Set

from fastapi import APIRouter, Depends, WebSocket, status
from fastapi.exceptions import HTTPException
from fastapi.websockets import WebSocketDisconnect, WebSocketState
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

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

try:  # pragma: no cover - optional dependency
    import httpx
except ImportError:  # pragma: no cover - optional dependency
    httpx = None


@dataclass
class ParticipantState:
    websocket: WebSocket
    user_id: int
    display_name: str
    role: str
    muted: bool = False
    deafened: bool = False
    video_enabled: bool = False
    last_quality: dict[str, Any] | None = None

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.user_id,
            "displayName": self.display_name,
            "role": self.role,
            "muted": self.muted,
            "deafened": self.deafened,
            "videoEnabled": self.video_enabled,
        }


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

    async def broadcast(
        self,
        channel_id: int,
        payload: dict,
        *,
        exclude: Iterable[WebSocket] | None = None,
    ) -> None:
        connections: Iterable[WebSocket] = self._connections.get(channel_id, set()).copy()
        exclude_set = set(exclude or [])
        for connection in connections:
            if connection in exclude_set:
                continue
            if connection.application_state == WebSocketState.CONNECTED:
                try:
                    await connection.send_json(payload)
                except RuntimeError:
                    # Connection might be closing; ignore individual failures.
                    continue


manager = ChannelConnectionManager()


class PresenceStatusStore:
    """In-memory storage for tracking online users per channel."""

    def __init__(self) -> None:
        self._online: Dict[int, Dict[int, dict[str, str | int | None]]] = defaultdict(dict)
        self._user_channels: Dict[int, Set[int]] = defaultdict(set)
        self._lock = asyncio.Lock()

    @staticmethod
    def _format_snapshot(
        bucket: Dict[int, dict[str, str | int | None]]
    ) -> list[dict[str, str | int | None]]:
        entries = []
        for user_id, data in bucket.items():
            entries.append(
                {
                    "id": user_id,
                    "display_name": data.get("display_name"),
                    "status": data.get("status"),
                    "avatar_url": data.get("avatar_url"),
                }
            )
        entries.sort(key=lambda item: str(item["display_name"]).lower())
        return entries

    async def mark_online(
        self,
        channel_id: int,
        *,
        user_id: int,
        display_name: str,
        status: str,
        avatar_url: str | None,
    ) -> tuple[list[dict[str, str | int | None]], bool]:
        async with self._lock:
            bucket = self._online.setdefault(channel_id, {})
            was_present = user_id in bucket
            bucket[user_id] = {
                "id": user_id,
                "display_name": display_name,
                "status": status,
                "avatar_url": avatar_url,
            }
            self._user_channels[user_id].add(channel_id)
            snapshot = self._format_snapshot(bucket)
            return snapshot, not was_present

    async def mark_offline(
        self, channel_id: int, user_id: int
    ) -> tuple[list[dict[str, str | int | None]], bool]:
        async with self._lock:
            bucket = self._online.get(channel_id)
            if not bucket or user_id not in bucket:
                snapshot = self._format_snapshot(bucket or {})
                return snapshot, False

            bucket.pop(user_id, None)
            channels = self._user_channels.get(user_id)
            if channels:
                channels.discard(channel_id)
                if not channels:
                    self._user_channels.pop(user_id, None)
            if not bucket:
                self._online.pop(channel_id, None)
                return [], True

            snapshot = self._format_snapshot(bucket)
            return snapshot, True

    async def snapshot(self, channel_id: int) -> list[dict[str, str | int | None]]:
        async with self._lock:
            bucket = self._online.get(channel_id, {})
            return self._format_snapshot(bucket)

    async def update_user(
        self,
        user_id: int,
        *,
        display_name: str,
        status: str,
        avatar_url: str | None,
    ) -> list[tuple[int, list[dict[str, str | int | None]]]]:
        async with self._lock:
            channels = list(self._user_channels.get(user_id, set()))
            updates: list[tuple[int, list[dict[str, str | int | None]]]] = []
            for channel_id in channels:
                bucket = self._online.get(channel_id)
                if not bucket or user_id not in bucket:
                    continue
                bucket[user_id] = {
                    "id": user_id,
                    "display_name": display_name,
                    "status": status,
                    "avatar_url": avatar_url,
                }
                updates.append((channel_id, self._format_snapshot(bucket)))
            return updates


class TypingStatusStore:
    """In-memory store keeping track of temporary typing indicators."""

    def __init__(self, ttl_seconds: float = 5.0) -> None:
        self._ttl = ttl_seconds
        self._entries: Dict[int, Dict[int, tuple[str, float]]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    @property
    def ttl(self) -> float:
        return self._ttl

    def _cleanup_expired(
        self, channel_id: int, bucket: Dict[int, tuple[str, float]], now: float
    ) -> bool:
        removed = [user_id for user_id, (_, ts) in bucket.items() if now - ts > self._ttl]
        for user_id in removed:
            bucket.pop(user_id, None)
        if not bucket and channel_id in self._entries:
            self._entries.pop(channel_id, None)
        return bool(removed)

    def _build_snapshot(
        self, bucket: Dict[int, tuple[str, float]], now: float
    ) -> list[dict[str, str | int]]:
        entries: list[dict[str, str | int]] = []
        for user_id, (display_name, ts) in bucket.items():
            if now - ts <= self._ttl:
                entries.append({"id": user_id, "display_name": display_name})
        entries.sort(key=lambda item: str(item["display_name"]).lower())
        return entries

    async def set_status(
        self,
        channel_id: int,
        *,
        user_id: int,
        display_name: str,
        is_typing: bool,
    ) -> tuple[list[dict[str, str | int]], bool]:
        now = time.monotonic()
        async with self._lock:
            bucket = self._entries.setdefault(channel_id, {})
            changed = False
            if is_typing:
                bucket[user_id] = (display_name, now)
                changed = True
            elif user_id in bucket:
                bucket.pop(user_id, None)
                changed = True

            if self._cleanup_expired(channel_id, bucket, now):
                changed = True

            snapshot = self._build_snapshot(bucket, now)
            return snapshot, changed

    async def clear_user(
        self, channel_id: int, user_id: int
    ) -> tuple[list[dict[str, str | int]], bool]:
        now = time.monotonic()
        async with self._lock:
            bucket = self._entries.get(channel_id)
            if not bucket or user_id not in bucket:
                snapshot = self._build_snapshot(bucket or {}, now)
                return snapshot, False

            bucket.pop(user_id, None)
            changed = True
            if self._cleanup_expired(channel_id, bucket, now):
                changed = True

            snapshot = self._build_snapshot(bucket or {}, now)
            return snapshot, changed

    async def snapshot(self, channel_id: int) -> list[dict[str, str | int]]:
        now = time.monotonic()
        async with self._lock:
            bucket = self._entries.get(channel_id, {})
            if bucket and self._cleanup_expired(channel_id, bucket, now):
                bucket = self._entries.get(channel_id, {})
            return self._build_snapshot(bucket or {}, now)


class PresenceManager:
    """High-level manager for presence notifications."""

    def __init__(self, connection_manager: ChannelConnectionManager) -> None:
        self._connections = connection_manager
        self._store = PresenceStatusStore()

    @staticmethod
    def _display_name(user: User) -> str:
        return user.display_name or user.login

    async def join(self, channel_id: int, user: User, websocket: WebSocket) -> None:
        snapshot, changed = await self._store.mark_online(
            channel_id,
            user_id=user.id,
            display_name=self._display_name(user),
            status=user.presence_status.value,
            avatar_url=user.avatar_url,
        )
        payload = {
            "type": "presence",
            "channel_id": channel_id,
            "online": snapshot,
        }
        if websocket.application_state == WebSocketState.CONNECTED:
            await websocket.send_json(payload)
        if changed:
            await self._connections.broadcast(channel_id, payload, exclude={websocket})

    async def leave(self, channel_id: int, user_id: int) -> None:
        snapshot, changed = await self._store.mark_offline(channel_id, user_id)
        if changed:
            payload = {"type": "presence", "channel_id": channel_id, "online": snapshot}
            await self._connections.broadcast(channel_id, payload)

    async def refresh_user(self, user: User) -> None:
        updates = await self._store.update_user(
            user.id,
            display_name=self._display_name(user),
            status=user.presence_status.value,
            avatar_url=user.avatar_url,
        )
        for channel_id, snapshot in updates:
            payload = {"type": "presence", "channel_id": channel_id, "online": snapshot}
            await self._connections.broadcast(channel_id, payload)


class TypingManager:
    """Broadcast typing indicators to participants of a channel."""

    def __init__(
        self,
        connection_manager: ChannelConnectionManager,
        store: TypingStatusStore | None = None,
    ) -> None:
        self._connections = connection_manager
        self._store = store or TypingStatusStore()

    @staticmethod
    def _display_name(user: User) -> str:
        return user.display_name or user.login

    async def send_snapshot(self, channel_id: int, websocket: WebSocket) -> None:
        snapshot = await self._store.snapshot(channel_id)
        if snapshot and websocket.application_state == WebSocketState.CONNECTED:
            await websocket.send_json(
                {
                    "type": "typing",
                    "channel_id": channel_id,
                    "users": snapshot,
                    "expires_in": self._store.ttl,
                }
            )

    async def set_status(
        self,
        channel_id: int,
        user: User,
        is_typing: bool,
        *,
        source: WebSocket | None = None,
    ) -> None:
        snapshot, changed = await self._store.set_status(
            channel_id,
            user_id=user.id,
            display_name=self._display_name(user),
            is_typing=is_typing,
        )
        if not changed:
            return

        payload = {
            "type": "typing",
            "channel_id": channel_id,
            "users": snapshot,
            "expires_in": self._store.ttl,
        }
        exclude = {source} if source is not None else None
        await self._connections.broadcast(channel_id, payload, exclude=exclude)

    async def clear_user(self, channel_id: int, user_id: int) -> None:
        snapshot, changed = await self._store.clear_user(channel_id, user_id)
        if not changed:
            return
        payload = {
            "type": "typing",
            "channel_id": channel_id,
            "users": snapshot,
            "expires_in": self._store.ttl,
        }
        await self._connections.broadcast(channel_id, payload)


manager = ChannelConnectionManager()
presence_manager = PresenceManager(manager)
typing_manager = TypingManager(manager)


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


class RoomSignalManager:
    """Manage WebSocket connections and shared state for WebRTC rooms."""

    def __init__(self) -> None:
        self._rooms: Dict[str, Dict[int, "ParticipantState"]] = defaultdict(dict)
        self._lock = asyncio.Lock()
        self._quality_reports: Dict[str, Dict[int, dict[str, Any]]] = defaultdict(dict)
        self._recording_state: Dict[str, dict[str, Any]] = {}
        self._room_meta: Dict[str, dict[str, str]] = {}

    async def register(
        self,
        room_slug: str,
        websocket: WebSocket,
        *,
        user_id: int,
        display_name: str,
    ) -> tuple[
        "ParticipantState",
        list[dict[str, Any]],
        dict[str, Any],
        dict[str, Any] | None,
    ]:
        async with self._lock:
            participants = self._rooms.setdefault(room_slug, {})
            role = self._default_role_locked(room_slug, participants)
            participant = ParticipantState(
                websocket=websocket,
                user_id=user_id,
                display_name=display_name,
                role=role,
            )
            participants[user_id] = participant
            self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
            recording_state = self._recording_state.get(room_slug)
        return participant, snapshot, stats, recording_state

    async def unregister(
        self, room_slug: str, user_id: int
    ) -> tuple[list[dict[str, Any]], dict[str, Any], ParticipantState | None]:
        async with self._lock:
            participants = self._rooms.get(room_slug)
            participant = None
            if participants and user_id in participants:
                participant = participants.pop(user_id)
                if not participants:
                    self._rooms.pop(room_slug, None)
                    self._quality_reports.pop(room_slug, None)
                    self._recording_state.pop(room_slug, None)
                    self._room_meta.pop(room_slug, None)
                else:
                    self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
        return snapshot, stats, participant

    async def broadcast(
        self,
        room_slug: str,
        payload: dict,
        *,
        exclude: Iterable[WebSocket] | None = None,
    ) -> None:
        exclude_set = set(exclude or [])
        async with self._lock:
            connections = [
                state.websocket
                for state in self._rooms.get(room_slug, {}).values()
                if state.websocket.application_state == WebSocketState.CONNECTED
            ]

        for connection in connections:
            if connection in exclude_set:
                continue
            try:
                await connection.send_json(payload)
            except RuntimeError:
                continue

    async def broadcast_state(
        self, room_slug: str, *, exclude: Iterable[WebSocket] | None = None
    ) -> None:
        snapshot, stats = await self.state(room_slug)
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "participants",
                "participants": snapshot,
                "stats": stats,
            },
            exclude=exclude,
        )

    async def snapshot(self, room_slug: str) -> list[dict[str, Any]]:
        snapshot, _ = await self.state(room_slug)
        return snapshot

    async def state(self, room_slug: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        async with self._lock:
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
        return snapshot, stats

    async def rooms_overview(self) -> dict[str, dict[str, Any]]:
        async with self._lock:
            overview: dict[str, dict[str, Any]] = {}
            for slug in list(self._rooms.keys()):
                overview[slug] = {
                    "participants": self._snapshot_locked(slug),
                    "stats": self._stats_locked(slug),
                }
            return overview

    async def get_participant(
        self, room_slug: str, user_id: int
    ) -> ParticipantState | None:
        async with self._lock:
            return self._rooms.get(room_slug, {}).get(user_id)

    async def set_role(
        self,
        room_slug: str,
        target_id: int,
        new_role: str,
        *,
        actor_id: int,
        actor_role: RoomRole,
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        role = new_role.lower()
        if role not in {"speaker", "listener"}:
            return None, False, "Unsupported role"

        async with self._lock:
            participants = self._rooms.get(room_slug, {})
            target = participants.get(target_id)
            if target is None:
                return None, False, "Participant not found"
            if target.role == role:
                snapshot = self._snapshot_locked(room_slug)
                return snapshot, False, None
            if target_id != actor_id and actor_role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                return None, False, "Недостаточно прав для изменения роли"
            if (
                role == "speaker"
                and target.role != "speaker"
                and self._count_role_locked(participants, "speaker") >= settings.webrtc_max_speakers
            ):
                return None, False, "Превышено максимальное число спикеров"
            target.role = role
            self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
            participant_payload = target.to_public()
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "participant-updated",
                "participant": participant_payload,
                "stats": stats,
            },
        )
        return snapshot, True, None

    async def set_muted(
        self,
        room_slug: str,
        target_id: int,
        muted: bool,
        *,
        actor_id: int,
        actor_role: RoomRole,
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        async with self._lock:
            participants = self._rooms.get(room_slug, {})
            target = participants.get(target_id)
            if target is None:
                return None, False, "Participant not found"
            if target_id != actor_id and actor_role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                return None, False, "Недостаточно прав для управления микрофоном"
            if target.muted == muted:
                snapshot = self._snapshot_locked(room_slug)
                return snapshot, False, None
            target.muted = muted
            self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
            participant_payload = target.to_public()
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "participant-updated",
                "participant": participant_payload,
                "stats": stats,
            },
        )
        return snapshot, True, None

    async def set_deafened(
        self,
        room_slug: str,
        target_id: int,
        deafened: bool,
        *,
        actor_id: int,
        actor_role: RoomRole,
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        async with self._lock:
            participants = self._rooms.get(room_slug, {})
            target = participants.get(target_id)
            if target is None:
                return None, False, "Participant not found"
            if target_id != actor_id and actor_role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                return None, False, "Недостаточно прав для управления прослушиванием"
            if target.deafened == deafened:
                snapshot = self._snapshot_locked(room_slug)
                return snapshot, False, None
            target.deafened = deafened
            self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
            participant_payload = target.to_public()
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "participant-updated",
                "participant": participant_payload,
                "stats": stats,
            },
        )
        return snapshot, True, None

    async def set_video_state(
        self,
        room_slug: str,
        target_id: int,
        video_enabled: bool,
    ) -> tuple[list[dict[str, Any]] | None, bool]:
        async with self._lock:
            participants = self._rooms.get(room_slug, {})
            target = participants.get(target_id)
            if target is None:
                return None, False
            if target.video_enabled == video_enabled:
                snapshot = self._snapshot_locked(room_slug)
                return snapshot, False
            target.video_enabled = video_enabled
            self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
            participant_payload = target.to_public()
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "participant-updated",
                "participant": participant_payload,
                "stats": stats,
            },
        )
        return snapshot, True

    async def record_quality(
        self, room_slug: str, user_id: int, metrics: dict[str, Any]
    ) -> None:
        async with self._lock:
            self._quality_reports.setdefault(room_slug, {})[user_id] = metrics
            participant = self._rooms.get(room_slug, {}).get(user_id)
            if participant is not None:
                participant.last_quality = metrics
            self._touch_room_locked(room_slug)
        await self.broadcast(
            room_slug,
            {"type": "state", "event": "quality-update", "userId": user_id, "metrics": metrics},
        )
        if (
            settings.voice_quality_monitoring_enabled
            and settings.voice_quality_monitoring_endpoint is not None
        ):
            asyncio.create_task(self._forward_quality(room_slug, user_id, metrics))

    async def set_recording_state(
        self,
        room_slug: str,
        active: bool,
        *,
        actor: dict[str, Any],
    ) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        async with self._lock:
            self._recording_state[room_slug] = {
                "active": active,
                "timestamp": timestamp,
                "by": actor,
            }
            self._touch_room_locked(room_slug)
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "recording",
                "active": active,
                "timestamp": timestamp,
                "by": actor,
            },
        )
        if settings.voice_recording_enabled and settings.voice_recording_service_url is not None:
            asyncio.create_task(self._notify_recording_service(room_slug, active, actor))

    async def current_recording_state(self, room_slug: str) -> dict[str, Any] | None:
        async with self._lock:
            state = self._recording_state.get(room_slug)
            return dict(state) if state else None

    async def _forward_quality(
        self, room_slug: str, user_id: int, metrics: dict[str, Any]
    ) -> None:  # pragma: no cover - network interaction
        if httpx is None:
            logger.debug("Quality endpoint configured but httpx is unavailable")
            return
        payload = {
            "room": room_slug,
            "user": user_id,
            "metrics": metrics,
            "reported_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(str(settings.voice_quality_monitoring_endpoint), json=payload)
        except Exception:  # pragma: no cover - external service failures
            logger.exception("Failed to forward quality metrics")

    async def _notify_recording_service(
        self, room_slug: str, active: bool, actor: dict[str, Any]
    ) -> None:  # pragma: no cover - network interaction
        if httpx is None:
            logger.debug("Recording service configured but httpx is unavailable")
            return
        payload = {
            "room": room_slug,
            "active": active,
            "actor": actor,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(str(settings.voice_recording_service_url), json=payload)
        except Exception:  # pragma: no cover - external service failures
            logger.exception("Failed to notify recording service")

    def _default_role_locked(
        self, room_slug: str, participants: Dict[int, "ParticipantState"]
    ) -> str:
        default_role = settings.webrtc_default_role.lower()
        if default_role not in {"speaker", "listener"}:
            default_role = "listener"
        if settings.webrtc_auto_promote_first_speaker and not self._count_role_locked(
            participants, "speaker"
        ):
            return "speaker"
        return default_role

    @staticmethod
    def _count_role_locked(
        participants: Dict[int, "ParticipantState"], role: str
    ) -> int:
        return sum(1 for participant in participants.values() if participant.role == role)

    def _touch_room_locked(self, room_slug: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        meta = self._room_meta.get(room_slug)
        if meta is None:
            self._room_meta[room_slug] = {"created_at": now, "updated_at": now}
        else:
            meta["updated_at"] = now

    def _stats_locked(self, room_slug: str) -> dict[str, Any]:
        participants = self._rooms.get(room_slug, {})
        stats = {
            "total": len(participants),
            "speakers": self._count_role_locked(participants, "speaker"),
            "listeners": self._count_role_locked(participants, "listener"),
            "activeSpeakers": sum(
                1
                for participant in participants.values()
                if participant.role == "speaker"
                and not participant.muted
                and not participant.deafened
            ),
        }
        meta = self._room_meta.get(room_slug)
        if meta:
            stats["createdAt"] = meta.get("created_at")
            stats["updatedAt"] = meta.get("updated_at")
        else:
            stats["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return stats

    def _snapshot_locked(self, room_slug: str) -> list[dict[str, Any]]:
        participants = self._rooms.get(room_slug, {})
        snapshot = [participant.to_public() for participant in participants.values()]
        snapshot.sort(key=lambda item: str(item.get("displayName", "")).lower())
        return snapshot


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

    await presence_manager.join(channel.id, user, websocket)
    await typing_manager.send_snapshot(channel.id, websocket)

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
    )
    await signal_manager.broadcast_state(room.slug, exclude={websocket})

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

            participant_payload = participant_state.to_public()

            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if message_type in {"offer", "answer", "candidate", "bye"}:
                signal_body: dict[str, Any] = {"kind": message_type}
                if message_type in {"offer", "answer"}:
                    signal_body["description"] = payload.get("description")
                elif message_type == "candidate":
                    signal_body["candidate"] = payload.get("candidate")
                forwarded_payload = {
                    "type": "signal",
                    "signal": signal_body,
                    "from": participant_payload,
                }
                await signal_manager.broadcast(
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
                await signal_manager.broadcast(
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
                    await signal_manager.broadcast_state(room.slug)
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
                    await signal_manager.broadcast_state(room.slug)
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
                    await signal_manager.broadcast_state(room.slug)
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
            )
