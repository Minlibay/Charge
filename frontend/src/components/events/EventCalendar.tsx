import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { Event } from '../../types';
import { formatDateTime } from '../../utils/format';
import {
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  ClockIcon as Clock,
} from '../icons/LucideIcons';

interface EventCalendarProps {
  events: Event[];
  currentDate?: Date;
  onSelectEvent: (event: Event) => void;
  onDateChange?: (date: Date) => void;
}

export function EventCalendar({
  events,
  currentDate = new Date(),
  onSelectEvent,
  onDateChange,
}: EventCalendarProps): JSX.Element {
  const { t } = useTranslation();
  const [viewDate, setViewDate] = useState(new Date(currentDate.getFullYear(), currentDate.getMonth(), 1));

  const month = viewDate.getMonth();
  const year = viewDate.getFullYear();

  // Get first day of month and number of days
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  // Group events by date
  const eventsByDate = useMemo(() => {
    const grouped: Record<string, Event[]> = {};
    events.forEach((event) => {
      const eventDate = new Date(event.start_time);
      const dateKey = `${eventDate.getFullYear()}-${eventDate.getMonth()}-${eventDate.getDate()}`;
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey].push(event);
    });
    return grouped;
  }, [events]);

  const getEventsForDate = useCallback(
    (date: Date): Event[] => {
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      return eventsByDate[dateKey] || [];
    },
    [eventsByDate],
  );

  const navigateMonth = (direction: 'prev' | 'next') => {
    setViewDate((prev) => {
      const newDate = new Date(prev);
      if (direction === 'prev') {
        newDate.setMonth(prev.getMonth() - 1);
      } else {
        newDate.setMonth(prev.getMonth() + 1);
      }
      return newDate;
    });
  };

  const goToToday = () => {
    const today = new Date();
    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
    onDateChange?.(today);
  };

  const handleDateClick = (date: Date) => {
    onDateChange?.(date);
  };

  // Generate calendar days
  const calendarDays = useMemo(() => {
    const days: Array<{ date: Date; isCurrentMonth: boolean; isToday: boolean }> = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Previous month days
    for (let i = firstDayOfMonth - 1; i >= 0; i--) {
      const date = new Date(year, month - 1, daysInPrevMonth - i);
      const dateOnly = new Date(date);
      dateOnly.setHours(0, 0, 0, 0);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: dateOnly.getTime() === today.getTime(),
      });
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const dateOnly = new Date(date);
      dateOnly.setHours(0, 0, 0, 0);
      days.push({
        date,
        isCurrentMonth: true,
        isToday: dateOnly.getTime() === today.getTime(),
      });
    }

    // Next month days to fill the grid
    const totalCells = days.length;
    const remainingCells = 42 - totalCells; // 6 rows * 7 days
    for (let day = 1; day <= remainingCells; day++) {
      const date = new Date(year, month + 1, day);
      const dateOnly = new Date(date);
      dateOnly.setHours(0, 0, 0, 0);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: dateOnly.getTime() === today.getTime(),
      });
    }

    return days;
  }, [year, month, firstDayOfMonth, daysInMonth, daysInPrevMonth]);

  const monthName = viewDate.toLocaleDateString(t('common.locale', { defaultValue: 'en-US' }), {
    month: 'long',
    year: 'numeric',
  });

  const weekDays = useMemo(() => {
    const locale = t('common.locale', { defaultValue: 'en-US' });
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(2024, 0, i + 1); // Use a fixed date to get weekday names
      days.push(formatter.format(date));
    }
    return days;
  }, [t]);

  return (
    <div className="event-calendar">
      <div className="event-calendar__header">
        <div className="event-calendar__navigation">
          <button
            type="button"
            className="event-calendar__nav-button"
            onClick={() => navigateMonth('prev')}
            aria-label={t('events.calendar.prevMonth', { defaultValue: 'Предыдущий месяц' })}
          >
            <ChevronLeft size={20} />
          </button>
          <h2 className="event-calendar__month-title">{monthName}</h2>
          <button
            type="button"
            className="event-calendar__nav-button"
            onClick={() => navigateMonth('next')}
            aria-label={t('events.calendar.nextMonth', { defaultValue: 'Следующий месяц' })}
          >
            <ChevronRight size={20} />
          </button>
        </div>
        <button type="button" className="event-calendar__today-button" onClick={goToToday}>
          {t('events.calendar.today', { defaultValue: 'Сегодня' })}
        </button>
      </div>

      <div className="event-calendar__grid">
        <div className="event-calendar__weekdays">
          {weekDays.map((day, index) => (
            <div key={index} className="event-calendar__weekday">
              {day}
            </div>
          ))}
        </div>

        <div className="event-calendar__days">
          {calendarDays.map((day, index) => {
            const dayEvents = getEventsForDate(day.date);
            const isSelected = false; // Could be enhanced to track selected date

            return (
              <div
                key={index}
                className={clsx('event-calendar__day', {
                  'event-calendar__day--other-month': !day.isCurrentMonth,
                  'event-calendar__day--today': day.isToday,
                  'event-calendar__day--has-events': dayEvents.length > 0,
                })}
                onClick={() => handleDateClick(day.date)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    handleDateClick(day.date);
                  }
                }}
              >
                <div className="event-calendar__day-number">{day.date.getDate()}</div>
                {dayEvents.length > 0 && (
                  <div className="event-calendar__day-events">
                    {dayEvents.slice(0, 3).map((event) => (
                      <div
                        key={event.id}
                        className={clsx('event-calendar__day-event', {
                          'event-calendar__day-event--ongoing': event.status === 'ongoing',
                          'event-calendar__day-event--completed': event.status === 'completed',
                          'event-calendar__day-event--cancelled': event.status === 'cancelled',
                        })}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectEvent(event);
                        }}
                        title={event.title}
                      >
                        {event.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="event-calendar__day-event-more">
                        +{dayEvents.length - 3}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {events.length === 0 && (
        <div className="event-calendar__empty">
          <Calendar size={48} />
          <p>{t('events.calendar.empty', { defaultValue: 'Нет событий в этом месяце' })}</p>
        </div>
      )}
    </div>
  );
}

