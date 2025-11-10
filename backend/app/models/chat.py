from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.enums import (
    ChannelPermission,
    ChannelType,
    FriendRequestStatus,
    PresenceStatus,
    RoomPermission,
    RoomRole,
)

_PERMISSION_BIT_VALUES: dict[ChannelPermission, int] = {
    permission: 1 << index for index, permission in enumerate(ChannelPermission)
}

_ROOM_PERMISSION_BIT_VALUES: dict[RoomPermission, int] = {
    permission: 1 << index for index, permission in enumerate(RoomPermission)
}


def encode_permissions(permissions: Iterable[ChannelPermission]) -> int:
    """Convert a collection of permissions into a bitmask."""

    mask = 0
    for permission in permissions:
        mask |= _PERMISSION_BIT_VALUES[ChannelPermission(permission)]
    return mask


def decode_permissions(mask: int) -> list[ChannelPermission]:
    """Expand a bitmask back into a list of permissions."""

    values: list[ChannelPermission] = []
    for permission, bit in _PERMISSION_BIT_VALUES.items():
        if mask & bit:
            values.append(permission)
    return values


def encode_room_permissions(permissions: Iterable[RoomPermission]) -> int:
    """Convert a collection of room permissions into a bitmask."""

    mask = 0
    for permission in permissions:
        mask |= _ROOM_PERMISSION_BIT_VALUES[RoomPermission(permission)]
    return mask


def decode_room_permissions(mask: int) -> list[RoomPermission]:
    """Expand a bitmask back into a list of room permissions."""

    values: list[RoomPermission] = []
    for permission, bit in _ROOM_PERMISSION_BIT_VALUES.items():
        if mask & bit:
            values.append(permission)
    return values


