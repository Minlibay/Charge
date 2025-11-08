"""Schemas for authentication endpoints."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, constr

from app.models.enums import PresenceStatus


class UserBase(BaseModel):
    """Base fields shared across user schemas."""

    login: constr(min_length=3, max_length=64) = Field(
        ..., description="Unique user login consisting of 3-64 characters"
    )
    display_name: constr(strip_whitespace=True, min_length=1, max_length=128) | None = Field(
        default=None, description="Optional display name to show in the UI"
    )
    status: PresenceStatus = Field(
        default=PresenceStatus.ONLINE,
        description="Current presence status for the user",
    )


class UserCreate(UserBase):
    """Payload for creating a new user via registration."""

    password: constr(min_length=8, max_length=128) = Field(
        ..., description="Plain text password that will be hashed before storing"
    )


class UserRead(UserBase):
    """Representation of a user returned from the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime
    avatar_url: str | None = None


class LoginRequest(BaseModel):
    """Payload for user login."""

    login: constr(min_length=3, max_length=64) = Field(..., description="User login")
    password: constr(min_length=8, max_length=128) = Field(..., description="User password")
    remember_me: bool = Field(
        default=False,
        description="Request a long-lived refresh token (stored in an HttpOnly cookie)",
    )


class Token(BaseModel):
    """Access token returned after successful authentication."""

    access_token: str = Field(..., description="JWT access token")
    token_type: str = Field(default="bearer", description="Token type, always 'bearer'")
    refresh_token: str | None = Field(
        default=None,
        description="Opaque refresh token identifier (also set as an HttpOnly cookie)",
    )
    expires_in: int | None = Field(
        default=None,
        description="Number of seconds until the access token expires",
    )


class RefreshRequest(BaseModel):
    """Payload for requesting a new access token using a refresh token."""

    refresh_token: str | None = Field(
        default=None,
        description="Optional refresh token value when cookies are unavailable",
    )
