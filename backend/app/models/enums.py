from __future__ import annotations

from enum import Enum


class ChannelType(str, Enum):
    """Possible communication channel types."""

    TEXT = "text"
    VOICE = "voice"
    ANNOUNCEMENT = "announcement"


class ChannelPermission(str, Enum):
    """Granular permissions that can be overridden per channel."""

    VIEW = "view"
    SEND_MESSAGES = "send_messages"
    MANAGE_MESSAGES = "manage_messages"
    CONNECT = "connect"
    SPEAK = "speak"


class RoomRole(str, Enum):
    """Roles that a user can have inside a room."""

    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    GUEST = "guest"


class PresenceStatus(str, Enum):
    """User-configurable presence indicator."""

    ONLINE = "online"
    IDLE = "idle"
    DND = "dnd"


class FriendRequestStatus(str, Enum):
    """Lifecycle states for friend relationships."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
