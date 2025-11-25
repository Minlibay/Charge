"""Centralized permission calculation service."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    ChannelPermission,
    ChannelRolePermissionOverwrite,
    ChannelUserPermissionOverwrite,
    CustomRole,
    RoomMember,
    RoomPermission,
    RoomRole,
    UserCustomRole,
    decode_permissions,
    decode_room_permissions,
)

# Default permissions for base roles
# OWNER and ADMIN have all permissions by default
# MEMBER has basic permissions
# GUEST has minimal permissions
DEFAULT_ROLE_PERMISSIONS: dict[RoomRole, set[RoomPermission]] = {
    RoomRole.OWNER: {
        RoomPermission.MANAGE_ROLES,
        RoomPermission.MANAGE_ROOM,
        RoomPermission.KICK_MEMBERS,
        RoomPermission.BAN_MEMBERS,
        RoomPermission.MANAGE_INVITES,
        RoomPermission.VIEW_AUDIT_LOG,
    },
    RoomRole.ADMIN: {
        RoomPermission.MANAGE_ROLES,
        RoomPermission.MANAGE_ROOM,
        RoomPermission.KICK_MEMBERS,
        RoomPermission.BAN_MEMBERS,
        RoomPermission.MANAGE_INVITES,
        RoomPermission.VIEW_AUDIT_LOG,
    },
    RoomRole.MEMBER: set(),  # Members have no special room permissions by default
    RoomRole.GUEST: set(),  # Guests have no special room permissions by default
}

# Default channel permissions for base roles
# OWNER and ADMIN have all channel permissions
# MEMBER has basic channel permissions
# GUEST has minimal channel permissions
DEFAULT_CHANNEL_PERMISSIONS: dict[RoomRole, set[ChannelPermission]] = {
    RoomRole.OWNER: {
        ChannelPermission.VIEW,
        ChannelPermission.SEND_MESSAGES,
        ChannelPermission.MANAGE_MESSAGES,
        ChannelPermission.CONNECT,
        ChannelPermission.SPEAK,
        ChannelPermission.MANAGE_CHANNEL,
        ChannelPermission.MANAGE_PERMISSIONS,
        ChannelPermission.START_STAGE,
        ChannelPermission.MANAGE_STAGE,
        ChannelPermission.PUBLISH_ANNOUNCEMENTS,
        ChannelPermission.CREATE_FORUM_POSTS,
        ChannelPermission.MODERATE_FORUM_POSTS,
        ChannelPermission.CREATE_EVENTS,
        ChannelPermission.MANAGE_EVENTS,
    },
    RoomRole.ADMIN: {
        ChannelPermission.VIEW,
        ChannelPermission.SEND_MESSAGES,
        ChannelPermission.MANAGE_MESSAGES,
        ChannelPermission.CONNECT,
        ChannelPermission.SPEAK,
        ChannelPermission.MANAGE_CHANNEL,
        ChannelPermission.MANAGE_PERMISSIONS,
        ChannelPermission.START_STAGE,
        ChannelPermission.MANAGE_STAGE,
        ChannelPermission.PUBLISH_ANNOUNCEMENTS,
        ChannelPermission.CREATE_FORUM_POSTS,
        ChannelPermission.MODERATE_FORUM_POSTS,
        ChannelPermission.CREATE_EVENTS,
        ChannelPermission.MANAGE_EVENTS,
    },
    RoomRole.MEMBER: {
        ChannelPermission.VIEW,
        ChannelPermission.SEND_MESSAGES,
        ChannelPermission.CONNECT,
        ChannelPermission.SPEAK,
        ChannelPermission.CREATE_FORUM_POSTS,
        ChannelPermission.CREATE_EVENTS,
    },
    RoomRole.GUEST: {
        ChannelPermission.VIEW,
        ChannelPermission.CONNECT,
        ChannelPermission.SPEAK,
    },
}


def calculate_user_room_permissions(user_id: int, room_id: int, db: Session) -> set[RoomPermission]:
    """
    Calculate all room-level permissions for a user.

    Combines:
    - Base role permissions (OWNER, ADMIN, MEMBER, GUEST)
    - Custom role permissions (OR operation - union of all permissions)

    Args:
        user_id: The user ID
        room_id: The room ID
        db: Database session

    Returns:
        Set of room permissions the user has
    """
    # Get user's membership
    stmt = select(RoomMember).where(
        RoomMember.room_id == room_id,
        RoomMember.user_id == user_id,
    )
    membership = db.execute(stmt).scalar_one_or_none()
    if membership is None:
        return set()

    # Start with base role permissions
    base_role = membership.role
    permissions = DEFAULT_ROLE_PERMISSIONS.get(base_role, set()).copy()

    # Get all custom roles for this user in this room
    stmt = (
        select(CustomRole)
        .join(UserCustomRole, UserCustomRole.custom_role_id == CustomRole.id)
        .where(
            UserCustomRole.user_id == user_id,
            CustomRole.room_id == room_id,
        )
    )
    custom_roles = db.execute(stmt).scalars().all()

    # Union all custom role permissions (OR operation)
    for custom_role in custom_roles:
        role_permissions = decode_room_permissions(custom_role.permissions_mask)
        permissions.update(role_permissions)

    return permissions


def calculate_user_channel_permissions(
    user_id: int, room_id: int, channel_id: int, db: Session
) -> set[ChannelPermission]:
    """
    Calculate all channel-level permissions for a user.

    Process:
    1. Get base channel permissions from user's room role
    2. Apply role-based overwrites (for user's base role and custom roles)
    3. Apply user-specific overwrites (highest priority)

    Args:
        user_id: The user ID
        room_id: The room ID
        channel_id: The channel ID
        db: Database session

    Returns:
        Set of channel permissions the user has
    """
    # Get user's membership
    stmt = select(RoomMember).where(
        RoomMember.room_id == room_id,
        RoomMember.user_id == user_id,
    )
    membership = db.execute(stmt).scalar_one_or_none()
    if membership is None:
        return set()

    # Start with base role channel permissions
    base_role = membership.role
    permissions = DEFAULT_CHANNEL_PERMISSIONS.get(base_role, set()).copy()

    # Get all custom roles for this user in this room
    # Apply role-based overwrites (for base role)
    stmt = select(ChannelRolePermissionOverwrite).where(
        ChannelRolePermissionOverwrite.channel_id == channel_id,
        ChannelRolePermissionOverwrite.role == base_role,
    )
    role_overwrite = db.execute(stmt).scalar_one_or_none()
    if role_overwrite:
        # Apply allow permissions (add)
        allowed = decode_permissions(role_overwrite.allow_mask)
        permissions.update(allowed)
        # Apply deny permissions (remove)
        denied = decode_permissions(role_overwrite.deny_mask)
        permissions.difference_update(denied)

    # Apply user-specific overwrites (highest priority)
    stmt = select(ChannelUserPermissionOverwrite).where(
        ChannelUserPermissionOverwrite.channel_id == channel_id,
        ChannelUserPermissionOverwrite.user_id == user_id,
    )
    user_overwrite = db.execute(stmt).scalar_one_or_none()
    if user_overwrite:
        # Apply allow permissions (add)
        allowed = decode_permissions(user_overwrite.allow_mask)
        permissions.update(allowed)
        # Apply deny permissions (remove)
        denied = decode_permissions(user_overwrite.deny_mask)
        permissions.difference_update(denied)

    return permissions


def has_permission(
    user_id: int,
    room_id: int,
    permission: RoomPermission | ChannelPermission,
    channel_id: int | None = None,
    db: Session | None = None,
) -> bool:
    """
    Check if a user has a specific permission.

    Args:
        user_id: The user ID
        room_id: The room ID
        permission: The permission to check
        channel_id: Optional channel ID for channel permissions
        db: Database session (required if channel_id is provided)

    Returns:
        True if user has the permission, False otherwise
    """
    if db is None:
        raise ValueError("Database session is required")

    if isinstance(permission, RoomPermission):
        permissions = calculate_user_room_permissions(user_id, room_id, db)
        return permission in permissions

    if isinstance(permission, ChannelPermission):
        if channel_id is None:
            raise ValueError("Channel ID is required for channel permissions")
        permissions = calculate_user_channel_permissions(user_id, room_id, channel_id, db)
        return permission in permissions

    return False


def can_manage_role(actor_id: int, room_id: int, target_role_id: int, db: Session) -> bool:
    """
    Check if an actor can manage a target role.

    An actor can manage a role if:
    1. Actor is OWNER (can manage any role)
    2. Actor is ADMIN and target role is not OWNER
    3. Actor has MANAGE_ROLES permission and target role position is lower than actor's highest role position

    Args:
        actor_id: The user ID of the actor
        room_id: The room ID
        target_role_id: The custom role ID to manage
        db: Database session

    Returns:
        True if actor can manage the role, False otherwise
    """
    # Get actor's membership
    stmt = select(RoomMember).where(
        RoomMember.room_id == room_id,
        RoomMember.user_id == actor_id,
    )
    actor_membership = db.execute(stmt).scalar_one_or_none()
    if actor_membership is None:
        return False

    # OWNER can manage any role
    if actor_membership.role == RoomRole.OWNER:
        return True

    # Get target role
    stmt = select(CustomRole).where(
        CustomRole.id == target_role_id,
        CustomRole.room_id == room_id,
    )
    target_role = db.execute(stmt).scalar_one_or_none()
    if target_role is None:
        return False

    # ADMIN can manage any role except OWNER (but custom roles are not OWNER, so this is fine)
    if actor_membership.role == RoomRole.ADMIN:
        return True

    # Check if actor has MANAGE_ROLES permission
    actor_permissions = calculate_user_room_permissions(actor_id, room_id, db)
    if RoomPermission.MANAGE_ROLES not in actor_permissions:
        return False

    # Get actor's highest role position
    stmt = (
        select(CustomRole.position)
        .join(UserCustomRole, UserCustomRole.custom_role_id == CustomRole.id)
        .where(
            UserCustomRole.user_id == actor_id,
            CustomRole.room_id == room_id,
        )
        .order_by(CustomRole.position.desc())
        .limit(1)
    )
    actor_highest_position = db.execute(stmt).scalar_one_or_none()

    # If actor has no custom roles, they can't manage roles (unless they're ADMIN/OWNER, already checked)
    if actor_highest_position is None:
        return False

    # Actor can manage roles with lower position
    return target_role.position < actor_highest_position


# Cache for permission calculations (optional optimization)
# Cache is invalidated when roles are changed
_permission_cache: dict[tuple[int, int], set[RoomPermission]] = {}
_channel_permission_cache: dict[tuple[int, int, int], set[ChannelPermission]] = {}


def clear_permission_cache(user_id: int | None = None, room_id: int | None = None) -> None:
    """
    Clear permission cache for a user/room.

    Args:
        user_id: Optional user ID to clear cache for
        room_id: Optional room ID to clear cache for
    """
    global _permission_cache, _channel_permission_cache

    if user_id is None and room_id is None:
        # Clear all caches
        _permission_cache.clear()
        _channel_permission_cache.clear()
        return

    # Clear specific entries
    keys_to_remove = []
    for key in _permission_cache:
        if (user_id is None or key[0] == user_id) and (room_id is None or key[1] == room_id):
            keys_to_remove.append(key)
    for key in keys_to_remove:
        del _permission_cache[key]

    keys_to_remove = []
    for key in _channel_permission_cache:
        if (
            (user_id is None or key[0] == user_id)
            and (room_id is None or key[1] == room_id)
            and (len(key) > 2 and key[2] is not None)
        ):
            keys_to_remove.append(key)
    for key in keys_to_remove:
        del _channel_permission_cache[key]

