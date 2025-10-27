"""Extend user profile and add direct messaging tables."""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20241121_06"
down_revision = "20241118_05"
branch_labels = None
depends_on = None

PRESENCE_STATUS = sa.Enum("online", "idle", "dnd", name="presence_status")
FRIEND_REQUEST_STATUS = sa.Enum(
    "pending", "accepted", "declined", name="friend_request_status"
)


def upgrade() -> None:
    bind = op.get_bind()
    PRESENCE_STATUS.create(bind, checkfirst=True)
    FRIEND_REQUEST_STATUS.create(bind, checkfirst=True)

    op.add_column("users", sa.Column("avatar_path", sa.String(length=512), nullable=True))
    op.add_column(
        "users", sa.Column("avatar_content_type", sa.String(length=128), nullable=True)
    )
    op.add_column(
        "users",
        sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "presence_status",
            sa.Enum("online", "idle", "dnd", name="presence_status"),
            server_default="online",
            nullable=False,
        ),
    )

    op.create_table(
        "friend_links",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("requester_id", sa.Integer(), nullable=False),
        sa.Column("addressee_id", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("pending", "accepted", "declined", name="friend_request_status"),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["requester_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["addressee_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("requester_id", "addressee_id", name="uq_friend_link_pair"),
        mysql_charset="utf8mb4",
    )

    op.create_table(
        "direct_conversations",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("user_a_id", sa.Integer(), nullable=False),
        sa.Column("user_b_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_a_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_b_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_a_id", "user_b_id", name="uq_direct_conversation_pair"),
        mysql_charset="utf8mb4",
    )

    op.create_table(
        "direct_messages",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("conversation_id", sa.Integer(), nullable=False),
        sa.Column("sender_id", sa.Integer(), nullable=False),
        sa.Column("recipient_id", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["conversation_id"], ["direct_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.Index("ix_direct_messages_conversation", "conversation_id", "created_at"),
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("direct_messages")
    op.drop_table("direct_conversations")
    op.drop_table("friend_links")

    op.drop_column("users", "presence_status")
    op.drop_column("users", "avatar_updated_at")
    op.drop_column("users", "avatar_content_type")
    op.drop_column("users", "avatar_path")

    bind = op.get_bind()
    FRIEND_REQUEST_STATUS.drop(bind, checkfirst=True)
    PRESENCE_STATUS.drop(bind, checkfirst=True)
