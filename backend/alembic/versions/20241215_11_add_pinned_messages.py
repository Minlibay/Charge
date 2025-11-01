"""Create table for pinned channel messages."""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241215_11"
down_revision = "20241210_10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pinned_messages",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("pinned_by_id", sa.Integer(), nullable=True),
        sa.Column(
            "pinned_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["pinned_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("channel_id", "message_id", name="uq_channel_pinned_message"),
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_pins_channel_created_at",
        "pinned_messages",
        ["channel_id", "pinned_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_pins_channel_created_at", table_name="pinned_messages")
    op.drop_table("pinned_messages")
