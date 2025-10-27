"""Room management API endpoints."""

from __future__ import annotations

import secrets
from string import ascii_uppercase

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import (
    ensure_minimum_role,
    ensure_role_priority,
    get_current_user,
    require_room_member,
)
from app.core.slug import unique_slug
from app.database import get_db
from app.models import (
    Channel,
    ChannelCategory,
    ChannelType,
    Room,
    RoomInvitation,
    RoomMember,
    RoomRole,
    RoomRoleHierarchy,
    User,
)
from app.schemas import (
    ChannelCategoryCreate,
    ChannelCategoryRead,
    ChannelCategoryUpdate,
    ChannelCreate,
    ChannelRead,
    RoomCreate,
    RoomDetail,
    RoomInvitationCreate,
    RoomInvitationRead,
    RoomMemberRoleUpdate,
    RoomRead,
    RoomRoleLevelRead,
    RoomRoleLevelUpdate,
)

router = APIRouter(prefix="/rooms", tags=["rooms"])

ADMIN_ROLES: tuple[RoomRole, ...] = (RoomRole.OWNER, RoomRole.ADMIN)
DEFAULT_ROLE_LEVELS: dict[RoomRole, int] = {
    RoomRole.OWNER: 400,
    RoomRole.ADMIN: 300,
    RoomRole.MEMBER: 200,
    RoomRole.GUEST: 100,
}


def _ensure_room_exists(slug: str, db: Session, *, eager: bool = False) -> Room:
    options = []
    if eager:
        options = [
            selectinload(Room.channels),
            selectinload(Room.categories),
            selectinload(Room.invitations),
            selectinload(Room.role_hierarchy),
            selectinload(Room.members).selectinload(RoomMember.user),
        ]
    stmt = select(Room).where(Room.slug == slug)
    if options:
        stmt = stmt.options(*options)
    room = db.execute(stmt).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


def _ensure_admin(room_id: int, membership: RoomMember, db: Session) -> None:
    ensure_minimum_role(room_id, membership.role, ADMIN_ROLES, db)


def _generate_invitation_code(db: Session) -> str:
    for _ in range(10):
        candidate = secrets.token_urlsafe(8)
        existing = db.execute(
            select(RoomInvitation.id).where(RoomInvitation.code == candidate)
        ).scalar_one_or_none()
        if existing is None:
            return candidate
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Unable to generate unique invitation code",
    )


def _get_category(room_id: int, category_id: int, db: Session) -> ChannelCategory:
    category = db.get(ChannelCategory, category_id)
    if category is None or category.room_id != room_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    return category


def _get_role_entry(room_id: int, role: RoomRole, db: Session) -> RoomRoleHierarchy:
    stmt = select(RoomRoleHierarchy).where(
        RoomRoleHierarchy.room_id == room_id,
        RoomRoleHierarchy.role == role,
    )
    entry = db.execute(stmt).scalar_one_or_none()
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Role hierarchy entry not found",
        )
    return entry


@router.get("", response_model=list[RoomRead])
def list_rooms(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RoomRead]:
    """Return rooms the current user belongs to ordered by title."""

    stmt = (
        select(Room)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(RoomMember.user_id == current_user.id)
        .order_by(Room.title)
    )
    rooms = db.execute(stmt).scalars().unique().all()
    return rooms


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

    owner_membership = RoomMember(
        room_id=room.id,
        user_id=current_user.id,
        role=RoomRole.OWNER,
    )
    db.add(owner_membership)

    for role, level in DEFAULT_ROLE_LEVELS.items():
        hierarchy_entry = RoomRoleHierarchy(room_id=room.id, role=role, level=level)
        db.add(hierarchy_entry)

    db.commit()
    db.refresh(room)
    return room


