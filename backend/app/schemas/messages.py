"""Schemas related to chat messages."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.models.enums import PresenceStatus


class MessageAuthor(BaseModel):
    """Lightweight author information for displaying messages."""

    id: int
    login: str
    display_name: str | None = None
    avatar_url: str | None = None
    status: PresenceStatus = PresenceStatus.ONLINE


class MessageReactionSummary(BaseModel):
    """Aggregated reaction information for a message."""

    emoji: str = Field(..., description="Emoji identifier, e.g. 😀 or :thumbsup:")
    count: int = Field(..., ge=0, description="Total reactions with the emoji")
    reacted: bool = Field(
        default=False,
        description="Indicates whether the current user added this reaction",
    )
    user_ids: list[int] = Field(
        default_factory=list,
        description="Identifiers of users who added this reaction",
    )


class MessageAttachmentRead(BaseModel):
    """Serialized representation of a message attachment."""

    id: int
    channel_id: int
    message_id: int | None
    file_name: str
    content_type: str | None
    file_size: int
    download_url: str
    preview_url: str | None = None
    uploaded_by: int | None = None
    created_at: datetime


class MessageRead(BaseModel):
    """Serialized representation of a chat message."""

    id: int
    channel_id: int
    author_id: int | None
    author: MessageAuthor | None = None
    content: str
    created_at: datetime
    updated_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None
    moderated_at: datetime | None = None
    moderation_note: str | None = None
    moderated_by: MessageAuthor | None = None
    parent_id: int | None = None
    thread_root_id: int | None = None
    reply_count: int = 0
    thread_reply_count: int = 0
    attachments: list[MessageAttachmentRead] = []
    reactions: list[MessageReactionSummary] = []
    delivered_count: int = Field(0, ge=0)
    read_count: int = Field(0, ge=0)
    delivered_at: datetime | None = None
    read_at: datetime | None = None

    class Config:
        from_attributes = True


class ReactionRequest(BaseModel):
    """Payload for adding or removing a reaction."""

    emoji: str = Field(..., min_length=1, max_length=32)


class MessageReceiptUpdate(BaseModel):
    """Payload for updating delivery and read status for a message."""

    delivered: bool | None = Field(
        default=None,
        description="Set to true to mark the message as delivered for the current user.",
    )
    read: bool | None = Field(
        default=None,
        description="Set to true to mark the message as read for the current user.",
    )

    @model_validator(mode="after")
    def ensure_any_flag(cls, values: "MessageReceiptUpdate") -> "MessageReceiptUpdate":
        if not values.delivered and not values.read:
            raise ValueError("At least one of delivered or read must be provided")
        return values
