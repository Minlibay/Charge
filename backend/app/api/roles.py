"""API endpoints for custom roles management."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_room_member, require_room_member
from app.database import get_db
from app.models import (
    CustomRole,
    Room,
    RoomMember,
    RoomPermission,
    RoomRole,
    User,
    UserCustomRole,
    decode_room_permissions,
    encode_room_permissions,
)
from app.schemas import (
    CustomRoleCreate,
    CustomRoleRead,
    CustomRoleReorderEntry,
    CustomRoleReorderPayload,
    CustomRoleUpdate,
    CustomRoleWithMemberCount,
    UserRoleAssignment,
)
from app.services.workspace_events import (
    publish_role_created,
    publish_role_deleted,
    publish_roles_reordered,
    publish_role_updated,
    publish_user_role_assigned,
    publish_user_role_removed,
)

router = APIRouter(prefix="/rooms", tags=["roles"])

ADMIN_ROLES: tuple[RoomRole, ...] = (RoomRole.OWNER, RoomRole.ADMIN)


def _ensure_room_exists(slug: str, db: Session) -> Room:
    """Ensure room exists and return it."""
    stmt = select(Room).where(Room.slug == slug)
    room = db.execute(stmt).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


def _ensure_custom_role_exists(role_id: int, room_id: int, db: Session) -> CustomRole:
    """Ensure custom role exists in the room and return it."""
    stmt = select(CustomRole).where(
        CustomRole.id == role_id, CustomRole.room_id == room_id
    )
    role = db.execute(stmt).scalar_one_or_none()
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Custom role not found"
        )
    return role


def _can_manage_roles(user_id: int, room_id: int, db: Session) -> bool:
    """Check if user can manage roles (has MANAGE_ROLES permission or is ADMIN/OWNER)."""
    membership = get_room_member(room_id, user_id, db)
    if membership is None:
        return False
    if membership.role in ADMIN_ROLES:
        return True

    # Check custom roles for MANAGE_ROLES permission
    stmt = (
        select(CustomRole)
        .join(UserCustomRole, UserCustomRole.custom_role_id == CustomRole.id)
        .where(
            UserCustomRole.user_id == user_id,
            CustomRole.room_id == room_id,
        )
    )
    user_roles = db.execute(stmt).scalars().all()
    for role in user_roles:
        permissions = decode_room_permissions(role.permissions_mask)
        if RoomPermission.MANAGE_ROLES in permissions:
            return True
    return False


@router.post(
    "/{slug}/roles",
    response_model=CustomRoleRead,
    status_code=status.HTTP_201_CREATED,
)
def create_custom_role(
    slug: str,
    payload: CustomRoleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CustomRoleRead:
    """Create a new custom role in the room."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    # Check permissions
    if not _can_manage_roles(current_user.id, room.id, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to manage roles",
        )

    # Get max position
    stmt = select(func.coalesce(func.max(CustomRole.position), -1)).where(
        CustomRole.room_id == room.id
    )
    max_position = db.execute(stmt).scalar_one() + 1

    # Create role
    role = CustomRole(
        room_id=room.id,
        name=payload.name,
        color=payload.color,
        icon=payload.icon,
        position=max_position,
        hoist=payload.hoist,
        mentionable=payload.mentionable,
    )
    role.permissions = payload.permissions

    try:
        db.add(role)
        db.commit()
        db.refresh(role)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Role with name '{payload.name}' already exists in this room",
        )

    publish_role_created(room.slug, role)
    return CustomRoleRead.model_validate(role, from_attributes=True)


@router.get("/{slug}/roles", response_model=list[CustomRoleWithMemberCount])
def list_custom_roles(
    slug: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CustomRoleWithMemberCount]:
    """List all custom roles in the room."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    stmt = (
        select(CustomRole)
        .where(CustomRole.room_id == room.id)
        .order_by(CustomRole.position.desc())
    )
    roles = db.execute(stmt).scalars().all()

    # Get member counts
    result = []
    for role in roles:
        member_count_stmt = select(func.count(UserCustomRole.id)).where(
            UserCustomRole.custom_role_id == role.id
        )
        member_count = db.execute(member_count_stmt).scalar_one()

        role_data = CustomRoleRead.model_validate(role, from_attributes=True)
        result.append(
            CustomRoleWithMemberCount(
                **role_data.model_dump(), member_count=member_count
            )
        )

    return result


@router.get("/{slug}/roles/{role_id}", response_model=CustomRoleRead)
def get_custom_role(
    slug: str,
    role_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CustomRoleRead:
    """Get a specific custom role."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)
    role = _ensure_custom_role_exists(role_id, room.id, db)
    return CustomRoleRead.model_validate(role, from_attributes=True)


