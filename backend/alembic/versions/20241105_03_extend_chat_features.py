"""extend chat features with categories invitations and roles

Revision ID: 20241105_03
Revises: 20241026_02
Create Date: 2024-11-05 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241105_03"
down_revision = "20241026_02"
branch_labels = None
depends_on = None


ROOM_ROLE = sa.Enum("owner", "admin", "member", "guest", name="room_role")


def upgrade() -> None:
    op.create_table(
        "channel_categories",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("room_id", "name", name="uq_category_room_name"),
        mysql_charset="utf8mb4",
    )

    op.add_column(
        "channels",
        sa.Column("category_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_channels_category_id",
        "channels",
        "channel_categories",
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "room_invitations",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("role", ROOM_ROLE, nullable=False, server_default="member"),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("code", name="uq_room_invitation_code"),
        mysql_charset="utf8mb4",
    )

    op.create_table(
        "room_role_hierarchy",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=False),
        sa.Column("role", ROOM_ROLE, nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("room_id", "role", name="uq_room_role_level"),
        mysql_charset="utf8mb4",
    )

    rooms_table = sa.table("rooms", sa.column("id", sa.Integer()))
    hierarchy_table = sa.table(
        "room_role_hierarchy",
        sa.column("room_id", sa.Integer()),
        sa.column("role", ROOM_ROLE),
        sa.column("level", sa.Integer()),
    )

    default_levels = {
        "owner": 400,
        "admin": 300,
        "member": 200,
        "guest": 100,
    }

    connection = op.get_bind()
    room_ids = [row.id for row in connection.execute(sa.select(rooms_table.c.id))]
    if room_ids:
        for room_id in room_ids:
            for role_name, level in default_levels.items():
                connection.execute(
                    hierarchy_table.insert().values(
                        room_id=room_id,
                        role=role_name,
                        level=level,
                    )
                )


def downgrade() -> None:
    op.drop_table("room_role_hierarchy")
    op.drop_table("room_invitations")
    op.drop_constraint("fk_channels_category_id", "channels", type_="foreignkey")
    op.drop_column("channels", "category_id")
    op.drop_table("channel_categories")
