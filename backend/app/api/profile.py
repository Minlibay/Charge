"""Profile management API endpoints."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.storage import resolve_path, store_user_avatar
from app.database import get_db
from app.models import FriendLink, FriendRequestStatus, User
from app.schemas import UserProfileRead, UserProfileUpdate
from app.services.presence import presence_hub
from app.api.ws import presence_manager

router = APIRouter(prefix="/profile", tags=["profile"])


def _friend_ids(user_id: int, db: Session) -> list[int]:
    stmt = select(FriendLink).where(
        FriendLink.status == FriendRequestStatus.ACCEPTED,
        ((FriendLink.requester_id == user_id) | (FriendLink.addressee_id == user_id)),
    )
    links = db.execute(stmt).scalars().all()
    friend_ids: list[int] = []
    for link in links:
        if link.requester_id == user_id:
            friend_ids.append(link.addressee_id)
        else:
            friend_ids.append(link.requester_id)
    return friend_ids


async def _broadcast_presence(user: User, friend_ids: list[int]) -> None:
    payload = {
        "type": "status",
        "user": {
            "id": user.id,
            "login": user.login,
            "display_name": user.display_name or user.login,
            "avatar_url": user.avatar_url,
            "status": user.presence_status.value,
        },
    }
    recipients = [user.id, *friend_ids]
    await presence_hub.broadcast(payload, recipients)


@router.get("/me", response_model=UserProfileRead)
async def read_profile(current_user: User = Depends(get_current_user)) -> UserProfileRead:
    """Return profile information for the authenticated user."""

    return UserProfileRead.model_validate(current_user, from_attributes=True)


@router.patch("", response_model=UserProfileRead)
async def update_profile(
    payload: UserProfileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UserProfileRead:
    """Update mutable profile fields for the current user."""

    dirty = False
    if payload.display_name is not None:
        current_user.display_name = payload.display_name or None
        dirty = True
    if payload.status is not None:
        current_user.presence_status = payload.status
        dirty = True

    if dirty:
        db.add(current_user)
        db.commit()
        db.refresh(current_user)
        friend_ids = _friend_ids(current_user.id, db)
        await presence_manager.refresh_user(current_user)
        await _broadcast_presence(current_user, friend_ids)

    return UserProfileRead.model_validate(current_user, from_attributes=True)


@router.post("/avatar", response_model=UserProfileRead)
async def upload_avatar(
    avatar: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UserProfileRead:
    """Store a new avatar image for the user."""

    stored = await store_user_avatar(current_user.id, avatar)
    current_user.avatar_path = stored.relative_path
    current_user.avatar_content_type = stored.content_type
    current_user.avatar_updated_at = datetime.now(timezone.utc)
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    friend_ids = _friend_ids(current_user.id, db)
    await presence_manager.refresh_user(current_user)
    await _broadcast_presence(current_user, friend_ids)
    return UserProfileRead.model_validate(current_user, from_attributes=True)


@router.get("/avatar/{user_id}")
async def fetch_avatar(user_id: int, db: Session = Depends(get_db)) -> FileResponse:
    """Serve a stored avatar image for a user."""

    user = db.get(User, user_id)
    if user is None or not user.avatar_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    absolute_path = resolve_path(user.avatar_path)
    return FileResponse(
        absolute_path,
        media_type=user.avatar_content_type or "application/octet-stream",
    )
