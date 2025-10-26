"""Schemas for room and channel management."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, constr

from app.models import ChannelType


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


class ChannelCreate(ChannelBase):
    """Payload for creating a channel inside a room."""

    pass


class ChannelRead(ChannelBase):
    """Representation of a channel returned from the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    letter: str
    created_at: datetime


class RoomDetail(RoomRead):
    """Detailed room response with associated channels."""

    channels: list[ChannelRead] = Field(default_factory=list)
