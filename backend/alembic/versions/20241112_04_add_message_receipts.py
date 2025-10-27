"""Add message receipts for delivery and read tracking."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241112_04"
down_revision = "20241105_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("delivered_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "messages",
        sa.Column("read_count", sa.Integer(), nullable=False, server_default="0"),
    )

    op.create_table(
        "message_receipts",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("message_id", "user_id", name="uq_message_receipt"),
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_receipts_message", "message_receipts", ["message_id"])
    op.create_index("ix_receipts_user", "message_receipts", ["user_id"])

    op.alter_column("messages", "delivered_count", server_default=None)
    op.alter_column("messages", "read_count", server_default=None)


def downgrade() -> None:
    op.alter_column("messages", "read_count", server_default="0")
    op.alter_column("messages", "delivered_count", server_default="0")

    op.drop_index("ix_receipts_user", table_name="message_receipts")
    op.drop_index("ix_receipts_message", table_name="message_receipts")
    op.drop_table("message_receipts")

    op.drop_column("messages", "read_count")
    op.drop_column("messages", "delivered_count")
