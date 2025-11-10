"""Extend channel model with topic, slowmode, NSFW, private, and archive settings."""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241221_13"
down_revision = "20241220_12"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add new columns to channels table
    op.add_column("channels", sa.Column("topic", sa.Text(), nullable=True))
    op.add_column("channels", sa.Column("slowmode_seconds", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("channels", sa.Column("is_nsfw", sa.Boolean(), nullable=False, server_default="0"))
    op.add_column("channels", sa.Column("is_private", sa.Boolean(), nullable=False, server_default="0"))
    op.add_column("channels", sa.Column("is_archived", sa.Boolean(), nullable=False, server_default="0"))
    op.add_column("channels", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("channels", sa.Column("archived_by_id", sa.Integer(), nullable=True))
    
    # Add foreign key for archived_by_id
    op.create_foreign_key(
        "fk_channels_archived_by_id",
        "channels",
        "users",
        ["archived_by_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    # Remove foreign key
    op.drop_constraint("fk_channels_archived_by_id", "channels", type_="foreignkey")
    
    # Remove columns
    op.drop_column("channels", "archived_by_id")
    op.drop_column("channels", "archived_at")
    op.drop_column("channels", "is_archived")
    op.drop_column("channels", "is_private")
    op.drop_column("channels", "is_nsfw")
    op.drop_column("channels", "slowmode_seconds")
    op.drop_column("channels", "topic")

