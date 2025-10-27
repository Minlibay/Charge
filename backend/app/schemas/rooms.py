"""Schemas for room and channel management."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, conint, constr

from app.models import ChannelType, RoomRole


class RoomBase(BaseModel):
    """Common fields shared by room payloads."""

    title: constr(strip_whitespace=True, min_length=1, max_length=128) = Field(
        ..., description="Human readable room title"
    )


class RoomCreate(RoomBase):
    """Payload for creating a new room."""

    pass


class RoomRead(RoomBase):
    """Room representation returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    created_at: datetime
    updated_at: datetime


class ChannelBase(BaseModel):
    """Shared channel fields."""

    name: constr(strip_whitespace=True, min_length=1, max_length=128) = Field(
        ..., description="Channel display name"
    )
    type: ChannelType = Field(..., description="Type of the channel (text or voice)")
    category_id: int | None = Field(
        default=None, description="Identifier of the category the channel belongs to"
    )


class ChannelCreate(ChannelBase):
    """Payload for creating a channel inside a room."""

    pass


class ChannelUpdate(BaseModel):
    """Payload for updating channel attributes."""

    name: constr(strip_whitespace=True, min_length=1, max_length=128) | None = None
    category_id: int | None = None


class ChannelRead(ChannelBase):
    """Representation of a channel returned from the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    letter: str
    created_at: datetime


class RoomDetail(RoomRead):
    """Detailed room response with associated channels."""

    channels: list[ChannelRead] = Field(default_factory=list)
    categories: list["ChannelCategoryRead"] = Field(default_factory=list)
    invitations: list["RoomInvitationRead"] = Field(default_factory=list)
    role_hierarchy: list["RoomRoleLevelRead"] = Field(default_factory=list)
    current_role: RoomRole | None = None


class ChannelCategoryBase(BaseModel):
    """Base fields for channel categories."""

    name: constr(strip_whitespace=True, min_length=1, max_length=128)
    position: conint(ge=0) = Field(default=0)


class ChannelCategoryCreate(ChannelCategoryBase):
    """Payload for creating a new channel category."""

    pass


class ChannelCategoryUpdate(BaseModel):
    """Payload for updating a channel category."""

    name: constr(strip_whitespace=True, min_length=1, max_length=128) | None = None
    position: conint(ge=0) | None = None


class ChannelCategoryRead(ChannelCategoryBase):
    """Representation of a channel category."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class RoomInvitationCreate(BaseModel):
    """Payload for creating a room invitation."""

    role: RoomRole = Field(default=RoomRole.MEMBER)
    expires_at: datetime | None = Field(default=None)


class RoomInvitationRead(RoomInvitationCreate):
    """Representation of a room invitation."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    created_at: datetime
    created_by_id: int | None


class RoomMemberRoleUpdate(BaseModel):
    """Payload for updating a room member role."""

    role: RoomRole


class RoomRoleLevelRead(BaseModel):
    """Role level description within a room."""

    model_config = ConfigDict(from_attributes=True)

    role: RoomRole
    level: int


class RoomRoleLevelUpdate(BaseModel):
    """Payload for updating role level inside a room hierarchy."""

    level: int = Field(..., ge=0)
