"""Database-backed search helpers for channel messages."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import Session

from app.models import Message


@dataclass(frozen=True)
class MessageSearchFilters:
    """Optional filters that can be applied to message search queries."""

    author_id: int | None = None
    has_attachments: bool | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    thread_root_id: int | None = None


@dataclass(frozen=True)
class MessageSearchResult:
    """Container for search results with optional ranking metadata."""

    messages: list[Message]
    ranks: list[float] | None = None


class MessageSearchService:
    """Perform full-text search on messages using the configured database backend."""

    def __init__(self, session: Session):
        self._session = session
        self._dialect: Dialect | None = session.get_bind().dialect if session.get_bind() else None

    def search(
        self,
        channel_id: int,
        query: str,
        *,
        limit: int,
        filters: MessageSearchFilters | None = None,
        options: Sequence = (),
    ) -> MessageSearchResult:
        """Search messages in the given channel using trigram similarity if available."""

        if filters is None:
            filters = MessageSearchFilters()

        stmt = select(Message).where(Message.channel_id == channel_id)

        conditions: list = []
        if query:
            conditions.append(self._build_matcher(query))
        if filters.author_id is not None:
            conditions.append(Message.author_id == filters.author_id)
        if filters.has_attachments is not None:
            if filters.has_attachments:
                conditions.append(Message.attachments.any())
            else:
                conditions.append(~Message.attachments.any())
        if filters.start_at is not None:
            conditions.append(Message.created_at >= filters.start_at)
        if filters.end_at is not None:
            conditions.append(Message.created_at <= filters.end_at)
        if filters.thread_root_id is not None:
            conditions.append(
                or_(
                    Message.id == filters.thread_root_id,
                    Message.thread_root_id == filters.thread_root_id,
                )
            )

        if conditions:
            stmt = stmt.where(and_(*conditions))

        if options:
            stmt = stmt.options(*options)

        similarity = self._similarity_expression(query) if query else None
        if similarity is not None:
            stmt = stmt.add_columns(similarity.label("rank"))
        else:
            stmt = stmt.order_by(Message.created_at.desc(), Message.id.desc())

        stmt = stmt.limit(limit)
        rows: Iterable[tuple] = self._session.execute(stmt).all()

        messages: list[Message] = []
        ranks: list[float] | None = [] if similarity is not None else None
        for row in rows:
            if similarity is not None:
                message, rank = row
                messages.append(message)
                if ranks is not None:
                    ranks.append(float(rank))
            else:
                (message,) = row
                messages.append(message)

        if similarity is not None:
            # Order results by rank descending, then timestamp ascending for stability.
            paired = sorted(
                zip(messages, ranks or []),
                key=lambda item: (-item[1], item[0].created_at, item[0].id),
            )
            messages = [message for message, _ in paired]
            ranks = [rank for _, rank in paired]

        return MessageSearchResult(messages=messages, ranks=ranks if ranks else None)

    # Internal helpers -----------------------------------------------------

    def _build_matcher(self, query: str):
        return Message.content.ilike(f"%{query}%")

    def _similarity_expression(self, query: str):  # pragma: no cover - dialect specific
        if not self._dialect or self._dialect.name != "postgresql":
            return None
        try:
            return func.similarity(Message.content, query)
        except Exception:
            return None
