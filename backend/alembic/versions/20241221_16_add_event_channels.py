"""Add event channel support."""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241221_16"
down_revision = "20241221_15"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create events table
    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("organizer_id", sa.Integer(), nullable=False),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("location", sa.String(512), nullable=True),
        sa.Column("image_url", sa.String(512), nullable=True),
        sa.Column("external_url", sa.String(512), nullable=True),
        sa.Column("status", sa.String(32), default="scheduled", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["organizer_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_events_channel", "events", ["channel_id"], unique=False)
    op.create_index("ix_events_start_time", "events", ["start_time"], unique=False)
    op.create_index("ix_events_status", "events", ["status"], unique=False)
    op.create_index("ix_events_organizer", "events", ["organizer_id"], unique=False)

    # Create event_participants table
    op.create_table(
        "event_participants",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("rsvp_status", sa.String(16), default="interested", nullable=False),
        sa.Column(
            "joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", "user_id", name="uq_event_participant"),
    )
    op.create_index("ix_event_participants_event", "event_participants", ["event_id"], unique=False)
    op.create_index("ix_event_participants_user", "event_participants", ["user_id"], unique=False)
    op.create_index(
        "ix_event_participants_status", "event_participants", ["rsvp_status"], unique=False
    )

    # Create event_reminders table
    op.create_table(
        "event_reminders",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("reminder_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent", sa.Boolean(), default=False, nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "event_id", "user_id", "reminder_time", name="uq_event_reminder"
        ),
    )
    op.create_index("ix_event_reminders_event", "event_reminders", ["event_id"], unique=False)
    op.create_index("ix_event_reminders_user", "event_reminders", ["user_id"], unique=False)
    op.create_index("ix_event_reminders_time", "event_reminders", ["reminder_time"], unique=False)
    op.create_index("ix_event_reminders_sent", "event_reminders", ["sent"], unique=False)


def downgrade() -> None:
    # Drop indexes for event_reminders
    op.drop_index("ix_event_reminders_sent", table_name="event_reminders")
    op.drop_index("ix_event_reminders_time", table_name="event_reminders")
    op.drop_index("ix_event_reminders_user", table_name="event_reminders")
    op.drop_index("ix_event_reminders_event", table_name="event_reminders")
    # Drop event_reminders table
    op.drop_table("event_reminders")

    # Drop indexes for event_participants
    op.drop_index("ix_event_participants_status", table_name="event_participants")
    op.drop_index("ix_event_participants_user", table_name="event_participants")
    op.drop_index("ix_event_participants_event", table_name="event_participants")
    # Drop event_participants table
    op.drop_table("event_participants")

    # Drop indexes for events
    op.drop_index("ix_events_organizer", table_name="events")
    op.drop_index("ix_events_status", table_name="events")
    op.drop_index("ix_events_start_time", table_name="events")
    op.drop_index("ix_events_channel", table_name="events")
    # Drop events table
    op.drop_table("events")

