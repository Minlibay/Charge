"""Room invitation management API endpoints."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_room_member
from app.api.rooms import (
    ADMIN_ROLES,
    _ensure_admin,
    _ensure_room_exists,
    _generate_invitation_code,
)
from app.database import get_db
from app.models import Room, RoomInvitation, RoomMember, RoomRole, RoomRoleHierarchy, User
from app.schemas import RoomDetail, RoomInvitationCreate, RoomInvitationRead

router = APIRouter(prefix="/invites", tags=["invites"])


class InvitationCreateRequest(RoomInvitationCreate):
    """Payload for creating a room invitation from the global endpoint."""

    room_slug: str


def _ensure_invitation_room(room_slug: str, db: Session) -> Room:
    room = _ensure_room_exists(room_slug, db)
    return room


def _collect_role_levels(room_id: int, db: Session) -> dict[RoomRole, int]:
    stmt = select(RoomRoleHierarchy).where(RoomRoleHierarchy.room_id == room_id)
    entries = db.execute(stmt).scalars().all()
    return {entry.role: entry.level for entry in entries}


@router.get("", response_model=list[RoomInvitationRead])
def list_invitations(
    room: str = Query(..., description="Room slug to list invitations for"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RoomInvitationRead]:
    """Return the invitations configured for a given room."""

    room_model = _ensure_invitation_room(room, db)
    membership = require_room_member(room_model.id, current_user.id, db)
    _ensure_admin(room_model.id, membership, db)

    invitations = (
        db.execute(
            select(RoomInvitation)
            .where(RoomInvitation.room_id == room_model.id)
            .order_by(RoomInvitation.created_at.desc())
        )
        .scalars()
        .all()
    )
    return [RoomInvitationRead.model_validate(invitation, from_attributes=True) for invitation in invitations]


@router.post("", response_model=RoomInvitationRead, status_code=status.HTTP_201_CREATED)
def create_invitation(
    payload: InvitationCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomInvitationRead:
    """Create a new invitation for the provided room slug."""

    room_model = _ensure_invitation_room(payload.room_slug, db)
    membership = require_room_member(room_model.id, current_user.id, db)
    _ensure_admin(room_model.id, membership, db)

    code = _generate_invitation_code(db)
    invitation = RoomInvitation(
        room_id=room_model.id,
        code=code,
        role=payload.role,
        expires_at=payload.expires_at,
        created_by_id=current_user.id,
    )
    db.add(invitation)
    db.commit()
    db.refresh(invitation)
    return RoomInvitationRead.model_validate(invitation, from_attributes=True)


@router.delete(
    "/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_invitation(
    invitation_id: int,
    room: str = Query(..., description="Room slug the invitation belongs to"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete an invitation ensuring the requester has sufficient permissions."""

    room_model = _ensure_invitation_room(room, db)
    membership = require_room_member(room_model.id, current_user.id, db)
    _ensure_admin(room_model.id, membership, db)

    invitation = db.get(RoomInvitation, invitation_id)
    if invitation is None or invitation.room_id != room_model.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found")

    db.delete(invitation)
    db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{code}", response_model=RoomDetail)
def accept_invitation(
    code: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomDetail:
    """Join a room using an invitation code."""

    stmt = select(RoomInvitation).where(RoomInvitation.code == code)
    invitation = db.execute(stmt).scalar_one_or_none()
    if invitation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found")

    if invitation.expires_at is not None:
        now = datetime.now(timezone.utc)
        if invitation.expires_at <= now:
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="Invitation expired")

    room = db.execute(select(Room).where(Room.id == invitation.room_id)).scalar_one()

    membership_stmt = select(RoomMember).where(
        RoomMember.room_id == room.id,
        RoomMember.user_id == current_user.id,
    )
    membership = db.execute(membership_stmt).scalar_one_or_none()
    role_levels = _collect_role_levels(room.id, db)

    if membership is None:
        membership = RoomMember(room_id=room.id, user_id=current_user.id, role=invitation.role)
        db.add(membership)
        db.commit()
        db.refresh(membership)
    else:
        current_level = role_levels.get(membership.role)
        invited_level = role_levels.get(invitation.role)
        if current_level is not None and invited_level is not None and invited_level > current_level:
            membership.role = invitation.role
            db.commit()
            db.refresh(membership)

    detailed_room = _ensure_room_exists(room.slug, db, eager=True)
    detailed_room.channels.sort(key=lambda channel: channel.letter)
    detailed_room.categories.sort(key=lambda category: (category.position, category.name.lower()))
    detailed_room.role_hierarchy.sort(key=lambda entry: entry.level, reverse=True)
    detailed_room.invitations.sort(key=lambda inv: inv.created_at, reverse=True)

    detail = RoomDetail.model_validate(detailed_room, from_attributes=True)
    role_for_permissions = membership.role if membership else invitation.role
    detail.current_role = role_for_permissions
    if role_for_permissions not in ADMIN_ROLES:
        detail.invitations = []
    return detail
