"""Service for automatically updating event statuses."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, and_, select
from sqlalchemy.orm import Session

from app.models import Event

logger = logging.getLogger(__name__)


def update_event_statuses(db: Session) -> dict[str, int]:
    """
    Update event statuses based on current time.
    
    Returns:
        dict with counts of updated events by status change type.
    """
    now = datetime.now(timezone.utc)
    stats = {
        "scheduled_to_ongoing": 0,
        "ongoing_to_completed": 0,
        "total_updated": 0,
    }

    try:
        # Find events that should be marked as ongoing
        # (scheduled events where start_time has passed)
        scheduled_to_ongoing = db.execute(
            select(Event).where(
                Event.status == "scheduled",
                Event.start_time <= now,
            )
        ).scalars().all()

        for event in scheduled_to_ongoing:
            event.status = "ongoing"
            stats["scheduled_to_ongoing"] += 1
            logger.info(
                f"Event {event.id} ({event.title}) status updated: scheduled -> ongoing"
            )
            
            # WebSocket events will be published from the API endpoint
            # to avoid circular imports

        # Find events that should be marked as completed
        # (ongoing events where end_time has passed, or no end_time but start_time was more than 24h ago)
        ongoing_to_completed = db.execute(
            select(Event).where(
                Event.status == "ongoing",
                or_(
                    and_(Event.end_time.isnot(None), Event.end_time <= now),
                    and_(
                        Event.end_time.is_(None),
                        Event.start_time <= now - timedelta(hours=24),
                    ),
                ),
            )
        ).scalars().all()

        for event in ongoing_to_completed:
            event.status = "completed"
            stats["ongoing_to_completed"] += 1
            logger.info(
                f"Event {event.id} ({event.title}) status updated: ongoing -> completed"
            )
            
            # WebSocket events will be published from the API endpoint
            # to avoid circular imports

        stats["total_updated"] = stats["scheduled_to_ongoing"] + stats["ongoing_to_completed"]

        if stats["total_updated"] > 0:
            db.commit()
            logger.info(
                f"Updated {stats['total_updated']} event(s): "
                f"{stats['scheduled_to_ongoing']} scheduled->ongoing, "
                f"{stats['ongoing_to_completed']} ongoing->completed"
            )
        else:
            db.rollback()

    except Exception as e:
        db.rollback()
        logger.error(f"Error updating event statuses: {e}", exc_info=True)
        raise

    return stats