class User(Base):
    """Application user."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(128))
    avatar_path: Mapped[str | None] = mapped_column(String(512))
    avatar_content_type: Mapped[str | None] = mapped_column(String(128))
    avatar_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    presence_status: Mapped[PresenceStatus] = mapped_column(
        SAEnum(
            PresenceStatus,
            name="presence_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        default=PresenceStatus.ONLINE,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    memberships: Mapped[list["RoomMember"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    messages: Mapped[list["Message"]] = relationship(
        back_populates="author", foreign_keys="Message.author_id"
    )
    message_receipts: Mapped[list["MessageReceipt"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    pinned_messages: Mapped[list["PinnedMessage"]] = relationship(
        back_populates="pinned_by", foreign_keys="PinnedMessage.pinned_by_id"
    )
    sent_friend_requests: Mapped[list["FriendLink"]] = relationship(
        back_populates="requester", foreign_keys="FriendLink.requester_id", cascade="all, delete-orphan"
    )
    received_friend_requests: Mapped[list["FriendLink"]] = relationship(
        back_populates="addressee", foreign_keys="FriendLink.addressee_id", cascade="all, delete-orphan"
    )
    direct_conversations_as_a: Mapped[list["DirectConversation"]] = relationship(
        back_populates="user_a",
        foreign_keys="DirectConversation.user_a_id",
        cascade="all, delete-orphan",
    )
    direct_conversations_as_b: Mapped[list["DirectConversation"]] = relationship(
        back_populates="user_b",
        foreign_keys="DirectConversation.user_b_id",
        cascade="all, delete-orphan",
    )
    direct_participations: Mapped[list["DirectConversationParticipant"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    direct_messages: Mapped[list["DirectMessage"]] = relationship(
        back_populates="sender", foreign_keys="DirectMessage.sender_id", cascade="all, delete-orphan"
    )
    channel_overwrites: Mapped[list["ChannelUserPermissionOverwrite"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    custom_roles: Mapped[list["UserCustomRole"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def avatar_url(self) -> str | None:
        from app.config import get_settings

        if not self.avatar_path:
            return None
        settings = get_settings()
        base = settings.avatar_base_url.rstrip("/")
        version = (
            int(self.avatar_updated_at.timestamp()) if self.avatar_updated_at is not None else None
        )
        suffix = f"?v={version}" if version is not None else ""
        return f"{base}/{self.id}{suffix}"


class Room(Base):
    """Chat room aggregating users and channels."""

    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    members: Mapped[list["RoomMember"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    channels: Mapped[list["Channel"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    categories: Mapped[list["ChannelCategory"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    invitations: Mapped[list["RoomInvitation"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    role_hierarchy: Mapped[list["RoomRoleHierarchy"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    custom_roles: Mapped[list["CustomRole"]] = relationship(
        back_populates="room", cascade="all, delete-orphan", order_by="CustomRole.position.desc()"
    )


class RoomMember(Base):
    """Link table between room and user with role."""

    __tablename__ = "room_members"
    __table_args__ = (UniqueConstraint("room_id", "user_id", name="uq_room_member"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[RoomRole] = mapped_column(
        SAEnum(
            RoomRole,
            name="room_role",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        default=RoomRole.MEMBER,
        nullable=False,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room: Mapped[Room] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships")


class Channel(Base):
    """Communication channel inside a room."""

    __tablename__ = "channels"
    __table_args__ = (UniqueConstraint("room_id", "letter", name="uq_channel_room_letter"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    letter: Mapped[str] = mapped_column(String(1), nullable=False)
    type: Mapped[ChannelType] = mapped_column(
        SAEnum(
            ChannelType,
            name="channel_type",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("channel_categories.id", ondelete="SET NULL"), nullable=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    topic: Mapped[str | None] = mapped_column(Text, nullable=True)
    slowmode_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_nsfw: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_private: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    archived_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room: Mapped[Room] = relationship(back_populates="channels")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="channel", cascade="all, delete-orphan"
    )
    category: Mapped[ChannelCategory | None] = relationship(back_populates="channels")
    archived_by: Mapped["User | None"] = relationship(foreign_keys=[archived_by_id])
    role_overwrites: Mapped[list["ChannelRolePermissionOverwrite"]] = relationship(
        back_populates="channel", cascade="all, delete-orphan"
    )
    user_overwrites: Mapped[list["ChannelUserPermissionOverwrite"]] = relationship(
        back_populates="channel", cascade="all, delete-orphan"
    )
    pinned_messages: Mapped[list["PinnedMessage"]] = relationship(
        back_populates="channel", cascade="all, delete-orphan", order_by="PinnedMessage.pinned_at.desc()"
    )


class ChannelPermissionOverwriteBase(Base):
    """Common columns for channel permission overwrites."""

    __abstract__ = True

    allow_mask: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    deny_mask: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    @property
    def allow(self) -> list[ChannelPermission]:
        return decode_permissions(self.allow_mask)

    @property
    def deny(self) -> list[ChannelPermission]:
        return decode_permissions(self.deny_mask)


class ChannelRolePermissionOverwrite(ChannelPermissionOverwriteBase):
    """Overrides channel permissions for a specific room role."""

    __tablename__ = "channel_role_overwrites"
    __table_args__ = (
        UniqueConstraint("channel_id", "role", name="uq_channel_role_overwrite"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[RoomRole] = mapped_column(
        SAEnum(
            RoomRole,
            name="room_role",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )

    channel: Mapped[Channel] = relationship(back_populates="role_overwrites")


class ChannelUserPermissionOverwrite(ChannelPermissionOverwriteBase):
    """Overrides channel permissions for a specific user."""

    __tablename__ = "channel_user_overwrites"
    __table_args__ = (
        UniqueConstraint("channel_id", "user_id", name="uq_channel_user_overwrite"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )

    channel: Mapped[Channel] = relationship(back_populates="user_overwrites")
    user: Mapped[User] = relationship(back_populates="channel_overwrites")


class Message(Base):
    """Message posted within a channel."""

    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_channel_created_at", "channel_id", "created_at"),
        Index("ix_messages_thread_root", "thread_root_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
    )
    thread_root_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    delivered_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    read_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    moderated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    moderation_note: Mapped[str | None] = mapped_column(String(255))
    moderated_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    channel: Mapped[Channel] = relationship(back_populates="messages")
    author: Mapped[User | None] = relationship(
        back_populates="messages", foreign_keys=[author_id]
    )
    parent: Mapped[Message | None] = relationship(
        remote_side="Message.id", back_populates="replies", foreign_keys=[parent_id]
    )
    thread_root: Mapped[Message | None] = relationship(
        remote_side="Message.id", foreign_keys=[thread_root_id], post_update=True
    )
    replies: Mapped[list["Message"]] = relationship(
        back_populates="parent", cascade="all, delete-orphan", foreign_keys=[parent_id]
    )
    attachments: Mapped[list["MessageAttachment"]] = relationship(
        back_populates="message",
        cascade="all, delete-orphan",
        order_by="MessageAttachment.created_at",
    )
    reactions: Mapped[list["MessageReaction"]] = relationship(
        back_populates="message", cascade="all, delete-orphan"
    )
    receipts: Mapped[list["MessageReceipt"]] = relationship(
        back_populates="message", cascade="all, delete-orphan"
    )
    moderated_by: Mapped[User | None] = relationship(foreign_keys=[moderated_by_id])
    pin_entries: Mapped[list["PinnedMessage"]] = relationship(
        back_populates="message", cascade="all, delete-orphan"
    )


class PinnedMessage(Base):
    """Pinned message metadata for channels."""

    __tablename__ = "pinned_messages"
    __table_args__ = (
        UniqueConstraint("channel_id", "message_id", name="uq_channel_pinned_message"),
        Index("ix_pins_channel_created_at", "channel_id", "pinned_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    pinned_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    pinned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    note: Mapped[str | None] = mapped_column(String(255))

    channel: Mapped[Channel] = relationship(back_populates="pinned_messages")
    message: Mapped[Message] = relationship(back_populates="pin_entries")
    pinned_by: Mapped[User | None] = relationship(back_populates="pinned_messages")


class MessageReceipt(Base):
    """Per-user delivery and read receipts for messages."""

    __tablename__ = "message_receipts"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", name="uq_message_receipt"),
        Index("ix_receipts_message", "message_id"),
        Index("ix_receipts_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    message: Mapped[Message] = relationship(back_populates="receipts")
    user: Mapped[User] = relationship(back_populates="message_receipts")


class ChannelCategory(Base):
    """Logical grouping for channels inside a room."""

    __tablename__ = "channel_categories"
    __table_args__ = (UniqueConstraint("room_id", "name", name="uq_category_room_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room: Mapped[Room] = relationship(back_populates="categories")
    channels: Mapped[list[Channel]] = relationship(back_populates="category")


class RoomInvitation(Base):
    """Invitation token allowing users to join a room with a predefined role."""

    __tablename__ = "room_invitations"
    __table_args__ = (UniqueConstraint("code", name="uq_room_invitation_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    role: Mapped[RoomRole] = mapped_column(
        SAEnum(
            RoomRole,
            name="room_role",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        default=RoomRole.MEMBER,
        nullable=False,
    )
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room: Mapped[Room] = relationship(back_populates="invitations")
    created_by: Mapped[User | None] = relationship()


class RoomRoleHierarchy(Base):
    """Defines privilege level for room roles within a specific room."""

    __tablename__ = "room_role_hierarchy"
    __table_args__ = (UniqueConstraint("room_id", "role", name="uq_room_role_level"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[RoomRole] = mapped_column(
        SAEnum(
            RoomRole,
            name="room_role",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    level: Mapped[int] = mapped_column(Integer, nullable=False)

    room: Mapped[Room] = relationship(back_populates="role_hierarchy")


class CustomRole(Base):
    """Custom role that can be created and assigned to users within a room."""

    __tablename__ = "custom_roles"
    __table_args__ = (
        UniqueConstraint("room_id", "name", name="uq_custom_role_room_name"),
        Index("ix_custom_roles_room_id", "room_id"),
        Index("ix_custom_roles_position", "room_id", "position"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    color: Mapped[str] = mapped_column(String(7), nullable=False, default="#99AAB5")  # HEX color
    icon: Mapped[str | None] = mapped_column(String(512), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    hoist: Mapped[bool] = mapped_column(default=False, nullable=False)
    mentionable: Mapped[bool] = mapped_column(default=False, nullable=False)
    permissions_mask: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    room: Mapped[Room] = relationship(back_populates="custom_roles")
    user_assignments: Mapped[list["UserCustomRole"]] = relationship(
        back_populates="custom_role", cascade="all, delete-orphan"
    )

    @property
    def permissions(self) -> list[RoomPermission]:
        """Get list of room permissions from the bitmask."""
        return decode_room_permissions(self.permissions_mask)

    @permissions.setter
    def permissions(self, permissions: Iterable[RoomPermission]) -> None:
        """Set room permissions from a list."""
        self.permissions_mask = encode_room_permissions(permissions)


class UserCustomRole(Base):
    """Many-to-many relationship between users and custom roles."""

    __tablename__ = "user_custom_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "custom_role_id", name="uq_user_custom_role"),
        Index("ix_user_custom_roles_user_id", "user_id"),
        Index("ix_user_custom_roles_role_id", "custom_role_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    custom_role_id: Mapped[int] = mapped_column(
        ForeignKey("custom_roles.id", ondelete="CASCADE"), nullable=False
    )
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="custom_roles")
    custom_role: Mapped[CustomRole] = relationship(back_populates="user_assignments")


class MessageAttachment(Base):
    """Metadata for files attached to messages."""

    __tablename__ = "message_attachments"
    __table_args__ = (
        Index("ix_attachments_channel", "channel_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
    )
    uploader_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(128))
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    channel: Mapped[Channel] = relationship()
    message: Mapped[Message | None] = relationship(back_populates="attachments")
    uploader: Mapped[User | None] = relationship()


class MessageReaction(Base):
    """Individual emoji reactions for a message."""

    __tablename__ = "message_reactions"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", "emoji", name="uq_message_reaction"),
        Index("ix_reactions_message", "message_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    emoji: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    message: Mapped[Message] = relationship(back_populates="reactions")
    user: Mapped[User] = relationship()


class FriendLink(Base):
    """Directional friend relationship between two users."""

    __tablename__ = "friend_links"
    __table_args__ = (
        UniqueConstraint("requester_id", "addressee_id", name="uq_friend_link_pair"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    requester_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    addressee_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[FriendRequestStatus] = mapped_column(
        SAEnum(
            FriendRequestStatus,
            name="friend_request_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        default=FriendRequestStatus.PENDING,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    requester: Mapped[User] = relationship(back_populates="sent_friend_requests", foreign_keys=[requester_id])
    addressee: Mapped[User] = relationship(
        back_populates="received_friend_requests", foreign_keys=[addressee_id]
    )


class DirectConversation(Base):
    """Direct message thread between users. Supports personal and group chats."""

    __tablename__ = "direct_conversations"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_a_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    user_b_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    creator_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str | None] = mapped_column(String(128))
    is_group: Mapped[bool] = mapped_column(default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user_a: Mapped[User | None] = relationship(
        back_populates="direct_conversations_as_a", foreign_keys=[user_a_id]
    )
    user_b: Mapped[User | None] = relationship(
        back_populates="direct_conversations_as_b", foreign_keys=[user_b_id]
    )
    creator: Mapped[User | None] = relationship(foreign_keys=[creator_id])
    participants: Mapped[list["DirectConversationParticipant"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="DirectConversationParticipant.joined_at",
    )
    messages: Mapped[list["DirectMessage"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="DirectMessage.created_at",
    )

    def has_user(self, user_id: int) -> bool:
        return any(participant.user_id == user_id for participant in self.participants)


class DirectConversationParticipant(Base):
    """Membership information for direct conversations."""

    __tablename__ = "direct_conversation_participants"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_direct_participant"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("direct_conversations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    nickname: Mapped[str | None] = mapped_column(String(128))
    note: Mapped[str | None] = mapped_column(Text)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    conversation: Mapped[DirectConversation] = relationship(back_populates="participants")
    user: Mapped[User] = relationship(back_populates="direct_participations")


class DirectMessage(Base):
    """Individual message exchanged in a direct conversation."""

    __tablename__ = "direct_messages"
    __table_args__ = (
        Index("ix_direct_messages_conversation", "conversation_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("direct_conversations.id", ondelete="CASCADE"), nullable=False
    )
    sender_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    recipient_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    conversation: Mapped[DirectConversation] = relationship(back_populates="messages")
    sender: Mapped[User] = relationship(
        back_populates="direct_messages", foreign_keys=[sender_id]
    )
    recipient: Mapped[User | None] = relationship(foreign_keys=[recipient_id])


class AnnouncementCrossPost(Base):
    """Cross-posting relationship for announcement messages across channels."""

    __tablename__ = "announcement_cross_posts"
    __table_args__ = (
        Index("ix_cross_posts_original", "original_message_id"),
        Index("ix_cross_posts_cross_posted", "cross_posted_message_id"),
        Index("ix_cross_posts_target_channel", "target_channel_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    original_message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    cross_posted_message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    target_channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    original_message: Mapped["Message"] = relationship(foreign_keys=[original_message_id])
    cross_posted_message: Mapped["Message"] = relationship(foreign_keys=[cross_posted_message_id])
    target_channel: Mapped["Channel"] = relationship()


class ForumPost(Base):
    """Post in a forum channel."""

    __tablename__ = "forum_posts"
    __table_args__ = (
        Index("ix_forum_posts_channel", "channel_id"),
        Index("ix_forum_posts_message", "message_id"),
        Index("ix_forum_posts_author", "author_id"),
        Index("ix_forum_posts_last_reply", "last_reply_at"),
        Index("ix_forum_posts_pinned", "is_pinned"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"), nullable=False)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    reply_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_reply_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_reply_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    channel: Mapped["Channel"] = relationship()
    message: Mapped["Message"] = relationship()
    author: Mapped["User"] = relationship(foreign_keys=[author_id])
    last_reply_by: Mapped["User | None"] = relationship(foreign_keys=[last_reply_by_id])
    tags: Mapped[list["ForumPostTag"]] = relationship(
        back_populates="post", cascade="all, delete-orphan"
    )


class ForumPostTag(Base):
    """Tag for a forum post."""

    __tablename__ = "forum_post_tags"
    __table_args__ = (
        UniqueConstraint("post_id", "tag_name", name="uq_forum_post_tag"),
        Index("ix_forum_post_tags_post", "post_id"),
        Index("ix_forum_post_tags_name", "tag_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(
        ForeignKey("forum_posts.id", ondelete="CASCADE"), nullable=False
    )
    tag_name: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    post: Mapped["ForumPost"] = relationship(back_populates="tags")


class ForumChannelTag(Base):
    """Predefined tags for a forum channel."""

    __tablename__ = "forum_channel_tags"
    __table_args__ = (
        UniqueConstraint("channel_id", "name", name="uq_forum_channel_tag"),
        Index("ix_forum_channel_tags_channel", "channel_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    color: Mapped[str] = mapped_column(String(7), nullable=False, default="#99AAB5")
    emoji: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    channel: Mapped["Channel"] = relationship()