"""expand channel types and rename announcements value

Revision ID: 20241202_09
Revises: 20241130_08
Create Date: 2024-12-02 00:00:00
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20241202_09"
down_revision = "20241130_08"
branch_labels = None
depends_on = None

NEW_CHANNEL_TYPES = ("text", "voice", "stage", "announcements", "forums", "events")
LEGACY_CHANNEL_TYPES = ("text", "voice", "announcement")


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        op.execute("ALTER TYPE channel_type RENAME TO channel_type_old;")
        sa.Enum(*NEW_CHANNEL_TYPES, name="channel_type").create(bind, checkfirst=False)

        op.execute("ALTER TABLE channels ALTER COLUMN type TYPE text USING type::text;")
        op.execute(
            sa.text(
                "UPDATE channels SET type = 'announcements' WHERE type = 'announcement'"
            )
        )
        op.execute(
            "ALTER TABLE channels ALTER COLUMN type TYPE channel_type USING type::channel_type;"
        )
        op.execute("DROP TYPE channel_type_old;")
        return

    if dialect in {"mysql", "mariadb"}:
        op.execute(
            "ALTER TABLE channels MODIFY COLUMN type ENUM("
            "'text','voice','announcement','stage','announcements','forums','events') "
            "NOT NULL"
        )
        op.execute(
            sa.text(
                "UPDATE channels SET type = 'announcements' WHERE type = 'announcement'"
            )
        )
        op.execute(
            "ALTER TABLE channels MODIFY COLUMN type ENUM("
            "'text','voice','stage','announcements','forums','events') NOT NULL"
        )
        return

    raise RuntimeError(f"Unsupported database dialect '{dialect}' for this migration")


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        op.execute("ALTER TYPE channel_type RENAME TO channel_type_new;")
        sa.Enum(*LEGACY_CHANNEL_TYPES, name="channel_type").create(bind, checkfirst=False)

        op.execute("ALTER TABLE channels ALTER COLUMN type TYPE text USING type::text;")
        op.execute(
            sa.text(
                "UPDATE channels SET type = 'announcement' WHERE type = 'announcements'"
            )
        )
        op.execute(
            sa.text(
                "UPDATE channels SET type = 'text' WHERE type IN ('stage', 'forums', 'events')"
            )
        )
        op.execute(
            "ALTER TABLE channels ALTER COLUMN type TYPE channel_type USING type::channel_type;"
        )
        op.execute("DROP TYPE channel_type_new;")
        return

    if dialect in {"mysql", "mariadb"}:
        op.execute(
            "ALTER TABLE channels MODIFY COLUMN type ENUM("
            "'text','voice','stage','announcements','forums','events','announcement') "
            "NOT NULL"
        )
        op.execute(
            sa.text(
                "UPDATE channels SET type = 'announcement' WHERE type = 'announcements'"
            )
        )
        op.execute(
            sa.text(
                "UPDATE channels SET type = 'text' WHERE type IN ('stage', 'forums', 'events')"
            )
        )
        op.execute(
            "ALTER TABLE channels MODIFY COLUMN type ENUM("
            "'text','voice','announcement') NOT NULL"
        )
        return

    raise RuntimeError(f"Unsupported database dialect '{dialect}' for this migration")
