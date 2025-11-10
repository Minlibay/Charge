"""Add custom roles and user role assignments."""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241220_12"
down_revision = "20241215_11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create custom_roles table
    op.create_table(
        "custom_roles",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("color", sa.String(length=7), nullable=False, server_default="#99AAB5"),
        sa.Column("icon", sa.String(length=512), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("hoist", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("mentionable", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("permissions_mask", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("room_id", "name", name="uq_custom_role_room_name"),
        mysql_charset="utf8mb4",
    )

    # Create indexes for custom_roles
    op.create_index("ix_custom_roles_room_id", "custom_roles", ["room_id"])
    op.create_index("ix_custom_roles_position", "custom_roles", ["room_id", "position"])

    # Create user_custom_roles table (many-to-many)
    op.create_table(
        "user_custom_roles",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("custom_role_id", sa.Integer(), nullable=False),
        sa.Column(
            "assigned_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["custom_role_id"], ["custom_roles.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "custom_role_id", name="uq_user_custom_role"),
        mysql_charset="utf8mb4",
    )

    # Create indexes for user_custom_roles
    op.create_index("ix_user_custom_roles_user_id", "user_custom_roles", ["user_id"])
    op.create_index("ix_user_custom_roles_role_id", "user_custom_roles", ["custom_role_id"])


def downgrade() -> None:
    # Drop indexes
    op.drop_index("ix_user_custom_roles_role_id", table_name="user_custom_roles")
    op.drop_index("ix_user_custom_roles_user_id", table_name="user_custom_roles")
    op.drop_index("ix_custom_roles_position", table_name="custom_roles")
    op.drop_index("ix_custom_roles_room_id", table_name="custom_roles")

    # Drop tables
    op.drop_table("user_custom_roles")
    op.drop_table("custom_roles")

