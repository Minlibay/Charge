"""Schemas related to chat messages."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class MessageRead(BaseModel):
    """Serialized representation of a chat message."""

    id: int
    channel_id: int
    author_id: int | None
    content: str
    created_at: datetime

    class Config:
        from_attributes = True
