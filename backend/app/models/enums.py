from __future__ import annotations

from enum import Enum


class ChannelType(str, Enum):
    """Possible communication channel types."""

    TEXT = "text"
    VOICE = "voice"
    ANNOUNCEMENT = "announcement"


class RoomRole(str, Enum):
    """Roles that a user can have inside a room."""

    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    GUEST = "guest"
