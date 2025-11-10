"""Constants for API modules."""

from __future__ import annotations

from app.models import ChannelType

TEXT_CHANNEL_TYPES: set[ChannelType] = {
    ChannelType.TEXT,
    ChannelType.ANNOUNCEMENTS,
    ChannelType.FORUMS,
    ChannelType.EVENTS,
}

VOICE_CHANNEL_TYPES: set[ChannelType] = {ChannelType.VOICE, ChannelType.STAGE}

ALLOWED_CHANNEL_TYPES: set[ChannelType] = TEXT_CHANNEL_TYPES | VOICE_CHANNEL_TYPES

