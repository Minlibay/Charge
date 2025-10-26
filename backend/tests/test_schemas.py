"""Unit tests validating Pydantic schema constraints."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models import ChannelType
from app.schemas import ChannelCreate, RoomCreate, UserCreate


def test_room_create_strips_whitespace():
    room = RoomCreate(title="  Planning Room  ")
    assert room.title == "Planning Room"


def test_channel_create_requires_non_empty_name():
    with pytest.raises(ValidationError):
        ChannelCreate(name="   ", type=ChannelType.TEXT)


def test_user_create_enforces_password_length():
    with pytest.raises(ValidationError):
        UserCreate(login="bob", password="short", display_name="Bob")