@router.patch("/{slug}/roles/{role_id}", response_model=CustomRoleRead)
def update_custom_role(
    slug: str,
    role_id: int,
    payload: CustomRoleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CustomRoleRead:
    """Update a custom role."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    if not _can_manage_roles(current_user.id, room.id, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to manage roles",
        )

    role = _ensure_custom_role_exists(role_id, room.id, db)

    # Update fields
    if payload.name is not None:
        role.name = payload.name
    if payload.color is not None:
        role.color = payload.color
    if payload.icon is not None:
        role.icon = payload.icon
    if payload.position is not None:
        role.position = payload.position
    if payload.hoist is not None:
        role.hoist = payload.hoist
    if payload.mentionable is not None:
        role.mentionable = payload.mentionable
    if payload.permissions is not None:
        role.permissions = payload.permissions

    try:
        db.commit()
        db.refresh(role)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Role with name '{payload.name}' already exists in this room",
        )

    publish_role_updated(room.slug, role)
    return CustomRoleRead.model_validate(role, from_attributes=True)


@router.delete("/{slug}/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_custom_role(
    slug: str,
    role_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    response: Response = None,
) -> Response:
    """Delete a custom role."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    if not _can_manage_roles(current_user.id, room.id, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to manage roles",
        )

    role = _ensure_custom_role_exists(role_id, room.id, db)
    db.delete(role)
    db.commit()

    publish_role_deleted(room.slug, role_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{slug}/roles/reorder", status_code=status.HTTP_204_NO_CONTENT)
def reorder_custom_roles(
    slug: str,
    payload: CustomRoleReorderPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    response: Response = None,
) -> Response:
    """Reorder custom roles within a room."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    if not _can_manage_roles(current_user.id, room.id, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to manage roles",
        )

    # Verify all roles belong to this room
    role_ids = {entry.id for entry in payload.roles}
    stmt = select(CustomRole).where(
        CustomRole.id.in_(role_ids), CustomRole.room_id == room.id
    )
    existing_roles = {role.id for role in db.execute(stmt).scalars().all()}
    if role_ids != existing_roles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Some roles do not belong to this room",
        )

    # Update positions
    for entry in payload.roles:
        stmt = select(CustomRole).where(CustomRole.id == entry.id)
        role = db.execute(stmt).scalar_one()
        role.position = entry.position

    db.commit()

    # Reload roles for event
    stmt = (
        select(CustomRole)
        .where(CustomRole.room_id == room.id)
        .order_by(CustomRole.position.desc())
    )
    roles = db.execute(stmt).scalars().all()
    publish_roles_reordered(room.slug, roles)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{slug}/members/{user_id}/roles/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def assign_role_to_user(
    slug: str,
    user_id: int,
    role_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    response: Response = None,
) -> Response:
    """Assign a custom role to a user."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)
    require_room_member(room.id, user_id, db)

    if not _can_manage_roles(current_user.id, room.id, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to manage roles",
        )

    role = _ensure_custom_role_exists(role_id, room.id, db)

    # Check if already assigned
    stmt = select(UserCustomRole).where(
        UserCustomRole.user_id == user_id, UserCustomRole.custom_role_id == role_id
    )
    existing = db.execute(stmt).scalar_one_or_none()
    if existing is not None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    assignment = UserCustomRole(user_id=user_id, custom_role_id=role_id)
    db.add(assignment)
    db.commit()

    publish_user_role_assigned(room.slug, user_id, role_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{slug}/members/{user_id}/roles/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_role_from_user(
    slug: str,
    user_id: int,
    role_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    response: Response = None,
) -> Response:
    """Remove a custom role from a user."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    if not _can_manage_roles(current_user.id, room.id, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to manage roles",
        )

    _ensure_custom_role_exists(role_id, room.id, db)

    stmt = select(UserCustomRole).where(
        UserCustomRole.user_id == user_id, UserCustomRole.custom_role_id == role_id
    )
    assignment = db.execute(stmt).scalar_one_or_none()
    if assignment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Role assignment not found",
        )

    db.delete(assignment)
    db.commit()

    publish_user_role_removed(room.slug, user_id, role_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{slug}/members/{user_id}/roles", response_model=list[CustomRoleRead])
def get_user_roles(
    slug: str,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CustomRoleRead]:
    """Get all custom roles assigned to a user."""
    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)
    require_room_member(room.id, user_id, db)

    stmt = (
        select(CustomRole)
        .join(UserCustomRole, UserCustomRole.custom_role_id == CustomRole.id)
        .where(
            UserCustomRole.user_id == user_id,
            CustomRole.room_id == room.id,
        )
        .order_by(CustomRole.position.desc())
    )
    roles = db.execute(stmt).scalars().all()

    return [CustomRoleRead.model_validate(role, from_attributes=True) for role in roles]

