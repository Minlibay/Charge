from __future__ import annotations

from enum import Enum


class ChannelType(str, Enum):
    """Possible communication channel types."""

    TEXT = "text"
    VOICE = "voice"
    STAGE = "stage"
    ANNOUNCEMENTS = "announcements"
    FORUMS = "forums"
    EVENTS = "events"


class ChannelPermission(str, Enum):
    """Granular permissions that can be overridden per channel."""

    VIEW = "view"
    SEND_MESSAGES = "send_messages"
    MANAGE_MESSAGES = "manage_messages"
    CONNECT = "connect"
    SPEAK = "speak"
    MANAGE_CHANNEL = "manage_channel"
    MANAGE_PERMISSIONS = "manage_permissions"
    START_STAGE = "start_stage"
    MANAGE_STAGE = "manage_stage"
    PUBLISH_ANNOUNCEMENTS = "publish_announcements"
    CREATE_FORUM_POSTS = "create_forum_posts"
    MODERATE_FORUM_POSTS = "moderate_forum_posts"
    CREATE_EVENTS = "create_events"
    MANAGE_EVENTS = "manage_events"


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
