"""add channel permission overwrites tables

Revision ID: 20241130_08
Revises: 20241128_07
Create Date: 2024-11-30 00:00:00
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20241130_08"
down_revision = "20241128_07"
branch_labels = None
depends_on = None

ROOM_ROLE = sa.Enum("owner", "admin", "member", "guest", name="room_role")


def upgrade() -> None:
    op.create_table(
        "channel_role_overwrites",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", ROOM_ROLE, nullable=False),
        sa.Column("allow_mask", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("deny_mask", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("channel_id", "role", name="uq_channel_role_overwrite"),
    )
    op.create_table(
        "channel_user_overwrites",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("allow_mask", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("deny_mask", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("channel_id", "user_id", name="uq_channel_user_overwrite"),
    )
    op.create_index(
        "ix_channel_user_overwrites_channel",
        "channel_user_overwrites",
        ["channel_id", "user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_channel_user_overwrites_channel", table_name="channel_user_overwrites")
    op.drop_table("channel_user_overwrites")
    op.drop_table("channel_role_overwrites")
