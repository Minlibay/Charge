"""Unit tests for room and channel business logic."""

from __future__ import annotations

from string import ascii_uppercase

import pytest
from fastapi import HTTPException

from app.api.rooms import _ensure_admin, create_channel
from app.models import (
    Channel,
    ChannelType,
    Room,
    RoomMember,
    RoomRole,
    RoomRoleHierarchy,
    User,
)
from app.schemas import ChannelCreate


@pytest.fixture()
def owner(db_session):
    user = User(login="owner", hashed_password="hashed", display_name="Owner")
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture()
def room(db_session, owner):
    room = Room(title="Strategy Room", slug="strategy-room")
    db_session.add(room)
    db_session.commit()
    membership = RoomMember(room_id=room.id, user_id=owner.id, role=RoomRole.OWNER)
    db_session.add(membership)
    for role, level in (
        (RoomRole.OWNER, 400),
        (RoomRole.ADMIN, 300),
        (RoomRole.MEMBER, 200),
        (RoomRole.GUEST, 100),
    ):
        db_session.add(RoomRoleHierarchy(room_id=room.id, role=role, level=level))
    db_session.commit()
    return room


def test_create_channel_assigns_next_available_letter(db_session, owner, room):
    """The first free letter should be assigned when creating a new channel."""

    existing = Channel(
        room_id=room.id,
        name="General",
        type=ChannelType.TEXT,
        letter="A",
    )
    db_session.add(existing)
    db_session.commit()

    payload = ChannelCreate(name="Announcements", type=ChannelType.TEXT)
    channel = create_channel(room.slug, payload, db_session, owner)

    assert channel.letter == "B"
    assert channel.room_id == room.id


def test_create_channel_raises_when_no_letters_available(db_session, owner, room):
    """Attempting to create a channel with no free letters should raise an error."""

    for letter in ascii_uppercase:
        db_session.add(
            Channel(
                room_id=room.id,
                name=f"Channel {letter}",
                type=ChannelType.TEXT,
                letter=letter,
            )
        )
    db_session.commit()

    payload = ChannelCreate(name="Overflow", type=ChannelType.TEXT)
    with pytest.raises(HTTPException) as exc:
        create_channel(room.slug, payload, db_session, owner)

    assert exc.value.status_code == 400
    assert "No available channel slots" in exc.value.detail


def test_require_admin_enforces_permissions(db_session, owner, room):
    """Non-admin members should be blocked from administrative actions."""

    member = RoomMember(room_id=room.id, user_id=999, role=RoomRole.MEMBER)

    with pytest.raises(HTTPException) as exc:
        _ensure_admin(room.id, member, db_session)

    assert exc.value.status_code == 403
    assert "Insufficient permissions" in exc.value.detail

    admin_member = RoomMember(room_id=room.id, user_id=1000, role=RoomRole.ADMIN)
    _ensure_admin(room.id, admin_member, db_session)
