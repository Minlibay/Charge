"""Service for sending event reminders."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import EventReminder

logger = logging.getLogger(__name__)


def send_event_reminders(db: Session) -> dict[str, int]:
    """
    Send reminders for events that are due.
    
    Returns:
        dict with counts of sent reminders.
    """
    now = datetime.now(timezone.utc)
    stats = {
        "reminders_sent": 0,
        "reminders_failed": 0,
    }

    try:
        # Find reminders that need to be sent
        # (reminders where reminder_time <= now and sent=False)
        due_reminders = (
            db.execute(
                select(EventReminder)
                .where(
                    EventReminder.sent == False,  # noqa: E712
                    EventReminder.reminder_time <= now,
                )
                .options(selectinload(EventReminder.event), selectinload(EventReminder.user))
            )
            .scalars()
            .all()
        )

        for reminder in due_reminders:
            try:
                # Mark reminder as sent
                reminder.sent = True
                reminder.sent_at = now

                # Get event and user info
                event = reminder.event
                user = reminder.user

                if not event or not user:
                    logger.warning(
                        f"Reminder {reminder.id} has missing event or user, skipping"
                    )
                    stats["reminders_failed"] += 1
                    continue

                # TODO: Integrate with notification system
                # For now, just log the reminder
                logger.info(
                    f"Reminder sent for event {event.id} ({event.title}) "
                    f"to user {user.id} ({user.login})"
                )

                # In the future, this would call:
                # - send_push_notification(user, event, reminder)
                # - send_email_notification(user, event, reminder)
                # - publish_workspace_event(...)

                stats["reminders_sent"] += 1

            except Exception as e:
                logger.error(
                    f"Error sending reminder {reminder.id}: {e}",
                    exc_info=True,
                )
                stats["reminders_failed"] += 1
                # Don't mark as sent if there was an error
                reminder.sent = False
                reminder.sent_at = None

        if stats["reminders_sent"] > 0:
            db.commit()
            logger.info(
                f"Sent {stats['reminders_sent']} reminder(s), "
                f"{stats['reminders_failed']} failed"
            )
        else:
            db.rollback()

    except Exception as e:
        db.rollback()
        logger.error(f"Error sending event reminders: {e}", exc_info=True)
        raise

    return stats

