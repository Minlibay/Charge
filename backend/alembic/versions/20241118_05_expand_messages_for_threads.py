"""add threading and moderation columns to messages"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241118_05"
down_revision = "20241112_04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("parent_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("thread_root_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.add_column(
        "messages",
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("moderated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("moderation_note", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("moderated_by_id", sa.Integer(), nullable=True),
    )

    op.create_foreign_key(
        "fk_messages_parent_id",
        "messages",
        "messages",
        ["parent_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_messages_thread_root_id",
        "messages",
        "messages",
        ["thread_root_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_messages_moderated_by_id",
        "messages",
        "users",
        ["moderated_by_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_index(
        "ix_messages_channel_created_at",
        "messages",
        ["channel_id", "created_at"],
    )
    op.create_index(
        "ix_messages_thread_root",
        "messages",
        ["thread_root_id", "created_at"],
    )

    op.create_table(
        "message_attachments",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=True),
        sa.Column("uploader_id", sa.Integer(), nullable=True),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=True),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("storage_path", sa.String(length=512), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["uploader_id"], ["users.id"], ondelete="SET NULL"),
        sa.Index("ix_attachments_channel", "channel_id", "created_at"),
        mysql_charset="utf8mb4",
    )

    op.create_table(
        "message_reactions",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("emoji", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("message_id", "user_id", "emoji", name="uq_message_reaction"),
        sa.Index("ix_reactions_message", "message_id"),
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("message_reactions")
    op.drop_table("message_attachments")

    op.drop_index("ix_messages_thread_root", table_name="messages")
    op.drop_index("ix_messages_channel_created_at", table_name="messages")

    op.drop_constraint("fk_messages_moderated_by_id", "messages", type_="foreignkey")
    op.drop_constraint("fk_messages_thread_root_id", "messages", type_="foreignkey")
    op.drop_constraint("fk_messages_parent_id", "messages", type_="foreignkey")

    op.drop_column("messages", "moderated_by_id")
    op.drop_column("messages", "moderation_note")
    op.drop_column("messages", "moderated_at")
    op.drop_column("messages", "deleted_at")
    op.drop_column("messages", "edited_at")
    op.drop_column("messages", "updated_at")
    op.drop_column("messages", "thread_root_id")
    op.drop_column("messages", "parent_id")
