"""Schemas for custom roles management."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import RoomPermission


class CustomRoleBase(BaseModel):
    """Base fields for custom role schemas."""

    name: Annotated[str, Field(min_length=1, max_length=128, description="Role display name")]
    color: Annotated[
        str, Field(default="#99AAB5", description="HEX color code for the role (e.g., #FF5733)")
    ]
    icon: str | None = Field(default=None, max_length=512, description="Path to role icon image")
    position: Annotated[int, Field(default=0, ge=0, description="Position for sorting (higher = displayed first)")]
    hoist: bool = Field(
        default=False, description="Whether to display members with this role in a separate section"
    )
    mentionable: bool = Field(default=False, description="Whether this role can be mentioned")
    permissions: list[RoomPermission] = Field(
        default_factory=list, description="List of room-level permissions for this role"
    )

    @field_validator("color")
    @classmethod
    def validate_color(cls, v: str) -> str:
        """Validate HEX color format."""
        if not re.match(r"^#[0-9A-Fa-f]{6}$", v):
            raise ValueError("Color must be a valid HEX color code (e.g., #FF5733)")
        return v.upper()

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        """Strip whitespace from name."""
        return v.strip()


class CustomRoleCreate(CustomRoleBase):
    """Payload for creating a new custom role."""

    pass


class CustomRoleUpdate(BaseModel):
    """Payload for updating a custom role."""

    name: Annotated[str | None, Field(default=None, min_length=1, max_length=128)] = None
    color: Annotated[str | None, Field(default=None)] = None
    icon: str | None = None
    position: Annotated[int | None, Field(default=None, ge=0)] = None
    hoist: bool | None = None
    mentionable: bool | None = None
    permissions: list[RoomPermission] | None = None

    @field_validator("color")
    @classmethod
    def validate_color(cls, v: str | None) -> str | None:
        """Validate HEX color format."""
        if v is None:
            return v
        if not re.match(r"^#[0-9A-Fa-f]{6}$", v):
            raise ValueError("Color must be a valid HEX color code (e.g., #FF5733)")
        return v.upper()

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str | None) -> str | None:
        """Strip whitespace from name."""
        if v is None:
            return v
        return v.strip()


class CustomRoleRead(CustomRoleBase):
    """Serialized custom role representation."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    room_id: int
    created_at: datetime
    updated_at: datetime


class CustomRoleReorderEntry(BaseModel):
    """Entry for reordering custom roles."""

    id: int
    position: Annotated[int, Field(ge=0)]


class CustomRoleReorderPayload(BaseModel):
    """Payload for reordering custom roles within a room."""

    roles: list[CustomRoleReorderEntry] = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_unique_positions(self) -> "CustomRoleReorderPayload":
        """Ensure all positions are unique."""
        positions = [role.position for role in self.roles]
        if len(positions) != len(set(positions)):
            raise ValueError("All role positions must be unique")
        return self


class UserRoleAssignment(BaseModel):
    """Payload for assigning a role to a user."""

    role_id: int = Field(..., description="ID of the custom role to assign")


class CustomRoleWithMemberCount(CustomRoleRead):
    """Custom role with member count information."""

    member_count: int = Field(default=0, description="Number of users with this role")

