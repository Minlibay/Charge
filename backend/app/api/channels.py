"""Channel-specific API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import ensure_minimum_role, get_current_user, require_room_member
from app.config import get_settings
from app.database import get_db
from app.models import Channel, ChannelCategory, ChannelType, Message, RoomRole, User
from app.schemas import ChannelRead, ChannelUpdate, MessageRead

router = APIRouter(prefix="/channels", tags=["channels"])

ADMIN_ROLES: tuple[RoomRole, ...] = (RoomRole.OWNER, RoomRole.ADMIN)

settings = get_settings()


def _get_channel(channel_id: int, db: Session) -> Channel:
    channel_stmt = select(Channel).where(Channel.id == channel_id)
    channel = db.execute(channel_stmt).scalar_one_or_none()
    if channel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")
    return channel


def _ensure_text_channel(channel: Channel) -> None:
    if channel.type != ChannelType.TEXT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="History is only available for text channels",
        )


def fetch_channel_history(channel_id: int, limit: int, db: Session) -> list[MessageRead]:
    stmt = (
        select(Message)
        .where(Message.channel_id == channel_id)
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    messages = list(db.execute(stmt).scalars())
    # Return messages in chronological order
    messages.reverse()
    return [MessageRead.model_validate(message, from_attributes=True) for message in messages]


@router.get("/{channel_id}/history", response_model=list[MessageRead])
def get_channel_history(
    channel_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    limit: int | None = Query(default=None, ge=1),
) -> list[MessageRead]:
    """Return the latest messages from a channel."""

    channel = _get_channel(channel_id, db)
    _ensure_text_channel(channel)
    require_room_member(channel.room_id, current_user.id, db)

    effective_limit = limit or settings.chat_history_default_limit
    effective_limit = min(effective_limit, settings.chat_history_max_limit)

    return fetch_channel_history(channel_id, effective_limit, db)


@router.patch("/{channel_id}", response_model=ChannelRead)
def update_channel(
    channel_id: int,
    payload: ChannelUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Channel:
    """Update mutable channel attributes such as name or category."""

    channel = _get_channel(channel_id, db)
    membership = require_room_member(channel.room_id, current_user.id, db)
    ensure_minimum_role(channel.room_id, membership.role, ADMIN_ROLES, db)

    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        channel.name = update_data["name"]
    if "category_id" in update_data:
        category_id = update_data["category_id"]
        if category_id is None:
            channel.category_id = None
        else:
            category = db.get(ChannelCategory, category_id)
            if category is None or category.room_id != channel.room_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Category not found",
                )
            channel.category_id = category.id

    db.commit()
    db.refresh(channel)
    return channel
