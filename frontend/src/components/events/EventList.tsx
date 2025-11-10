import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { Event, Channel } from '../../types';
import { listEvents } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { useToast } from '../ui';
import { CalendarIcon as Calendar, ClockIcon as Clock, MapPinIcon as MapPin, UsersIcon as Users } from '../icons/LucideIcons';

interface EventListProps {
  channel: Channel;
  currentUserId: number | null;
  onSelectEvent: (event: Event) => void;
  onCreateEvent?: () => void;
}

export function EventList({
  channel,
  currentUserId,
  onSelectEvent,
  onCreateEvent,
}: EventListProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const { pushToast } = useToast();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'scheduled' | 'ongoing' | 'completed' | 'cancelled' | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');

  const loadEvents = useCallback(async () => {
    if (!channel) return;

    setLoading(true);
    setError(null);

    try {
      const result = await listEvents(channel.id, {
        page,
        page_size: 20,
        status: statusFilter || undefined,
      });

      if (page === 1) {
        setEvents(result.items);
      } else {
        setEvents((prev) => [...prev, ...result.items]);
      }
      setTotal(result.total);
      setHasMore(result.has_more);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('events.loadError', { defaultValue: 'Не удалось загрузить события' });
      setError(errorMessage);
      pushToast({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  }, [channel, page, statusFilter, t, pushToast]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  const handleStatusFilter = (status: 'scheduled' | 'ongoing' | 'completed' | 'cancelled' | null) => {
    setStatusFilter(status);
  };

  if (loading && events.length === 0) {
    return (
      <div className="event-list event-list--loading">
        <div className="event-list__loader">
          {t('common.loading', { defaultValue: 'Загрузка...' })}
        </div>
      </div>
    );
  }

  if (error && events.length === 0) {
    return (
      <div className="event-list event-list--error">
        <div className="event-list__error">{error}</div>
        <button
          type="button"
          className="event-list__retry"
          onClick={() => void loadEvents()}
        >
          {t('common.retry', { defaultValue: 'Повторить' })}
        </button>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'scheduled':
        return 'var(--color-primary)';
      case 'ongoing':
        return 'var(--color-success)';
      case 'completed':
        return 'var(--color-text-muted)';
      case 'cancelled':
        return 'var(--color-danger)';
      default:
        return 'var(--color-text-muted)';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'scheduled':
        return t('events.status.scheduled', { defaultValue: 'Запланировано' });
      case 'ongoing':
        return t('events.status.ongoing', { defaultValue: 'Идет сейчас' });
      case 'completed':
        return t('events.status.completed', { defaultValue: 'Завершено' });
      case 'cancelled':
        return t('events.status.cancelled', { defaultValue: 'Отменено' });
      default:
        return status;
    }
  };

  return (
    <div className="event-list">
      <div className="event-list__header">
        <h2 className="event-list__title">
          {t('events.title', { defaultValue: 'События' })}
        </h2>
        <div className="event-list__controls">
          <div className="event-list__filters">
            <button
              type="button"
              className={clsx('event-list__filter-button', {
                'event-list__filter-button--active': statusFilter === null,
              })}
              onClick={() => handleStatusFilter(null)}
            >
              {t('events.filter.all', { defaultValue: 'Все' })}
            </button>
            <button
              type="button"
              className={clsx('event-list__filter-button', {
                'event-list__filter-button--active': statusFilter === 'scheduled',
              })}
              onClick={() => handleStatusFilter('scheduled')}
            >
              {t('events.filter.scheduled', { defaultValue: 'Запланированные' })}
            </button>
            <button
              type="button"
              className={clsx('event-list__filter-button', {
                'event-list__filter-button--active': statusFilter === 'ongoing',
              })}
              onClick={() => handleStatusFilter('ongoing')}
            >
              {t('events.filter.ongoing', { defaultValue: 'Идут сейчас' })}
            </button>
            <button
              type="button"
              className={clsx('event-list__filter-button', {
                'event-list__filter-button--active': statusFilter === 'completed',
              })}
              onClick={() => handleStatusFilter('completed')}
            >
              {t('events.filter.completed', { defaultValue: 'Завершенные' })}
            </button>
          </div>
          {onCreateEvent && (
            <button
              type="button"
              className="event-list__create-button"
              onClick={onCreateEvent}
            >
              {t('events.create', { defaultValue: 'Создать событие' })}
            </button>
          )}
        </div>
      </div>

      <div className="event-list__content">
        {events.length === 0 ? (
          <div className="event-list__empty">
            <Calendar size={48} />
            <p>{t('events.empty', { defaultValue: 'Событий пока нет' })}</p>
            {onCreateEvent && (
              <button
                type="button"
                className="event-list__create-button"
                onClick={onCreateEvent}
              >
                {t('events.createFirst', { defaultValue: 'Создать первое событие' })}
              </button>
            )}
          </div>
        ) : (
          <div className="event-list__events">
            {events.map((event) => (
              <div
                key={event.id}
                className={clsx('event-card', {
                  'event-card--ongoing': event.status === 'ongoing',
                  'event-card--completed': event.status === 'completed',
                  'event-card--cancelled': event.status === 'cancelled',
                })}
                onClick={() => onSelectEvent(event)}
              >
                <div className="event-card__header">
                  <h3 className="event-card__title">{event.title}</h3>
                  <span
                    className="event-card__status"
                    style={{ color: getStatusColor(event.status) }}
                  >
                    {getStatusLabel(event.status)}
                  </span>
                </div>

                {event.description && (
                  <p className="event-card__description">{event.description}</p>
                )}

                <div className="event-card__meta">
                  <div className="event-card__time">
                    <Clock size={16} />
                    <time dateTime={event.start_time}>
                      {formatDateTime(event.start_time)}
                    </time>
                    {event.end_time && (
                      <>
                        <span> - </span>
                        <time dateTime={event.end_time}>
                          {formatDateTime(event.end_time)}
                        </time>
                      </>
                    )}
                  </div>

                  {event.location && (
                    <div className="event-card__location">
                      <MapPin size={16} />
                      <span>{event.location}</span>
                    </div>
                  )}

                  <div className="event-card__participants">
                    <Users size={16} />
                    <span>
                      {event.participant_count > 0
                        ? t('events.participants', {
                            count: event.participant_count,
                            defaultValue: '{{count}} участников',
                          })
                        : t('events.noParticipants', { defaultValue: 'Нет участников' })}
                    </span>
                  </div>
                </div>

                {event.user_rsvp && (
                  <div className="event-card__rsvp">
                    {t('events.yourRSVP', {
                      status: event.user_rsvp,
                      defaultValue: 'Ваш ответ: {{status}}',
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {hasMore && (
          <button
            type="button"
            className="event-list__load-more"
            onClick={() => setPage((prev) => prev + 1)}
            disabled={loading}
          >
            {loading
              ? t('common.loading', { defaultValue: 'Загрузка...' })
              : t('common.loadMore', { defaultValue: 'Загрузить еще' })}
          </button>
        )}
      </div>
    </div>
  );
}

