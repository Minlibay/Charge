import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { Channel, EventDetail, RoomMemberSummary, RoomRole } from '../../types';
import {
  getEvent,
  updateEvent,
  deleteEvent,
  createEventRSVP,
  deleteEventRSVP,
  getEventParticipants,
} from '../../services/api';
import { EditEventDialog } from '../dialogs/EditEventDialog';
import { formatDateTime } from '../../utils/format';
import { useToast } from '../ui';
import { resolveApiUrl } from '../../services/api';
import {
  ArrowLeftIcon as ArrowLeft,
  CalendarIcon as Calendar,
  ClockIcon as Clock,
  MapPinIcon as MapPin,
  UsersIcon as Users,
  ExternalLinkIcon as ExternalLink,
  EditIcon as Edit,
  Trash2Icon as Trash2,
  DownloadIcon as Download,
} from '../icons/LucideIcons';

interface EventDetailProps {
  channelId: number;
  eventId: number;
  members: RoomMemberSummary[];
  currentUserId: number | null;
  currentRole: RoomRole | null;
  onBack: () => void;
  onEventDeleted?: () => void;
  onEventUpdated?: (event: EventDetail) => void;
}

export function EventDetail({
  channelId,
  eventId,
  channel,
  members,
  currentUserId,
  currentRole,
  onBack,
  onEventDeleted,
  onEventUpdated,
}: EventDetailProps): JSX.Element {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<EventDetail['participants']>([]);
  const [rsvpStatus, setRsvpStatus] = useState<'yes' | 'no' | 'maybe' | 'interested' | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const loadEvent = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const eventData = await getEvent(channelId, eventId);
      setEvent(eventData);
      setParticipants(eventData.participants);
      setRsvpStatus(eventData.user_rsvp as 'yes' | 'no' | 'maybe' | 'interested' | null);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('events.loadError', { defaultValue: 'Не удалось загрузить событие' });
      setError(errorMessage);
      pushToast({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  }, [channelId, eventId, t, pushToast]);

  useEffect(() => {
    void loadEvent();
  }, [loadEvent]);

  // Listen for event events from WebSocket
  useEffect(() => {
    const handleEventEvent = (event: CustomEvent) => {
      const { type, channel_id, event: eventData, event_id } = event.detail;
      // Only handle events for this channel and event
      if (channel_id !== channelId || event_id !== eventId) return;

      if (type === 'event_updated') {
        // Reload the event to show updates
        void loadEvent();
      } else if (type === 'event_deleted') {
        // Event was deleted, go back
        onBack();
      } else if (type === 'event_rsvp_changed') {
        // RSVP changed, reload to update participant counts
        void loadEvent();
      }
    };

    window.addEventListener('event_event', handleEventEvent as EventListener);
    return () => {
      window.removeEventListener('event_event', handleEventEvent as EventListener);
    };
  }, [channelId, eventId, loadEvent, onBack]);

  const handleRSVP = async (status: 'yes' | 'no' | 'maybe' | 'interested') => {
    if (!event || !currentUserId) return;

    try {
      if (rsvpStatus) {
        // Update existing RSVP
        await createEventRSVP(channelId, eventId, { status });
      } else {
        // Create new RSVP
        await createEventRSVP(channelId, eventId, { status });
      }
      setRsvpStatus(status);
      void loadEvent(); // Reload to get updated participant counts
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('events.rsvpError', { defaultValue: 'Не удалось обновить RSVP' }),
      });
    }
  };

  const handleRemoveRSVP = async () => {
    if (!event || !currentUserId) return;

    try {
      await deleteEventRSVP(channelId, eventId);
      setRsvpStatus(null);
      void loadEvent();
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('events.rsvpError', { defaultValue: 'Не удалось удалить RSVP' }),
      });
    }
  };

  const handleDelete = async () => {
    if (!event) return;

    if (!confirm(t('events.deleteConfirm', { defaultValue: 'Вы уверены, что хотите удалить это событие?' }))) {
      return;
    }

    try {
      await deleteEvent(channelId, eventId);
      pushToast({
        type: 'success',
        message: t('events.deleted', { defaultValue: 'Событие удалено' }),
      });
      onEventDeleted?.();
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('events.deleteError', { defaultValue: 'Не удалось удалить событие' }),
      });
    }
  };

  const canManage = event && (
    event.organizer_id === currentUserId ||
    currentRole === 'owner' ||
    currentRole === 'admin'
  );

  if (loading) {
    return (
      <div className="event-detail event-detail--loading">
        <div className="event-detail__loader">
          {t('common.loading', { defaultValue: 'Загрузка...' })}
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="event-detail event-detail--error">
        <button type="button" className="event-detail__back-button" onClick={onBack}>
          <ArrowLeft size={20} />
          {t('common.back', { defaultValue: 'Назад' })}
        </button>
        <div className="event-detail__error">{error || t('events.notFound', { defaultValue: 'Событие не найдено' })}</div>
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

  const participantsByStatus = {
    yes: participants.filter((p) => p.rsvp_status === 'yes'),
    no: participants.filter((p) => p.rsvp_status === 'no'),
    maybe: participants.filter((p) => p.rsvp_status === 'maybe'),
    interested: participants.filter((p) => p.rsvp_status === 'interested'),
  };

  return (
    <div className="event-detail">
      <div className="event-detail__header">
        <button type="button" className="event-detail__back-button" onClick={onBack}>
          <ArrowLeft size={20} />
          {t('common.back', { defaultValue: 'Назад' })}
        </button>
        <div className="event-detail__actions">
          <a
            href={resolveApiUrl(`/api/channels/${channelId}/events/${eventId}/export.ics`).toString()}
            download
            className="event-detail__action"
            title={t('events.exportToCalendar', { defaultValue: 'Экспортировать в календарь' })}
          >
            <Download size={16} />
            {t('events.export', { defaultValue: 'Экспорт' })}
          </a>
          {canManage && (
            <>
              <button
                type="button"
                className="event-detail__action"
                onClick={() => setShowEditDialog(true)}
              >
                <Edit size={16} />
                {t('events.edit', { defaultValue: 'Редактировать' })}
              </button>
              <button
                type="button"
                className="event-detail__action event-detail__action--danger"
                onClick={handleDelete}
              >
                <Trash2 size={16} />
                {t('events.delete', { defaultValue: 'Удалить' })}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="event-detail__content">
        <div className="event-detail__main">
          <div className="event-detail__title-section">
            <h1 className="event-detail__title">{event.title}</h1>
            <span
              className="event-detail__status"
              style={{ color: getStatusColor(event.status) }}
            >
              {getStatusLabel(event.status)}
            </span>
          </div>

          {event.description && (
            <div className="event-detail__description">
              <p>{event.description}</p>
            </div>
          )}

          <div className="event-detail__info">
            <div className="event-detail__info-item">
              <Calendar size={20} />
              <div>
                <div className="event-detail__info-label">
                  {t('events.startTime', { defaultValue: 'Начало' })}
                </div>
                <time dateTime={event.start_time}>
                  {formatDateTime(event.start_time)}
                </time>
              </div>
            </div>

            {event.end_time && (
              <div className="event-detail__info-item">
                <Clock size={20} />
                <div>
                  <div className="event-detail__info-label">
                    {t('events.endTime', { defaultValue: 'Окончание' })}
                  </div>
                  <time dateTime={event.end_time}>
                    {formatDateTime(event.end_time)}
                  </time>
                </div>
              </div>
            )}

            {event.location && (
              <div className="event-detail__info-item">
                <MapPin size={20} />
                <div>
                  <div className="event-detail__info-label">
                    {t('events.location', { defaultValue: 'Место' })}
                  </div>
                  <span>{event.location}</span>
                </div>
              </div>
            )}

            {event.external_url && (
              <div className="event-detail__info-item">
                <ExternalLink size={20} />
                <div>
                  <a
                    href={event.external_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="event-detail__external-link"
                  >
                    {t('events.externalLink', { defaultValue: 'Внешняя ссылка' })}
                  </a>
                </div>
              </div>
            )}

            <div className="event-detail__info-item">
              <Users size={20} />
              <div>
                <div className="event-detail__info-label">
                  {t('events.organizer', { defaultValue: 'Организатор' })}
                </div>
                <span>{event.organizer.display_name || event.organizer.login}</span>
              </div>
            </div>
          </div>

          {currentUserId && (
            <div className="event-detail__rsvp">
              <h3 className="event-detail__rsvp-title">
                {t('events.yourResponse', { defaultValue: 'Ваш ответ' })}
              </h3>
              <div className="event-detail__rsvp-buttons">
                <button
                  type="button"
                  className={clsx('event-detail__rsvp-button', {
                    'event-detail__rsvp-button--active': rsvpStatus === 'yes',
                  })}
                  onClick={() => void handleRSVP('yes')}
                >
                  {t('events.rsvp.yes', { defaultValue: 'Да' })}
                </button>
                <button
                  type="button"
                  className={clsx('event-detail__rsvp-button', {
                    'event-detail__rsvp-button--active': rsvpStatus === 'maybe',
                  })}
                  onClick={() => void handleRSVP('maybe')}
                >
                  {t('events.rsvp.maybe', { defaultValue: 'Возможно' })}
                </button>
                <button
                  type="button"
                  className={clsx('event-detail__rsvp-button', {
                    'event-detail__rsvp-button--active': rsvpStatus === 'interested',
                  })}
                  onClick={() => void handleRSVP('interested')}
                >
                  {t('events.rsvp.interested', { defaultValue: 'Интересно' })}
                </button>
                <button
                  type="button"
                  className={clsx('event-detail__rsvp-button', {
                    'event-detail__rsvp-button--active': rsvpStatus === 'no',
                  })}
                  onClick={() => void handleRSVP('no')}
                >
                  {t('events.rsvp.no', { defaultValue: 'Нет' })}
                </button>
                {rsvpStatus && (
                  <button
                    type="button"
                    className="event-detail__rsvp-button event-detail__rsvp-button--remove"
                    onClick={() => void handleRemoveRSVP()}
                  >
                    {t('events.rsvp.remove', { defaultValue: 'Удалить ответ' })}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="event-detail__participants">
            <h3 className="event-detail__participants-title">
              {t('events.participants', { count: event.participant_count, defaultValue: 'Участники ({{count}})' })}
            </h3>

            {event.participant_count > 0 ? (
              <div className="event-detail__participants-list">
                {participantsByStatus.yes.length > 0 && (
                  <div className="event-detail__participants-group">
                    <h4 className="event-detail__participants-group-title">
                      {t('events.rsvp.yes', { defaultValue: 'Да' })} ({participantsByStatus.yes.length})
                    </h4>
                    <div className="event-detail__participants-names">
                      {participantsByStatus.yes.map((p) => (
                        <span key={p.id} className="event-detail__participant">
                          {p.user.display_name || p.user.login}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {participantsByStatus.maybe.length > 0 && (
                  <div className="event-detail__participants-group">
                    <h4 className="event-detail__participants-group-title">
                      {t('events.rsvp.maybe', { defaultValue: 'Возможно' })} ({participantsByStatus.maybe.length})
                    </h4>
                    <div className="event-detail__participants-names">
                      {participantsByStatus.maybe.map((p) => (
                        <span key={p.id} className="event-detail__participant">
                          {p.user.display_name || p.user.login}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {participantsByStatus.interested.length > 0 && (
                  <div className="event-detail__participants-group">
                    <h4 className="event-detail__participants-group-title">
                      {t('events.rsvp.interested', { defaultValue: 'Интересно' })} ({participantsByStatus.interested.length})
                    </h4>
                    <div className="event-detail__participants-names">
                      {participantsByStatus.interested.map((p) => (
                        <span key={p.id} className="event-detail__participant">
                          {p.user.display_name || p.user.login}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {participantsByStatus.no.length > 0 && (
                  <div className="event-detail__participants-group">
                    <h4 className="event-detail__participants-group-title">
                      {t('events.rsvp.no', { defaultValue: 'Нет' })} ({participantsByStatus.no.length})
                    </h4>
                    <div className="event-detail__participants-names">
                      {participantsByStatus.no.map((p) => (
                        <span key={p.id} className="event-detail__participant">
                          {p.user.display_name || p.user.login}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="event-detail__no-participants">
                {t('events.noParticipants', { defaultValue: 'Пока нет участников' })}
              </p>
            )}
          </div>
        </div>
      </div>
      {showEditDialog && channel && (
        <EditEventDialog
          open={showEditDialog}
          channel={channel}
          eventId={eventId}
          onClose={() => setShowEditDialog(false)}
          onSuccess={(updatedEvent) => {
            setEvent(updatedEvent);
            setShowEditDialog(false);
            onEventUpdated?.(updatedEvent);
          }}
        />
      )}
    </div>
  );
}

