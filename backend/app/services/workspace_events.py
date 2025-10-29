"""Utilities for broadcasting workspace updates to connected clients."""

from __future__ import annotations

import anyio
import asyncio
from collections import defaultdict
from typing import Any, Dict, Sequence, Set

from fastapi.websockets import WebSocket, WebSocketState
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import Channel, ChannelCategory, RoomInvitation, RoomMember
from app.schemas import (
    ChannelCategoryRead,
    ChannelRead,
    RoomInvitationRead,
    RoomMemberSummary,
)


class WorkspaceEventHub:
    """Tracks websocket connections subscribed to workspace events."""

    def __init__(self) -> None:
        self._connections: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, room_slug: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[room_slug].add(websocket)

    async def disconnect(self, room_slug: str, websocket: WebSocket) -> None:
        async with self._lock:
            sockets = self._connections.get(room_slug)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._connections.pop(room_slug, None)

    async def broadcast(self, room_slug: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            sockets = list(self._connections.get(room_slug, set()))
        if not sockets:
            return
        for socket in sockets:
            if socket.application_state != WebSocketState.CONNECTED:
                continue
            try:
                await socket.send_json(payload)
            except RuntimeError:
                continue


workspace_event_hub = WorkspaceEventHub()
"""Singleton hub that coordinates workspace websocket notifications."""


def _dispatch(room_slug: str, payload: dict[str, Any]) -> None:
    """Schedule delivery of a payload to all listeners of the room."""

    async def _send() -> None:
        await workspace_event_hub.broadcast(room_slug, payload)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        try:
            anyio.from_thread.run(_send)
        except anyio.NoEventLoopError:
            asyncio.run(_send())
    else:
        loop.create_task(_send())


def _serialize_channel(channel: Channel) -> dict[str, Any]:
    return ChannelRead.model_validate(channel, from_attributes=True).model_dump(mode="json")


def _serialize_channels(channels: Sequence[Channel]) -> list[dict[str, Any]]:
    ordered = sorted(
        channels,
        key=lambda item: (
            (item.category_id or -1),
            getattr(item, "position", 0),
            item.name.lower(),
        ),
    )
    return [_serialize_channel(channel) for channel in ordered]


def _serialize_categories(categories: Sequence[ChannelCategory]) -> list[dict[str, Any]]:
    ordered = sorted(categories, key=lambda item: (item.position, item.name.lower()))
    return [
        ChannelCategoryRead.model_validate(category, from_attributes=True).model_dump(mode="json")
        for category in ordered
    ]


def _serialize_members(members: Sequence[RoomMember]) -> list[dict[str, Any]]:
    ordered = sorted(
        members,
        key=lambda member: (
            (member.user.display_name or member.user.login or "") if member.user else "",
        ),
    )
    return [
        RoomMemberSummary.model_validate(member, from_attributes=True).model_dump(mode="json")
        for member in ordered
    ]


def _serialize_invitation(invitation: RoomInvitation) -> dict[str, Any]:
    return RoomInvitationRead.model_validate(invitation, from_attributes=True).model_dump(
        mode="json"
    )


def _load_channels(room_id: int, db: Session) -> list[dict[str, Any]]:
    stmt = select(Channel).where(Channel.room_id == room_id)
    channels = db.execute(stmt).scalars().all()
    return _serialize_channels(channels)


def _load_categories(room_id: int, db: Session) -> list[dict[str, Any]]:
    stmt = select(ChannelCategory).where(ChannelCategory.room_id == room_id)
    categories = db.execute(stmt).scalars().all()
    return _serialize_categories(categories)


def _load_members(room_id: int, db: Session) -> list[dict[str, Any]]:
    stmt = (
        select(RoomMember)
        .where(RoomMember.room_id == room_id)
        .options(selectinload(RoomMember.user))
    )
    members = db.execute(stmt).scalars().all()
    return _serialize_members(members)


def publish_channel_created(room_slug: str, channel: Channel) -> None:
    payload = {
        "type": "channel_created",
        "room": room_slug,
        "channel": _serialize_channel(channel),
    }
    _dispatch(room_slug, payload)


def publish_channel_updated(room_slug: str, channel: Channel) -> None:
    payload = {
        "type": "channel_updated",
        "room": room_slug,
        "channel": _serialize_channel(channel),
    }
    _dispatch(room_slug, payload)


def publish_channel_deleted(room_slug: str, channel_id: int) -> None:
    payload = {
        "type": "channel_deleted",
        "room": room_slug,
        "channel_id": channel_id,
    }
    _dispatch(room_slug, payload)


def publish_channels_reordered(room_slug: str, channels: Sequence[Channel]) -> None:
    payload = {
        "type": "channel_reordered",
        "room": room_slug,
        "channels": _serialize_channels(channels),
    }
    _dispatch(room_slug, payload)


def publish_invitation_created(room_slug: str, invitation: RoomInvitation) -> None:
    payload = {
        "type": "invite_created",
        "room": room_slug,
        "invitation": _serialize_invitation(invitation),
    }
    _dispatch(room_slug, payload)


def publish_invitation_deleted(room_slug: str, invitation_id: int) -> None:
    payload = {
        "type": "invite_deleted",
        "room": room_slug,
        "invitation_id": invitation_id,
    }
    _dispatch(room_slug, payload)


def publish_categories_snapshot(
    room_slug: str,
    room_id: int,
    db: Session,
    *,
    event_type: str,
    include_channels: bool = False,
) -> None:
    payload: dict[str, Any] = {
        "type": event_type,
        "room": room_slug,
        "categories": _load_categories(room_id, db),
    }
    if include_channels:
        payload["channels"] = _load_channels(room_id, db)
    _dispatch(room_slug, payload)


def publish_members_snapshot(room_slug: str, room_id: int, db: Session, *, event_type: str) -> None:
    payload = {
        "type": event_type,
        "room": room_slug,
        "members": _load_members(room_id, db),
    }
    _dispatch(room_slug, payload)


def build_workspace_snapshot(room_id: int, db: Session) -> dict[str, list[dict[str, Any]]]:
    return {
        "channels": _load_channels(room_id, db),
        "categories": _load_categories(room_id, db),
        "members": _load_members(room_id, db),
    }
