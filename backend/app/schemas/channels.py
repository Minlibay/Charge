"""Schemas for channel permission overwrites."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models import ChannelPermission, PresenceStatus, RoomRole

if TYPE_CHECKING:
    from app.schemas.messages import MessageAuthor, MessageRead


class ChannelPermissionPayload(BaseModel):
    """Payload for creating or updating permission overwrites."""

    allow: list[ChannelPermission] = Field(default_factory=list)
    deny: list[ChannelPermission] = Field(default_factory=list)

    @model_validator(mode="after")
    def ensure_disjoint(self) -> "ChannelPermissionPayload":
        allow_set = set(self.allow)
        deny_set = set(self.deny)
        if allow_set & deny_set:
            raise ValueError("Allow and deny permissions cannot overlap")
        return self


class ChannelPermissionRoleRead(ChannelPermissionPayload):
    """Serialized role overwrite entry."""

    model_config = ConfigDict(from_attributes=True)

    role: RoomRole


class ChannelPermissionUserRead(ChannelPermissionPayload):
    """Serialized user overwrite entry including profile details."""

    model_config = ConfigDict(from_attributes=True)

    user_id: int
    login: str
    display_name: str | None
    avatar_url: str | None
    status: PresenceStatus


class ChannelPermissionSummary(BaseModel):
    """Aggregated permission overwrite listing."""

    channel_id: int
    roles: list[ChannelPermissionRoleRead] = Field(default_factory=list)
    users: list[ChannelPermissionUserRead] = Field(default_factory=list)


class AnnouncementCreate(BaseModel):
    """Payload for creating an announcement."""

    content: str = Field(..., min_length=1, description="Announcement content")


class CrossPostRequest(BaseModel):
    """Payload for cross-posting an announcement to other channels."""

    target_channel_ids: list[int] = Field(..., min_length=1, description="List of channel IDs to cross-post to")


class CrossPostRead(BaseModel):
    """Information about a cross-posted announcement."""

    target_channel_id: int
    cross_posted_message_id: int
    created_at: datetime


# Forum schemas
class ForumPostCreate(BaseModel):
    """Payload for creating a forum post."""

    title: str = Field(..., min_length=1, max_length=256, description="Post title")
    content: str = Field(..., min_length=1, description="Post content (first message)")
    tag_names: list[str] = Field(default_factory=list, max_length=5, description="Tag names for the post")


class ForumPostUpdate(BaseModel):
    """Payload for updating a forum post."""

    title: str | None = Field(None, min_length=1, max_length=256, description="Post title")
    content: str | None = Field(None, min_length=1, description="Post content")


class ForumPostRead(BaseModel):
    """Serialized representation of a forum post."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    channel_id: int
    message_id: int
    title: str
    author_id: int
    is_pinned: bool
    is_archived: bool
    is_locked: bool
    reply_count: int
    last_reply_at: datetime | None
    last_reply_by_id: int | None
    created_at: datetime
    updated_at: datetime
    tags: list[str] = Field(default_factory=list)


class ForumPostDetailRead(ForumPostRead):
    """Detailed forum post with message and author information."""

    message: "MessageRead"  # type: ignore[name-defined]
    author: "MessageAuthor"  # type: ignore[name-defined]
    last_reply_by: "MessageAuthor | None" = None  # type: ignore[name-defined]


class ForumPostListPage(BaseModel):
    """Paginated list of forum posts."""

    items: list[ForumPostRead]
    total: int
    page: int
    page_size: int
    has_more: bool


class ForumChannelTagCreate(BaseModel):
    """Payload for creating a forum channel tag."""

    name: str = Field(..., min_length=1, max_length=64, description="Tag name")
    color: str = Field(default="#99AAB5", pattern="^#[0-9A-Fa-f]{6}$", description="Tag color (HEX)")
    emoji: str | None = Field(None, max_length=32, description="Tag emoji")


class ForumChannelTagUpdate(BaseModel):
    """Payload for updating a forum channel tag."""

    name: str | None = Field(None, min_length=1, max_length=64, description="Tag name")
    color: str | None = Field(None, pattern="^#[0-9A-Fa-f]{6}$", description="Tag color (HEX)")
    emoji: str | None = Field(None, max_length=32, description="Tag emoji")


class ForumChannelTagRead(BaseModel):
    """Serialized representation of a forum channel tag."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    channel_id: int
    name: str
    color: str
    emoji: str | None
    created_at: datetime