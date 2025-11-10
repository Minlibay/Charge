import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Channel, EventDetail, EventUpdate } from '../../types';
import { updateEvent, getEvent } from '../../services/api';
import { XIcon } from '../icons/LucideIcons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
  Input,
  useToast,
} from '../ui';

interface EditEventDialogProps {
  open: boolean;
  channel: Channel | null;
  eventId: number | null;
  onClose: () => void;
  onSuccess?: (event: EventDetail) => void;
}

export function EditEventDialog({
  open,
  channel,
  eventId,
  onClose,
  onSuccess,
}: EditEventDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [status, setStatus] = useState<'scheduled' | 'ongoing' | 'completed' | 'cancelled'>('scheduled');
  const [loading, setLoading] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && channel && eventId) {
      setError(null);
      void loadEvent();
    }
  }, [open, channel, eventId]);

  const loadEvent = async () => {
    if (!channel || !eventId) return;

    setLoadingEvent(true);
    try {
      const event = await getEvent(channel.id, eventId);
      setTitle(event.title);
      setDescription(event.description || '');
      // Convert ISO datetime to local datetime-local format
      const startDate = new Date(event.start_time);
      const endDate = event.end_time ? new Date(event.end_time) : null;
      
      // Format for datetime-local input (YYYY-MM-DDTHH:mm)
      const formatForInput = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
      };
      
      setStartTime(formatForInput(startDate));
      setEndTime(endDate ? formatForInput(endDate) : '');
      setLocation(event.location || '');
      setExternalUrl(event.external_url || '');
      setStatus(event.status);
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
      setLoadingEvent(false);
    }
  };

  const handleSubmit = async () => {
    if (!channel || !eventId) return;

    if (!title.trim()) {
      setError(t('events.titleRequired', { defaultValue: 'Название обязательно' }));
      return;
    }

    if (!startTime) {
      setError(t('events.startTimeRequired', { defaultValue: 'Время начала обязательно' }));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload: EventUpdate = {
        title: title.trim(),
        description: description.trim() || null,
        start_time: new Date(startTime).toISOString(),
        end_time: endTime ? new Date(endTime).toISOString() : null,
        location: location.trim() || null,
        external_url: externalUrl.trim() || null,
        status: status,
      };

      const event = await updateEvent(channel.id, eventId, payload);

      pushToast({
        type: 'success',
        message: t('events.updated', { defaultValue: 'Событие обновлено' }),
      });

      onSuccess?.(event);
      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('events.updateError', { defaultValue: 'Не удалось обновить событие' });
      setError(errorMessage);
      pushToast({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="edit-event-dialog">
        <DialogHeader>
          <DialogTitle>{t('events.edit', { defaultValue: 'Редактировать событие' })}</DialogTitle>
          <button
            type="button"
            className="dialog__close"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Закрыть' })}
          >
            <XIcon size={20} />
          </button>
        </DialogHeader>

        <div className="edit-event-dialog__form">
          {loadingEvent ? (
            <div className="edit-event-dialog__loading">
              {t('common.loading', { defaultValue: 'Загрузка...' })}
            </div>
          ) : (
            <>
              {error && <div className="edit-event-dialog__error">{error}</div>}

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-title">
                  {t('events.title', { defaultValue: 'Название' })} *
                </Label>
                <Input
                  id="edit-event-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('events.titlePlaceholder', { defaultValue: 'Введите название события' })}
                  maxLength={256}
                />
              </div>

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-description">
                  {t('events.description', { defaultValue: 'Описание' })}
                </Label>
                <Textarea
                  id="edit-event-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('events.descriptionPlaceholder', { defaultValue: 'Описание события (необязательно)' })}
                  rows={4}
                />
              </div>

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-start-time">
                  {t('events.startTime', { defaultValue: 'Начало' })} *
                </Label>
                <Input
                  id="edit-event-start-time"
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  required
                />
              </div>

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-end-time">
                  {t('events.endTime', { defaultValue: 'Окончание' })}
                </Label>
                <Input
                  id="edit-event-end-time"
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  min={startTime || undefined}
                />
              </div>

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-location">
                  {t('events.location', { defaultValue: 'Место' })}
                </Label>
                <Input
                  id="edit-event-location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder={t('events.locationPlaceholder', { defaultValue: 'Место проведения (необязательно)' })}
                  maxLength={512}
                />
              </div>

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-external-url">
                  {t('events.externalLink', { defaultValue: 'Внешняя ссылка' })}
                </Label>
                <Input
                  id="edit-event-external-url"
                  type="url"
                  value={externalUrl}
                  onChange={(e) => setExternalUrl(e.target.value)}
                  placeholder={t('events.externalUrlPlaceholder', { defaultValue: 'https://...' })}
                  maxLength={512}
                />
              </div>

              <div className="edit-event-dialog__field">
                <Label htmlFor="edit-event-status">
                  {t('events.status', { defaultValue: 'Статус' })}
                </Label>
                <select
                  id="edit-event-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                  className="edit-event-dialog__select"
                >
                  <option value="scheduled">
                    {t('events.status.scheduled', { defaultValue: 'Запланировано' })}
                  </option>
                  <option value="ongoing">
                    {t('events.status.ongoing', { defaultValue: 'Идет сейчас' })}
                  </option>
                  <option value="completed">
                    {t('events.status.completed', { defaultValue: 'Завершено' })}
                  </option>
                  <option value="cancelled">
                    {t('events.status.cancelled', { defaultValue: 'Отменено' })}
                  </option>
                </select>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={loading || loadingEvent}>
            {t('common.cancel', { defaultValue: 'Отмена' })}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading || loadingEvent || !title.trim() || !startTime}
          >
            {loading
              ? t('common.saving', { defaultValue: 'Сохранение...' })
              : t('events.save', { defaultValue: 'Сохранить' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
    document.body,
  );
}

