"""Utilities for broadcasting workspace updates to connected clients."""

from __future__ import annotations

import anyio
import asyncio
from collections import defaultdict
from typing import Any, Dict, Sequence, Set

from fastapi.websockets import WebSocket, WebSocketDisconnect, WebSocketState
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import Channel, ChannelCategory, CustomRole, RoomInvitation, RoomMember
from app.schemas import (
    ChannelCategoryRead,
    ChannelRead,
    CustomRoleRead,
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
            except (WebSocketDisconnect, RuntimeError):
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


def _serialize_members(members: Sequence[RoomMember], db: Session | None = None) -> list[dict[str, Any]]:
    ordered = sorted(
        members,
        key=lambda member: (
            (member.user.display_name or member.user.login or "") if member.user else "",
        ),
    )
    
    result = []
    for member in ordered:
        member_data = RoomMemberSummary.model_validate(member, from_attributes=True).model_dump(mode="json")
        
        # Load custom roles if db is provided
        if db is not None and member.room_id:
            from app.models import CustomRole, UserCustomRole
            from app.schemas.roles import CustomRoleRead
            from sqlalchemy import select
            
            stmt = (
                select(CustomRole)
                .join(UserCustomRole, CustomRole.id == UserCustomRole.custom_role_id)
                .where(
                    CustomRole.room_id == member.room_id,
                    UserCustomRole.user_id == member.user_id,
                )
                .order_by(CustomRole.position.desc())
            )
            custom_roles = db.execute(stmt).scalars().all()
            member_data["custom_roles"] = [
                CustomRoleRead.model_validate(role, from_attributes=True).model_dump(mode="json")
                for role in custom_roles
            ]
        else:
            member_data["custom_roles"] = []
        
        result.append(member_data)
    
    return result


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
    return _serialize_members(members, db)


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


def _serialize_role(role: CustomRole) -> dict[str, Any]:
    return CustomRoleRead.model_validate(role, from_attributes=True).model_dump(mode="json")


def _serialize_roles(roles: Sequence[CustomRole]) -> list[dict[str, Any]]:
    ordered = sorted(roles, key=lambda item: (item.position, item.name.lower()), reverse=True)
    return [_serialize_role(role) for role in ordered]


def publish_role_created(room_slug: str, role: CustomRole) -> None:
    payload = {
        "type": "role_created",
        "room": room_slug,
        "role": _serialize_role(role),
    }
    _dispatch(room_slug, payload)


def publish_role_updated(room_slug: str, role: CustomRole) -> None:
    payload = {
        "type": "role_updated",
        "room": room_slug,
        "role": _serialize_role(role),
    }
    _dispatch(room_slug, payload)


def publish_role_deleted(room_slug: str, role_id: int) -> None:
    payload = {
        "type": "role_deleted",
        "room": room_slug,
        "role_id": role_id,
    }
    _dispatch(room_slug, payload)


def publish_roles_reordered(room_slug: str, roles: Sequence[CustomRole]) -> None:
    payload = {
        "type": "roles_reordered",
        "room": room_slug,
        "roles": _serialize_roles(roles),
    }
    _dispatch(room_slug, payload)


def publish_user_role_assigned(room_slug: str, user_id: int, role_id: int) -> None:
    payload = {
        "type": "user_role_assigned",
        "room": room_slug,
        "user_id": user_id,
        "role_id": role_id,
    }
    _dispatch(room_slug, payload)


def publish_user_role_removed(room_slug: str, user_id: int, role_id: int) -> None:
    payload = {
        "type": "user_role_removed",
        "room": room_slug,
        "user_id": user_id,
        "role_id": role_id,
    }
    _dispatch(room_slug, payload)


def build_workspace_snapshot(room_id: int, db: Session) -> dict[str, list[dict[str, Any]]]:
    return {
        "channels": _load_channels(room_id, db),
        "categories": _load_categories(room_id, db),
        "members": _load_members(room_id, db),
    }


# Announcement events
def publish_announcement_created(room_slug: str, channel_id: int, announcement_data: dict[str, Any]) -> None:
    """Publish event when an announcement is created."""
    payload = {
        "type": "announcement_created",
        "room": room_slug,
        "channel_id": channel_id,
        "announcement": announcement_data,
    }
    _dispatch(room_slug, payload)


def publish_announcement_cross_posted(
    room_slug: str, channel_id: int, original_message_id: int, cross_posts: list[dict[str, Any]]
) -> None:
    """Publish event when an announcement is cross-posted."""
    payload = {
        "type": "announcement_cross_posted",
        "room": room_slug,
        "channel_id": channel_id,
        "original_message_id": original_message_id,
        "cross_posts": cross_posts,
    }
    _dispatch(room_slug, payload)


# Forum events
def publish_forum_post_created(room_slug: str, channel_id: int, post_data: dict[str, Any]) -> None:
    """Publish event when a forum post is created."""
    payload = {
        "type": "forum_post_created",
        "room": room_slug,
        "channel_id": channel_id,
        "post": post_data,
    }
    _dispatch(room_slug, payload)


def publish_forum_post_updated(room_slug: str, channel_id: int, post_data: dict[str, Any]) -> None:
    """Publish event when a forum post is updated."""
    payload = {
        "type": "forum_post_updated",
        "room": room_slug,
        "channel_id": channel_id,
        "post": post_data,
    }
    _dispatch(room_slug, payload)


def publish_forum_post_deleted(room_slug: str, channel_id: int, post_id: int) -> None:
    """Publish event when a forum post is deleted."""
    payload = {
        "type": "forum_post_deleted",
        "room": room_slug,
        "channel_id": channel_id,
        "post_id": post_id,
    }
    _dispatch(room_slug, payload)


# Event (calendar) events
def publish_event_created(room_slug: str, channel_id: int, event_data: dict[str, Any]) -> None:
    """Publish event when a calendar event is created."""
    payload = {
        "type": "event_created",
        "room": room_slug,
        "channel_id": channel_id,
        "event": event_data,
    }
    _dispatch(room_slug, payload)


def publish_event_updated(room_slug: str, channel_id: int, event_data: dict[str, Any]) -> None:
    """Publish event when a calendar event is updated."""
    payload = {
        "type": "event_updated",
        "room": room_slug,
        "channel_id": channel_id,
        "event": event_data,
    }
    _dispatch(room_slug, payload)


def publish_event_deleted(room_slug: str, channel_id: int, event_id: int) -> None:
    """Publish event when a calendar event is deleted."""
    payload = {
        "type": "event_deleted",
        "room": room_slug,
        "channel_id": channel_id,
        "event_id": event_id,
    }
    _dispatch(room_slug, payload)


def publish_event_rsvp_changed(
    room_slug: str, channel_id: int, event_id: int, user_id: int, rsvp_status: str
) -> None:
    """Publish event when a user's RSVP status changes."""
    payload = {
        "type": "event_rsvp_changed",
        "room": room_slug,
        "channel_id": channel_id,
        "event_id": event_id,
        "user_id": user_id,
        "rsvp_status": rsvp_status,
    }
    _dispatch(room_slug, payload)