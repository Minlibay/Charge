"""Distributed realtime managers backed by Redis/NATS pub/sub."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Sequence, Set, TYPE_CHECKING

from fastapi.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.config import get_settings
from app.monitoring.metrics import (
    realtime_connections,
    realtime_events_total,
    realtime_publish_errors_total,
    realtime_subscriptions,
)

try:  # pragma: no cover - optional dependency
    import httpx
except ImportError:  # pragma: no cover - httpx is optional
    httpx = None

from ..voice.signaling import (
    EXPLICIT_STAGE_STATUSES,
    QualityReport,
    build_signal_envelope,
    compute_stage_status,
    merge_quality_metrics,
)

from .transport import (
    BrokerConfig,
    PRESENCE_TOPIC,
    RedisNATSTransport,
    Subscription,
    TYPING_TOPIC,
    VOICE_TOPIC,
    TransportUnavailableError,
)

if TYPE_CHECKING:  # pragma: no cover - typing helpers only
    from app.models import RoomRole, User


logger = logging.getLogger(__name__)


async def safe_send_json(websocket: WebSocket, data: dict[str, Any]) -> bool:
    """Safely send JSON data through websocket, handling disconnections gracefully.
    
    Returns True if message was sent successfully, False otherwise.
    """
    if websocket.application_state != WebSocketState.CONNECTED:
        return False
    try:
        await websocket.send_json(data)
        return True
    except (WebSocketDisconnect, RuntimeError) as e:
        logger.debug("Failed to send websocket message: %s", e)
        return False


# ---------------------------------------------------------------------------
# Internal state helpers
# ---------------------------------------------------------------------------


class PresenceStatusStore:
    """Cluster aware storage for presence snapshots."""

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
            self._user_channels[user_id].discard(channel_id)
            if not self._user_channels[user_id]:
                self._user_channels.pop(user_id, None)
            if not bucket:
                self._online.pop(channel_id, None)
            snapshot = self._format_snapshot(bucket or {})
            return snapshot, True

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

    async def replace_snapshot(
        self, channel_id: int, entries: Sequence[dict[str, Any]]
    ) -> list[dict[str, str | int | None]]:
        async with self._lock:
            bucket: dict[int, dict[str, str | int | None]] = {}
            for entry in entries:
                try:
                    user_id = int(entry.get("id"))
                except (TypeError, ValueError):
                    continue
                bucket[user_id] = {
                    "id": user_id,
                    "display_name": entry.get("display_name"),
                    "status": entry.get("status"),
                    "avatar_url": entry.get("avatar_url"),
                }
                self._user_channels[user_id].add(channel_id)
            if bucket:
                self._online[channel_id] = bucket
            else:
                self._online.pop(channel_id, None)
            return self._format_snapshot(bucket)


class TypingStatusStore:
    """Stores transient typing indicators."""

    def __init__(self, ttl_seconds: float) -> None:
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

    async def replace_snapshot(
        self, channel_id: int, entries: Sequence[dict[str, Any]]
    ) -> list[dict[str, str | int]]:
        now = time.monotonic()
        async with self._lock:
            bucket: Dict[int, tuple[str, float]] = {}
            for entry in entries:
                try:
                    user_id = int(entry.get("id"))
                except (TypeError, ValueError):
                    continue
                display_name = str(entry.get("display_name", ""))
                bucket[user_id] = (display_name, now)
            if bucket:
                self._entries[channel_id] = bucket
            else:
                self._entries.pop(channel_id, None)
            return self._build_snapshot(bucket, now)


# ---------------------------------------------------------------------------
# Connection manager
# ---------------------------------------------------------------------------


class ChannelConnectionManager:
    """Track active WebSocket connections per channel."""

    def __init__(self) -> None:
        self._connections: Dict[int, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, channel_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            bucket = self._connections.setdefault(channel_id, set())
            bucket.add(websocket)
            realtime_connections.labels("channels").inc()

    async def disconnect(self, channel_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            connections = self._connections.get(channel_id)
            if connections and websocket in connections:
                connections.remove(websocket)
                realtime_connections.labels("channels").dec()
                if not connections:
                    self._connections.pop(channel_id, None)

    async def broadcast(
        self,
        channel_id: int,
        payload: dict[str, Any],
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
                    continue


# ---------------------------------------------------------------------------
# Presence manager
# ---------------------------------------------------------------------------


class PresenceManager:
    """Distribute presence updates across the cluster."""

    def __init__(
        self,
        connection_manager: ChannelConnectionManager,
        transport: RedisNATSTransport,
        *,
        node_id: str,
        backend: str,
    ) -> None:
        self._connections = connection_manager
        self._store = PresenceStatusStore()
        self._transport = transport
        self._node_id = node_id
        self._backend = backend
        self._subscription: Subscription | None = None
        self._publish_warning_logged = False
        self._subscribe_warning_logged = False

    @staticmethod
    def _display_name(user: "User") -> str:
        return user.display_name or user.login

    async def start(self) -> None:
        async def handle(message: dict[str, Any]) -> None:
            origin = message.get("origin")
            if origin == self._node_id:
                return
            try:
                channel_id = int(message["channel_id"])
            except (KeyError, TypeError, ValueError):
                return
            snapshot = message.get("online", [])
            snapshot = await self._store.replace_snapshot(channel_id, snapshot)
            payload = {"type": "presence", "channel_id": channel_id, "online": snapshot}
            await self._connections.broadcast(channel_id, payload)
            realtime_events_total.labels("presence", "in", message.get("action", "snapshot")).inc()

        try:
            self._subscription = await self._transport.subscribe(
                PRESENCE_TOPIC, handle, backend=self._backend
            )
        except TransportUnavailableError as exc:
            if not self._subscribe_warning_logged:
                logger.warning(
                    "Realtime backend unavailable; presence updates will be limited to this instance",
                    exc_info=logger.isEnabledFor(logging.DEBUG),
                )
                self._subscribe_warning_logged = True
            self._subscription = None
            return
        realtime_subscriptions.labels("presence", self._backend).inc()
        self._subscribe_warning_logged = False

    async def stop(self) -> None:
        if self._subscription is not None:
            await self._subscription.close()
            realtime_subscriptions.labels("presence", self._backend).dec()
            self._subscription = None

    async def join(self, channel_id: int, user: "User", websocket: WebSocket) -> None:
        snapshot, changed = await self._store.mark_online(
            channel_id,
            user_id=user.id,
            display_name=self._display_name(user),
            status=user.presence_status.value,
            avatar_url=user.avatar_url,
        )
        payload = {"type": "presence", "channel_id": channel_id, "online": snapshot}
        await safe_send_json(websocket, payload)
        if changed:
            await self._connections.broadcast(channel_id, payload, exclude={websocket})
            await self._publish(
                "join",
                {
                    "action": "join",
                    "channel_id": channel_id,
                    "online": snapshot,
                    "origin": self._node_id,
                },
            )

    async def leave(self, channel_id: int, user_id: int) -> None:
        snapshot, changed = await self._store.mark_offline(channel_id, user_id)
        if changed:
            payload = {"type": "presence", "channel_id": channel_id, "online": snapshot}
            await self._connections.broadcast(channel_id, payload)
            await self._publish(
                "leave",
                {
                    "action": "leave",
                    "channel_id": channel_id,
                    "online": snapshot,
                    "origin": self._node_id,
                },
            )

    async def refresh_user(self, user: "User") -> None:
        updates = await self._store.update_user(
            user.id,
            display_name=self._display_name(user),
            status=user.presence_status.value,
            avatar_url=user.avatar_url,
        )
        for channel_id, snapshot in updates:
            payload = {"type": "presence", "channel_id": channel_id, "online": snapshot}
            await self._connections.broadcast(channel_id, payload)
            await self._publish(
                "refresh",
                {
                    "action": "refresh",
                    "channel_id": channel_id,
                    "online": snapshot,
                    "origin": self._node_id,
                },
            )

    async def _publish(self, action: str, payload: dict[str, Any]) -> None:
        try:
            await self._transport.publish(
                PRESENCE_TOPIC,
                payload,
                backend=self._backend,
            )
        except TransportUnavailableError:
            if not self._publish_warning_logged:
                logger.warning(
                    "Realtime backend unavailable while broadcasting %s presence update; operating in local-only mode",
                    action,
                    exc_info=logger.isEnabledFor(logging.DEBUG),
                )
                self._publish_warning_logged = True
            realtime_publish_errors_total.labels("presence", self._backend, "unavailable").inc()
        except Exception:
            realtime_publish_errors_total.labels("presence", self._backend, "error").inc()
            logger.exception(
                "Unexpected error while broadcasting %s presence update", action
            )
        else:
            self._publish_warning_logged = False
            realtime_events_total.labels("presence", "out", action).inc()


# ---------------------------------------------------------------------------
# Typing manager
# ---------------------------------------------------------------------------


class TypingManager:
    """Broadcast typing indicators across instances."""

    def __init__(
        self,
        connection_manager: ChannelConnectionManager,
        transport: RedisNATSTransport,
        *,
        node_id: str,
        backend: str,
        ttl_seconds: float,
    ) -> None:
        self._connections = connection_manager
        self._store = TypingStatusStore(ttl_seconds)
        self._transport = transport
        self._node_id = node_id
        self._backend = backend
        self._subscription: Subscription | None = None
        self._publish_warning_logged = False
        self._subscribe_warning_logged = False

    @staticmethod
    def _display_name(user: "User") -> str:
        return user.display_name or user.login

    async def start(self) -> None:
        async def handle(message: dict[str, Any]) -> None:
            if message.get("origin") == self._node_id:
                return
            try:
                channel_id = int(message["channel_id"])
            except (KeyError, TypeError, ValueError):
                return
            snapshot = await self._store.replace_snapshot(channel_id, message.get("users", []))
            payload = {
                "type": "typing",
                "channel_id": channel_id,
                "users": snapshot,
                "expires_in": self._store.ttl,
            }
            await self._connections.broadcast(channel_id, payload)
            realtime_events_total.labels("typing", "in", message.get("action", "snapshot")).inc()

        try:
            self._subscription = await self._transport.subscribe(
                TYPING_TOPIC, handle, backend=self._backend
            )
        except TransportUnavailableError as exc:
            if not self._subscribe_warning_logged:
                logger.warning(
                    "Realtime backend unavailable; typing indicators will not sync across instances",
                    exc_info=logger.isEnabledFor(logging.DEBUG),
                )
                self._subscribe_warning_logged = True
            self._subscription = None
            return
        realtime_subscriptions.labels("typing", self._backend).inc()
        self._subscribe_warning_logged = False

    async def stop(self) -> None:
        if self._subscription is not None:
            await self._subscription.close()
            realtime_subscriptions.labels("typing", self._backend).dec()
            self._subscription = None

    async def send_snapshot(self, channel_id: int, websocket: WebSocket) -> None:
        snapshot = await self._store.snapshot(channel_id)
        if snapshot:
            await safe_send_json(
                websocket,
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
        user: "User",
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
        await self._publish(
            "set",
            {
                "action": "set",
                "channel_id": channel_id,
                "users": snapshot,
                "origin": self._node_id,
            },
        )

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
        await self._publish(
            "clear",
            {
                "action": "clear",
                "channel_id": channel_id,
                "users": snapshot,
                "origin": self._node_id,
            },
        )

    async def _publish(self, action: str, payload: dict[str, Any]) -> None:
        try:
            await self._transport.publish(
                TYPING_TOPIC,
                payload,
                backend=self._backend,
            )
        except TransportUnavailableError:
            if not self._publish_warning_logged:
                logger.warning(
                    "Realtime backend unavailable while broadcasting %s typing update; operating in local-only mode",
                    action,
                    exc_info=logger.isEnabledFor(logging.DEBUG),
                )
                self._publish_warning_logged = True
            realtime_publish_errors_total.labels("typing", self._backend, "unavailable").inc()
        except Exception:
            realtime_publish_errors_total.labels("typing", self._backend, "error").inc()
            logger.exception(
                "Unexpected error while broadcasting %s typing update", action
            )
        else:
            self._publish_warning_logged = False
            realtime_events_total.labels("typing", "out", action).inc()


# ---------------------------------------------------------------------------
# Voice signalling manager
# ---------------------------------------------------------------------------


@dataclass
class ParticipantState:
    websocket: WebSocket
    user_id: int
    display_name: str
    role: str
    muted: bool = False
    deafened: bool = False
    video_enabled: bool = False
    stage_status: str = field(default="listener")
    stage_override: str | None = None
    hand_raised: bool = False
    last_quality: dict[str, dict[str, Any]] | None = None

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.user_id,
            "displayName": self.display_name,
            "role": self.role,
            "muted": self.muted,
            "deafened": self.deafened,
            "videoEnabled": self.video_enabled,
            "stageStatus": self.stage_status,
            "handRaised": self.hand_raised,
            "quality": self.last_quality,
        }


class VoiceSignalManager:
    """Manage WebRTC signalling with cross-node fan-out."""

    _OVERRIDE_UNSET = object()

    def __init__(
        self,
        transport: RedisNATSTransport,
        *,
        node_id: str,
        backend: str,
        settings,
    ) -> None:
        self._transport = transport
        self._node_id = node_id
        self._backend = backend
        self._settings = settings
        self._rooms: Dict[str, Dict[int, ParticipantState]] = defaultdict(dict)
        self._quality_reports: Dict[str, Dict[int, dict[str, dict[str, Any]]]] = defaultdict(dict)
        self._recording_state: Dict[str, dict[str, Any]] = {}
        self._room_meta: Dict[str, dict[str, str]] = {}
        self._lock = asyncio.Lock()
        self._subscription: Subscription | None = None
        self._publish_warning_logged = False
        self._subscribe_warning_logged = False

    def _update_stage_status_locked(
        self, participant: ParticipantState, *, override: str | None | object = _OVERRIDE_UNSET
    ) -> None:
        if override is not self._OVERRIDE_UNSET:
            participant.stage_override = override
        participant.stage_status = compute_stage_status(
            participant.role,
            muted=participant.muted,
            deafened=participant.deafened,
            explicit_status=participant.stage_override,
        )

    async def start(self) -> None:
        async def handle(message: dict[str, Any]) -> None:
            if message.get("origin") == self._node_id:
                return
            room = message.get("room")
            if not isinstance(room, str):
                return
            payload = message.get("payload")
            if not isinstance(payload, dict):
                return
            await self.broadcast(room, payload)
            realtime_events_total.labels("voice", "in", payload.get("type", "message")).inc()

        try:
            self._subscription = await self._transport.subscribe(
                VOICE_TOPIC, handle, backend=self._backend
            )
        except TransportUnavailableError as exc:
            if not self._subscribe_warning_logged:
                logger.warning(
                    "Realtime backend unavailable; voice signalling fan-out will be local only",
                    exc_info=logger.isEnabledFor(logging.DEBUG),
                )
                self._subscribe_warning_logged = True
            self._subscription = None
            return
        realtime_subscriptions.labels("voice", self._backend).inc()
        self._subscribe_warning_logged = False

    async def stop(self) -> None:
        if self._subscription is not None:
            await self._subscription.close()
            realtime_subscriptions.labels("voice", self._backend).dec()
            self._subscription = None

    # Existing room management helpers copied from the legacy manager -----------------
    async def register(
        self,
        room_slug: str,
        websocket: WebSocket,
        *,
        user_id: int,
        display_name: str,
    ) -> tuple[
        ParticipantState,
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
            self._update_stage_status_locked(participant, override=None)
            participants[user_id] = participant
            self._touch_room_locked(room_slug)
            snapshot = self._snapshot_locked(room_slug)
            stats = self._stats_locked(room_slug)
            recording_state = self._recording_state.get(room_slug)
        realtime_connections.labels("voice").inc()
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
        realtime_connections.labels("voice").dec()
        return snapshot, stats, participant

    async def broadcast(
        self,
        room_slug: str,
        payload: dict[str, Any],
        *,
        exclude: Iterable[WebSocket] | None = None,
        publish: bool = False,
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

        if publish:
            await self._publish(
                payload.get("type", "message"),
                {
                    "room": room_slug,
                    "payload": payload,
                    "origin": self._node_id,
                },
            )

    async def broadcast_state(
        self, room_slug: str, *, exclude: Iterable[WebSocket] | None = None, publish: bool = False
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
            publish=publish,
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

    async def get_participant(self, room_slug: str, user_id: int) -> ParticipantState | None:
        async with self._lock:
            return self._rooms.get(room_slug, {}).get(user_id)

    # The remaining state mutation methods delegate to the legacy logic and publish updates.
    # ------------------------------------------------------------------

    async def set_role(
        self,
        room_slug: str,
        target_id: int,
        new_role: str,
        *,
        actor_id: int,
        actor_role: "RoomRole",
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        from app.models import RoomRole  # local import to avoid heavy module level dependency

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
                and self._count_role_locked(participants, "speaker")
                >= self._settings.webrtc_max_speakers
            ):
                return None, False, "Превышено максимальное число спикеров"
            target.role = role
            if role == "speaker":
                self._update_stage_status_locked(target)
            else:
                self._update_stage_status_locked(target, override=None)
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
            publish=True,
        )
        return snapshot, True, None

    async def set_muted(
        self,
        room_slug: str,
        target_id: int,
        muted: bool,
        *,
        actor_id: int,
        actor_role: "RoomRole",
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        from app.models import RoomRole

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
            self._update_stage_status_locked(target)
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
            publish=True,
        )
        return snapshot, True, None

    async def set_deafened(
        self,
        room_slug: str,
        target_id: int,
        deafened: bool,
        *,
        actor_id: int,
        actor_role: "RoomRole",
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        from app.models import RoomRole

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
            self._update_stage_status_locked(target)
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
            publish=True,
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
            publish=True,
        )
        return snapshot, True

    async def set_stage_status(
        self,
        room_slug: str,
        target_id: int,
        status: str,
        *,
        actor_id: int,
        actor_role: "RoomRole",
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        from app.models import RoomRole

        desired = status.strip().lower()
        if desired not in EXPLICIT_STAGE_STATUSES:
            return None, False, "Недопустимый статус сцены"

        async with self._lock:
            participants = self._rooms.get(room_slug, {})
            target = participants.get(target_id)
            if target is None:
                return None, False, "Participant not found"
            if target.role != "speaker":
                return None, False, "Участник не находится на сцене"
            if target_id != actor_id and actor_role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                return None, False, "Недостаточно прав для изменения статуса"
            previous = target.stage_override or target.stage_status
            self._update_stage_status_locked(target, override=desired)
            if previous == target.stage_status:
                snapshot = self._snapshot_locked(room_slug)
                return snapshot, False, None
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
            publish=True,
        )
        return snapshot, True, None

    async def set_hand_raised(
        self,
        room_slug: str,
        target_id: int,
        raised: bool,
        *,
        actor_id: int,
        actor_role: "RoomRole",
    ) -> tuple[list[dict[str, Any]] | None, bool, str | None]:
        from app.models import RoomRole

        async with self._lock:
            participants = self._rooms.get(room_slug, {})
            target = participants.get(target_id)
            if target is None:
                return None, False, "Participant not found"
            if target_id != actor_id and actor_role not in {RoomRole.OWNER, RoomRole.ADMIN}:
                return None, False, "Недостаточно прав для изменения статуса руки"
            if target.hand_raised == raised:
                snapshot = self._snapshot_locked(room_slug)
                return snapshot, False, None
            target.hand_raised = raised
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
            publish=True,
        )
        return snapshot, True, None

    async def record_quality(self, room_slug: str, user_id: int, metrics: dict[str, Any]) -> None:
        report = QualityReport.from_payload(metrics)
        async with self._lock:
            room_reports = self._quality_reports.setdefault(room_slug, {})
            merged = merge_quality_metrics(room_reports.get(user_id), report)
            room_reports[user_id] = merged
            participant = self._rooms.get(room_slug, {}).get(user_id)
            if participant is not None:
                participant.last_quality = merged
            self._touch_room_locked(room_slug)
        await self.broadcast(
            room_slug,
            {
                "type": "state",
                "event": "quality-update",
                "userId": user_id,
                "track": report.track,
                "metrics": report.metrics,
            },
            publish=True,
        )
        if (
            self._settings.voice_quality_monitoring_enabled
            and self._settings.voice_quality_monitoring_endpoint is not None
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
            {"type": "state", "event": "recording", "active": active, "timestamp": timestamp, "by": actor},
            publish=True,
        )
        if (
            self._settings.voice_recording_enabled
            and self._settings.voice_recording_service_url is not None
        ):
            asyncio.create_task(self._notify_recording_service(room_slug, active, actor))

    async def relay_signal(
        self,
        room_slug: str,
        payload: dict[str, Any],
        *,
        exclude: Iterable[WebSocket] | None = None,
    ) -> None:
        await self.broadcast(room_slug, payload, exclude=exclude, publish=True)

    async def _publish(self, event_type: str, payload: dict[str, Any]) -> None:
        try:
            await self._transport.publish(
                VOICE_TOPIC,
                payload,
                backend=self._backend,
            )
        except TransportUnavailableError:
            if not self._publish_warning_logged:
                logger.warning(
                    "Realtime backend unavailable while broadcasting %s voice update; operating in local-only mode",
                    event_type,
                    exc_info=logger.isEnabledFor(logging.DEBUG),
                )
                self._publish_warning_logged = True
            realtime_publish_errors_total.labels("voice", self._backend, "unavailable").inc()
        except Exception:
            realtime_publish_errors_total.labels("voice", self._backend, "error").inc()
            logger.exception(
                "Unexpected error while broadcasting %s voice update", event_type
            )
        else:
            self._publish_warning_logged = False
            realtime_events_total.labels("voice", "out", event_type).inc()

    # ------------------------------------------------------------------
    # Legacy private helpers with minimal modifications
    # ------------------------------------------------------------------
    def _snapshot_locked(self, room_slug: str) -> list[dict[str, Any]]:
        participants = self._rooms.get(room_slug, {})
        snapshot = [participant.to_public() for participant in participants.values()]
        snapshot.sort(key=lambda item: str(item.get("displayName", "")).lower())
        return snapshot

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
            now = datetime.now(timezone.utc).isoformat()
            stats["updatedAt"] = now
        return stats

    def _count_role_locked(self, participants: Dict[int, ParticipantState], role: str) -> int:
        return sum(1 for participant in participants.values() if participant.role == role)

    def _default_role_locked(
        self,
        room_slug: str,
        participants: Dict[int, ParticipantState],
    ) -> str:
        default_role = self._settings.webrtc_default_role.lower()
        if default_role not in {"speaker", "listener"}:
            default_role = "listener"
        if (
            self._settings.webrtc_auto_promote_first_speaker
            and not self._count_role_locked(participants, "speaker")
        ):
            return "speaker"
        return default_role

    def _touch_room_locked(self, room_slug: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        meta = self._room_meta.get(room_slug)
        if meta is None:
            self._room_meta[room_slug] = {"created_at": now, "updated_at": now}
        else:
            meta["updated_at"] = now

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
                await client.post(str(self._settings.voice_quality_monitoring_endpoint), json=payload)
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
                await client.post(str(self._settings.voice_recording_service_url), json=payload)
        except Exception:  # pragma: no cover - external service failures
            logger.exception("Failed to notify recording service")


# ---------------------------------------------------------------------------
# Module level lifecycle helpers
# ---------------------------------------------------------------------------


settings = get_settings()

_node_id = settings.realtime_node_id or uuid.uuid4().hex

transport = RedisNATSTransport(
    BrokerConfig(
        redis_url=settings.realtime_redis_url,
        redis_prefix=settings.realtime_namespace,
        nats_url=settings.realtime_nats_url,
        nats_prefix=settings.realtime_namespace,
        node_id=_node_id,
    )
)

channel_manager = ChannelConnectionManager()
presence_manager = PresenceManager(
    channel_manager,
    transport,
    node_id=_node_id,
    backend=settings.realtime_backend_preference,
)
typing_manager = TypingManager(
    channel_manager,
    transport,
    node_id=_node_id,
    backend=settings.realtime_backend_preference,
    ttl_seconds=float(settings.realtime_typing_ttl_seconds),
)
voice_manager = VoiceSignalManager(
    transport,
    node_id=_node_id,
    backend=settings.realtime_voice_backend or settings.realtime_backend_preference,
    settings=settings,
)


async def startup_realtime() -> None:
    try:
        await transport.start()
    except (TransportUnavailableError, OSError) as exc:
        logger.warning(
            "Realtime backend unavailable during startup; continuing without cross-node sync",
            exc_info=logger.isEnabledFor(logging.DEBUG),
        )
        return

    try:
        await asyncio.gather(
            presence_manager.start(),
            typing_manager.start(),
            voice_manager.start(),
        )
    except TransportUnavailableError as exc:
        logger.warning(
            "Realtime subscription setup failed; continuing without cross-node sync",
            exc_info=logger.isEnabledFor(logging.DEBUG),
        )


async def shutdown_realtime() -> None:
    await asyncio.gather(
        presence_manager.stop(),
        typing_manager.stop(),
        voice_manager.stop(),
    )
    await transport.stop()


# Convenience accessors exposed to the FastAPI layer ----------------------


def configure_realtime() -> None:
    """Retained for backwards compatibility; settings are loaded eagerly."""


def get_channel_manager() -> ChannelConnectionManager:
    return channel_manager


def get_presence_manager() -> PresenceManager:
    return presence_manager


def get_typing_manager() -> TypingManager:
    return typing_manager


def get_voice_manager() -> VoiceSignalManager:
    return voice_manager


__all__ = [
    "ChannelConnectionManager",
    "PresenceManager",
    "TypingManager",
    "VoiceSignalManager",
    "configure_realtime",
    "startup_realtime",
    "shutdown_realtime",
    "get_channel_manager",
    "get_presence_manager",
    "get_typing_manager",
    "get_voice_manager",
]

