"""Add announcement cross-posting support."""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241221_14"
down_revision = "20241221_13"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create announcement_cross_posts table
    op.create_table(
        "announcement_cross_posts",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("original_message_id", sa.Integer(), nullable=False),
        sa.Column("cross_posted_message_id", sa.Integer(), nullable=False),
        sa.Column("target_channel_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["original_message_id"], ["messages.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["cross_posted_message_id"], ["messages.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["target_channel_id"], ["channels.id"], ondelete="CASCADE"
        ),
        mysql_charset="utf8mb4",
    )

    # Create indexes for announcement_cross_posts
    op.create_index(
        "ix_cross_posts_original", "announcement_cross_posts", ["original_message_id"]
    )
    op.create_index(
        "ix_cross_posts_cross_posted", "announcement_cross_posts", ["cross_posted_message_id"]
    )
    op.create_index(
        "ix_cross_posts_target_channel", "announcement_cross_posts", ["target_channel_id"]
    )


def downgrade() -> None:
    # Drop indexes
    op.drop_index("ix_cross_posts_target_channel", table_name="announcement_cross_posts")
    op.drop_index("ix_cross_posts_cross_posted", table_name="announcement_cross_posts")
    op.drop_index("ix_cross_posts_original", table_name="announcement_cross_posts")

    # Drop table
    op.drop_table("announcement_cross_posts")

