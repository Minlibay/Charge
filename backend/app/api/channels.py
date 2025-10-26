"""Channel-specific API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.config import get_settings
from app.database import get_db
from app.models import Channel, ChannelType, Message, RoomMember, User
from app.schemas import MessageRead

router = APIRouter(prefix="/channels", tags=["channels"])

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


def _ensure_membership(channel: Channel, user: User, db: Session) -> None:
    membership_stmt = select(RoomMember.id).where(
        RoomMember.room_id == channel.room_id,
        RoomMember.user_id == user.id,
    )
    membership = db.execute(membership_stmt).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a room member")


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
    _ensure_membership(channel, current_user, db)

    effective_limit = limit or settings.chat_history_default_limit
    effective_limit = min(effective_limit, settings.chat_history_max_limit)

    return fetch_channel_history(channel_id, effective_limit, db)
