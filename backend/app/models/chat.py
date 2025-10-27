from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
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
from app.models.enums import ChannelType, RoomRole


class User(Base):
    """Application user."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    memberships: Mapped[list["RoomMember"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    messages: Mapped[list["Message"]] = relationship(back_populates="author")
    message_receipts: Mapped[list["MessageReceipt"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


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


class RoomMember(Base):
    """Link table between room and user with role."""

    __tablename__ = "room_members"
    __table_args__ = (UniqueConstraint("room_id", "user_id", name="uq_room_member"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[RoomRole] = mapped_column(
        SAEnum(RoomRole, name="room_role"), default=RoomRole.MEMBER, nullable=False
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
    type: Mapped[ChannelType] = mapped_column(SAEnum(ChannelType, name="channel_type"), nullable=False)
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("channel_categories.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room: Mapped[Room] = relationship(back_populates="channels")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="channel", cascade="all, delete-orphan"
    )
    category: Mapped[ChannelCategory | None] = relationship(back_populates="channels")


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
    author: Mapped[User | None] = relationship(back_populates="messages")
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
        SAEnum(RoomRole, name="room_role"), default=RoomRole.MEMBER, nullable=False
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
    role: Mapped[RoomRole] = mapped_column(SAEnum(RoomRole, name="room_role"), nullable=False)
    level: Mapped[int] = mapped_column(Integer, nullable=False)

    room: Mapped[Room] = relationship(back_populates="role_hierarchy")


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
