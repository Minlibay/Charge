"""Expand direct conversations for group chats and notes."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import table, column
from sqlalchemy import Integer

# revision identifiers, used by Alembic.
revision = "20241210_10"
down_revision = "20241202_09"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("direct_conversations", "user_a_id", existing_type=sa.Integer(), nullable=True)
    op.alter_column("direct_conversations", "user_b_id", existing_type=sa.Integer(), nullable=True)
    op.drop_constraint("uq_direct_conversation_pair", "direct_conversations", type_="unique")

    op.add_column(
        "direct_conversations",
        sa.Column("creator_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "direct_conversations",
        sa.Column("title", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "direct_conversations",
        sa.Column("is_group", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_foreign_key(
        "fk_direct_conversations_creator",
        "direct_conversations",
        "users",
        ["creator_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "direct_conversation_participants",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("conversation_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("nickname", sa.String(length=128), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["conversation_id"], ["direct_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("conversation_id", "user_id", name="uq_direct_participant"),
        mysql_charset="utf8mb4",
    )

    op.alter_column("direct_messages", "recipient_id", existing_type=sa.Integer(), nullable=True)

    participants_table = table(
        "direct_conversation_participants",
        column("conversation_id", Integer),
        column("user_id", Integer),
    )

    conversations_table = table(
        "direct_conversations",
        column("id", Integer),
        column("user_a_id", Integer),
        column("user_b_id", Integer),
    )

    bind = op.get_bind()
    rows = bind.execute(
        sa.select(
            conversations_table.c.id,
            conversations_table.c.user_a_id,
            conversations_table.c.user_b_id,
        )
    ).fetchall()
    for row in rows:
        conversation_id = row.id
        user_ids = {value for value in (row.user_a_id, row.user_b_id) if value is not None}
        for user_id in user_ids:
            bind.execute(
                participants_table.insert().values(
                    conversation_id=conversation_id,
                    user_id=user_id,
                )
            )

    op.alter_column("direct_conversations", "is_group", server_default=None)


def downgrade() -> None:
    op.alter_column("direct_messages", "recipient_id", existing_type=sa.Integer(), nullable=False)
    op.drop_table("direct_conversation_participants")

    op.drop_constraint("fk_direct_conversations_creator", "direct_conversations", type_="foreignkey")
    op.drop_column("direct_conversations", "is_group")
    op.drop_column("direct_conversations", "title")
    op.drop_column("direct_conversations", "creator_id")

    op.create_unique_constraint(
        "uq_direct_conversation_pair",
        "direct_conversations",
        ["user_a_id", "user_b_id"],
    )
    op.alter_column("direct_conversations", "user_b_id", existing_type=sa.Integer(), nullable=False)
    op.alter_column("direct_conversations", "user_a_id", existing_type=sa.Integer(), nullable=False)
