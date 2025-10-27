"""Schemas related to chat messages."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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
    content: str
    created_at: datetime
    parent_id: int | None = None
    thread_root_id: int | None = None
    reply_count: int = 0
    thread_reply_count: int = 0
    attachments: list[MessageAttachmentRead] = []
    reactions: list[MessageReactionSummary] = []

    class Config:
        from_attributes = True


class ReactionRequest(BaseModel):
    """Payload for adding or removing a reaction."""

    emoji: str = Field(..., min_length=1, max_length=32)
