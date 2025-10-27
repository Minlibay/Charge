"""FastAPI dependencies for the API layer."""

from typing import Iterable

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.security import decode_access_token
from app.database import get_db
from app.models import RoomMember, RoomRole, RoomRoleHierarchy, User

settings = get_settings()

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Retrieve the current user from the JWT token."""

    return get_user_from_token(token, db)


def get_user_from_token(token: str, db: Session) -> User:
    """Resolve a user from a JWT token or raise an HTTP 401 error."""

    payload = decode_access_token(token)
    sub = payload.get("sub")
    if sub is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )

    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        ) from None

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )
    return user


def get_room_member(room_id: int, user_id: int, db: Session) -> RoomMember | None:
    """Return membership entry for the given user and room if it exists."""

    stmt = select(RoomMember).where(
        RoomMember.room_id == room_id,
        RoomMember.user_id == user_id,
    )
    return db.execute(stmt).scalar_one_or_none()


def require_room_member(room_id: int, user_id: int, db: Session) -> RoomMember:
    """Ensure the user belongs to the room, raising HTTP 403 otherwise."""

    membership = get_room_member(room_id, user_id, db)
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a room member",
        )
    return membership


def get_role_level(room_id: int, role: RoomRole, db: Session) -> int:
    """Retrieve level for a specific role in a room hierarchy."""

    stmt = select(RoomRoleHierarchy.level).where(
        RoomRoleHierarchy.room_id == room_id,
        RoomRoleHierarchy.role == role,
    )
    level = db.execute(stmt).scalar_one_or_none()
    if level is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Role hierarchy is not configured",
        )
    return level


def ensure_minimum_role(
    room_id: int,
    member_role: RoomRole,
    required_roles: Iterable[RoomRole],
    db: Session,
) -> None:
    """Verify that membership role is at least one of the required roles."""

    member_level = get_role_level(room_id, member_role, db)
    required_levels = [get_role_level(room_id, role, db) for role in required_roles]
    if not required_levels:
        return
    threshold = min(required_levels)
    if member_level < threshold:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )


def ensure_role_priority(
    room_id: int,
    actor_role: RoomRole,
    target_role: RoomRole,
    db: Session,
) -> None:
    """Ensure actor role outranks target role according to hierarchy."""

    actor_level = get_role_level(room_id, actor_role, db)
    target_level = get_role_level(room_id, target_role, db)
    if actor_level <= target_level:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot manage members with equal or higher role",
        )
