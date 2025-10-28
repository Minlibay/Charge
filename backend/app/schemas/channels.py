"""Schemas for channel permission overwrites."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models import ChannelPermission, PresenceStatus, RoomRole


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
