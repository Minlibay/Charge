"""add channel positions for ordering

Revision ID: 20241128_07
Revises: 20241121_06
Create Date: 2024-11-28 00:00:00
"""

from typing import Dict, Tuple

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20241128_07"
down_revision = "20241121_06"
branch_labels = None
depends_on = None

channels_table = sa.table(
    "channels",
    sa.column("id", sa.Integer()),
    sa.column("room_id", sa.Integer()),
    sa.column("category_id", sa.Integer()),
    sa.column("letter", sa.String(length=1)),
    sa.column("position", sa.Integer()),
)


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )

    bind = op.get_bind()
    result = bind.execute(
        sa.select(
            channels_table.c.id,
            channels_table.c.room_id,
            channels_table.c.category_id,
            channels_table.c.letter,
        ).order_by(
            channels_table.c.room_id,
            channels_table.c.category_id.asc().nullsfirst(),
            channels_table.c.letter,
        )
    )

    counters: Dict[Tuple[int, int | None], int] = {}
    for row in result:
        key = (row.room_id, row.category_id)
        position = counters.get(key, 0)
        bind.execute(
            sa.update(channels_table).where(channels_table.c.id == row.id).values(position=position)
        )
        counters[key] = position + 1

    op.alter_column("channels", "position", server_default=None)


def downgrade() -> None:
    op.drop_column("channels", "position")
