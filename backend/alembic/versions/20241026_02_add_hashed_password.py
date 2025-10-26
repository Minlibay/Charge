"""add hashed_password column to users

Revision ID: 20241026_02
Revises: 20240705_01
Create Date: 2024-10-26 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20241026_02"
down_revision = "20240705_01"
branch_labels = None
depends_on = None


USERS_TABLE = "users"
COLUMN_NAME = "hashed_password"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_columns = {column["name"] for column in inspector.get_columns(USERS_TABLE)}

    if COLUMN_NAME in existing_columns:
        return

    op.add_column(
        USERS_TABLE,
        sa.Column(
            COLUMN_NAME,
            sa.String(length=255),
            nullable=False,
            server_default="",
        ),
    )
    op.alter_column(USERS_TABLE, COLUMN_NAME, server_default=None)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_columns = {column["name"] for column in inspector.get_columns(USERS_TABLE)}

    if COLUMN_NAME not in existing_columns:
        return

    op.drop_column(USERS_TABLE, COLUMN_NAME)
