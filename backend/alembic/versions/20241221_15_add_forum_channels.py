"""Add forum channel support."""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241221_15"
down_revision = "20241221_14"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create forum_posts table
    op.create_table(
        "forum_posts",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("author_id", sa.Integer(), nullable=False),
        sa.Column("is_pinned", sa.Boolean(), default=False, nullable=False),
        sa.Column("is_archived", sa.Boolean(), default=False, nullable=False),
        sa.Column("is_locked", sa.Boolean(), default=False, nullable=False),
        sa.Column("reply_count", sa.Integer(), default=0, nullable=False),
        sa.Column("last_reply_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_reply_by_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["last_reply_by_id"], ["users.id"]),
        sa.UniqueConstraint("message_id", name="uq_forum_post_message"),
        mysql_charset="utf8mb4",
    )

    # Create indexes for forum_posts
    op.create_index("ix_forum_posts_channel", "forum_posts", ["channel_id"])
    op.create_index("ix_forum_posts_message", "forum_posts", ["message_id"])
    op.create_index("ix_forum_posts_author", "forum_posts", ["author_id"])
    op.create_index("ix_forum_posts_last_reply", "forum_posts", ["last_reply_at"])
    op.create_index("ix_forum_posts_pinned", "forum_posts", ["is_pinned"])

    # Create forum_post_tags table
    op.create_table(
        "forum_post_tags",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("post_id", sa.Integer(), nullable=False),
        sa.Column("tag_name", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["post_id"], ["forum_posts.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("post_id", "tag_name", name="uq_forum_post_tag"),
        mysql_charset="utf8mb4",
    )

    # Create indexes for forum_post_tags
    op.create_index("ix_forum_post_tags_post", "forum_post_tags", ["post_id"])
    op.create_index("ix_forum_post_tags_name", "forum_post_tags", ["tag_name"])

    # Create forum_channel_tags table
    op.create_table(
        "forum_channel_tags",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("color", sa.String(7), nullable=False, server_default="#99AAB5"),
        sa.Column("emoji", sa.String(32), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("channel_id", "name", name="uq_forum_channel_tag"),
        mysql_charset="utf8mb4",
    )

    # Create index for forum_channel_tags
    op.create_index("ix_forum_channel_tags_channel", "forum_channel_tags", ["channel_id"])


def downgrade() -> None:
    # Drop indexes
    op.drop_index("ix_forum_channel_tags_channel", table_name="forum_channel_tags")
    op.drop_index("ix_forum_post_tags_name", table_name="forum_post_tags")
    op.drop_index("ix_forum_post_tags_post", table_name="forum_post_tags")
    op.drop_index("ix_forum_posts_pinned", table_name="forum_posts")
    op.drop_index("ix_forum_posts_last_reply", table_name="forum_posts")
    op.drop_index("ix_forum_posts_author", table_name="forum_posts")
    op.drop_index("ix_forum_posts_message", table_name="forum_posts")
    op.drop_index("ix_forum_posts_channel", table_name="forum_posts")

    # Drop tables
    op.drop_table("forum_channel_tags")
    op.drop_table("forum_post_tags")
    op.drop_table("forum_posts")

