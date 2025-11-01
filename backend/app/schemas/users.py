"""Schemas related to user profiles and friendships."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, constr

from app.models.enums import FriendRequestStatus, PresenceStatus


class PublicUser(BaseModel):
    """Minimal public-facing user information."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    login: str
    display_name: str | None = None
    avatar_url: str | None = None
    status: PresenceStatus = PresenceStatus.ONLINE


class UserProfileRead(PublicUser):
    """Detailed representation of the current user profile."""

    created_at: datetime
    updated_at: datetime


class UserProfileUpdate(BaseModel):
    """Payload for updating profile preferences."""

    display_name: constr(strip_whitespace=True, min_length=1, max_length=128) | None = Field(
        default=None,
        description="New display name to use. Pass null to reset to login.",
    )
    status: PresenceStatus | None = Field(
        default=None,
        description="Optional new presence status.",
    )


class FriendRequestRead(BaseModel):
    """Serialized friend request including participants."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    requester: PublicUser
    addressee: PublicUser
    status: FriendRequestStatus
    created_at: datetime
    responded_at: datetime | None = None


class FriendRequestList(BaseModel):
    """Categorized friend requests for convenience in the UI."""

    incoming: list[FriendRequestRead] = Field(default_factory=list)
    outgoing: list[FriendRequestRead] = Field(default_factory=list)


class FriendRequestCreate(BaseModel):
    """Payload for sending a friend request."""

    login: constr(min_length=3, max_length=64) = Field(..., description="Target user login")


class DirectMessageRead(BaseModel):
    """Representation of a direct message."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: int
    sender_id: int
    recipient_id: int | None = None
    content: str
    created_at: datetime
    read_at: datetime | None = None
    sender: PublicUser


class DirectConversationParticipantRead(BaseModel):
    """Details about a user participating in a direct conversation."""

    model_config = ConfigDict(from_attributes=True)

    user: PublicUser
    nickname: str | None = None
    note: str | None = None
    joined_at: datetime
    last_read_at: datetime | None = None


class DirectConversationRead(BaseModel):
    """Summary of a direct conversation including participants."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str | None = None
    is_group: bool = False
    participants: list[DirectConversationParticipantRead]
    last_message: DirectMessageRead | None = None
    unread_count: int = 0


class DirectConversationCreate(BaseModel):
    """Payload for creating a new direct conversation."""

    participant_ids: list[int] = Field(..., description="List of user IDs to include")
    title: constr(strip_whitespace=True, min_length=1, max_length=128) | None = None


class DirectConversationNoteUpdate(BaseModel):
    """Payload for updating personal note within a conversation."""

    note: constr(strip_whitespace=True, max_length=2000) | None = Field(
        default=None,
        description="Custom note visible only to the current user",
    )


class DirectMessageCreate(BaseModel):
    """Payload for sending a new direct message."""

    content: constr(strip_whitespace=True, min_length=1, max_length=2000)