@router.get("/{slug}", response_model=RoomDetail)
def get_room(
    slug: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomDetail:
    """Retrieve room information together with its channels and metadata."""

    room = _ensure_room_exists(slug, db, eager=True)
    membership = require_room_member(room.id, current_user.id, db)

    room.channels.sort(key=lambda channel: channel.letter)
    room.categories.sort(key=lambda category: (category.position, category.name.lower()))
    room.role_hierarchy.sort(key=lambda entry: entry.level, reverse=True)
    room.invitations.sort(key=lambda invitation: invitation.created_at, reverse=True)
    room.members.sort(
        key=lambda member: (member.user.display_name or member.user.login or "").lower()
    )

    detail = RoomDetail.model_validate(room, from_attributes=True)
    detail.current_role = membership.role
    if membership.role not in ADMIN_ROLES:
        detail.invitations = []
    detail.members.sort(key=lambda member: (member.display_name or member.login or "").lower())
    return detail


@router.post("/{slug}/channels", response_model=ChannelRead, status_code=status.HTTP_201_CREATED)
def create_channel(
    slug: str,
    payload: ChannelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Channel:
    """Create a new channel inside the specified room."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    if payload.type not in {ChannelType.TEXT, ChannelType.VOICE}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only text or voice channels can be created",
        )

    if payload.category_id is not None:
        _get_category(room.id, payload.category_id, db)

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
        category_id=payload.category_id,
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
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    normalized_letter = letter.upper()
    if len(normalized_letter) != 1 or normalized_letter not in ascii_uppercase:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid channel letter")
    channel_stmt = select(Channel).where(
        Channel.room_id == room.id,
        Channel.letter == normalized_letter,
    )
    channel = db.execute(channel_stmt).scalar_one_or_none()
    if channel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")

    db.delete(channel)
    db.commit()


@router.get("/{slug}/categories", response_model=list[ChannelCategoryRead])
def list_categories(
    slug: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ChannelCategoryRead]:
    """List channel categories defined in the room."""

    room = _ensure_room_exists(slug, db)
    require_room_member(room.id, current_user.id, db)

    categories = (
        db.execute(
            select(ChannelCategory)
            .where(ChannelCategory.room_id == room.id)
            .order_by(ChannelCategory.position, ChannelCategory.name)
        )
        .scalars()
        .all()
    )
    return [ChannelCategoryRead.model_validate(category, from_attributes=True) for category in categories]


@router.post("/{slug}/categories", response_model=ChannelCategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(
    slug: str,
    payload: ChannelCategoryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChannelCategoryRead:
    """Create a new channel category in the room."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    category = ChannelCategory(room_id=room.id, name=payload.name, position=payload.position)
    db.add(category)
    db.commit()
    db.refresh(category)
    return ChannelCategoryRead.model_validate(category, from_attributes=True)


@router.patch("/{slug}/categories/{category_id}", response_model=ChannelCategoryRead)
def update_category(
    slug: str,
    category_id: int,
    payload: ChannelCategoryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChannelCategoryRead:
    """Update attributes of a channel category."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    category = _get_category(room.id, category_id, db)
    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        category.name = update_data["name"]
    if "position" in update_data:
        category.position = update_data["position"]

    db.commit()
    db.refresh(category)
    return ChannelCategoryRead.model_validate(category, from_attributes=True)


@router.delete(
    "/{slug}/categories/{category_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
def delete_category(
    slug: str,
    category_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete a channel category from the room."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    category = _get_category(room.id, category_id, db)
    db.delete(category)
    db.commit()


@router.get("/{slug}/invitations", response_model=list[RoomInvitationRead])
def list_invitations(
    slug: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RoomInvitationRead]:
    """List invitations configured for the room."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    invitations = (
        db.execute(
            select(RoomInvitation)
            .where(RoomInvitation.room_id == room.id)
            .order_by(RoomInvitation.created_at.desc())
        )
        .scalars()
        .all()
    )
    return [RoomInvitationRead.model_validate(invitation, from_attributes=True) for invitation in invitations]


@router.post("/{slug}/invitations", response_model=RoomInvitationRead, status_code=status.HTTP_201_CREATED)
def create_invitation(
    slug: str,
    payload: RoomInvitationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomInvitationRead:
    """Create a reusable invitation for the room."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    code = _generate_invitation_code(db)
    invitation = RoomInvitation(
        room_id=room.id,
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
    "/{slug}/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
def delete_invitation(
    slug: str,
    invitation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete a room invitation."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    invitation = db.get(RoomInvitation, invitation_id)
    if invitation is None or invitation.room_id != room.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found")

    db.delete(invitation)
    db.commit()


@router.patch("/{slug}/members/{user_id}", response_model=RoomMemberRoleUpdate)
def update_member_role(
    slug: str,
    user_id: int,
    payload: RoomMemberRoleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomMemberRoleUpdate:
    """Update the role of a room member respecting the hierarchy."""

    room = _ensure_room_exists(slug, db)
    actor_membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, actor_membership, db)

    target_membership = db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room.id,
            RoomMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if target_membership is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")

    ensure_role_priority(room.id, actor_membership.role, target_membership.role, db)
    if actor_membership.role != RoomRole.OWNER:
        ensure_role_priority(room.id, actor_membership.role, payload.role, db)

    target_membership.role = payload.role
    db.commit()
    db.refresh(target_membership)
    return RoomMemberRoleUpdate(role=target_membership.role)


@router.get("/{slug}/roles/hierarchy", response_model=list[RoomRoleLevelRead])
def list_role_hierarchy(
    slug: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RoomRoleLevelRead]:
    """Return the configured role hierarchy for the room."""

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    _ensure_admin(room.id, membership, db)

    entries = (
        db.execute(
            select(RoomRoleHierarchy)
            .where(RoomRoleHierarchy.room_id == room.id)
            .order_by(RoomRoleHierarchy.level.desc())
        )
        .scalars()
        .all()
    )
    return [RoomRoleLevelRead.model_validate(entry, from_attributes=True) for entry in entries]


@router.patch("/{slug}/roles/hierarchy/{role_name}", response_model=RoomRoleLevelRead)
def update_role_level(
    slug: str,
    role_name: str,
    payload: RoomRoleLevelUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RoomRoleLevelRead:
    """Update the privilege level for a role inside the room."""

    try:
        role = RoomRole(role_name)
    except ValueError as exc:  # pragma: no cover - defensive programming
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found") from exc

    room = _ensure_room_exists(slug, db)
    membership = require_room_member(room.id, current_user.id, db)
    ensure_minimum_role(room.id, membership.role, {RoomRole.OWNER}, db)

    entry = _get_role_entry(room.id, role, db)
    entry.level = payload.level
    db.commit()
    db.refresh(entry)
    return RoomRoleLevelRead.model_validate(entry, from_attributes=True)
