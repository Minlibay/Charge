"""Room management API endpoints."""

from __future__ import annotations

from string import ascii_uppercase

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.core.slug import unique_slug
from app.database import get_db
from app.models import Channel, ChannelType, Room, RoomMember, RoomRole, User
from app.schemas import ChannelCreate, ChannelRead, RoomCreate, RoomDetail, RoomRead

router = APIRouter(prefix="/rooms", tags=["rooms"])


def _ensure_room_exists(slug: str, db: Session) -> Room:
    room = db.execute(
        select(Room).where(Room.slug == slug).options(selectinload(Room.channels))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


def _ensure_membership(room: Room, user: User, db: Session) -> RoomMember | None:
    membership_stmt = select(RoomMember).where(
        RoomMember.room_id == room.id, RoomMember.user_id == user.id
    )
    return db.execute(membership_stmt).scalar_one_or_none()


def _require_admin(membership: RoomMember | None) -> None:
    if membership is None or membership.role not in {RoomRole.OWNER, RoomRole.ADMIN}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )


@router.post("", response_model=RoomRead, status_code=status.HTTP_201_CREATED)
def create_room(
    payload: RoomCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Room:
    """Create a new room with the current user as the owner."""

    def slug_exists(candidate: str) -> bool:
        return (
            db.execute(select(Room.id).where(Room.slug == candidate)).scalar_one_or_none()
            is not None
        )

    slug = unique_slug(payload.title, slug_exists)

    room = Room(title=payload.title, slug=slug)
    db.add(room)
    db.flush()

    owner_membership = RoomMember(room_id=room.id, user_id=current_user.id, role=RoomRole.OWNER)
    db.add(owner_membership)

    db.commit()
    db.refresh(room)
    return room


@router.get("/{slug}", response_model=RoomDetail)
def get_room(
    slug: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomDetail:
    """Retrieve room information together with its channels."""

    room = _ensure_room_exists(slug, db)
    membership = _ensure_membership(room, current_user, db)
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a room member")

    room.channels.sort(key=lambda channel: channel.letter)
    return RoomDetail.model_validate(room, from_attributes=True)


@router.post("/{slug}/channels", response_model=ChannelRead, status_code=status.HTTP_201_CREATED)
def create_channel(
    slug: str,
    payload: ChannelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Channel:
    """Create a new channel inside the specified room."""

    room = _ensure_room_exists(slug, db)
    membership = _ensure_membership(room, current_user, db)
    _require_admin(membership)

    if payload.type not in {ChannelType.TEXT, ChannelType.VOICE}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only text or voice channels can be created",
        )

    existing_letters = {
        letter
        for (letter,) in db.execute(select(Channel.letter).where(Channel.room_id == room.id))
    }
    free_letter = next((letter for letter in ascii_uppercase if letter not in existing_letters), None)
    if free_letter is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No available channel slots left",
        )

    channel = Channel(
        room_id=room.id,
        name=payload.name,
        type=payload.type,
        letter=free_letter,
    )
    db.add(channel)
    db.commit()
    db.refresh(channel)
    return channel


@router.delete(
    "/{slug}/channels/{letter}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
def delete_channel(
    slug: str,
    letter: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete a channel identified by its letter inside the room."""

    room = _ensure_room_exists(slug, db)
    membership = _ensure_membership(room, current_user, db)
    _require_admin(membership)

    normalized_letter = letter.upper()
    if len(normalized_letter) != 1 or normalized_letter not in ascii_uppercase:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid channel letter")
    channel_stmt = select(Channel).where(
        Channel.room_id == room.id, Channel.letter == normalized_letter
    )
    channel = db.execute(channel_stmt).scalar_one_or_none()
    if channel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")

    db.delete(channel)
    db.commit()
