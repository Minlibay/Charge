import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Channel, EventDetail } from '../../types';
import { createEvent } from '../../services/api';
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

interface CreateEventDialogProps {
  open: boolean;
  channel: Channel | null;
  onClose: () => void;
  onSuccess?: (event: EventDetail) => void;
}

export function CreateEventDialog({
  open,
  channel,
  onClose,
  onSuccess,
}: CreateEventDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [reminderMinutes, setReminderMinutes] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setStartTime('');
      setEndTime('');
      setLocation('');
      setExternalUrl('');
      setReminderMinutes([]);
      setError(null);
    }
  }, [open]);

  const handleToggleReminder = (minutes: number) => {
    setReminderMinutes((prev) => {
      if (prev.includes(minutes)) {
        return prev.filter((m) => m !== minutes);
      }
      return [...prev, minutes];
    });
  };

  const handleSubmit = async () => {
    if (!channel) return;

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
      const event = await createEvent(channel.id, {
        title: title.trim(),
        description: description.trim() || null,
        start_time: new Date(startTime).toISOString(),
        end_time: endTime ? new Date(endTime).toISOString() : null,
        location: location.trim() || null,
        external_url: externalUrl.trim() || null,
        reminder_minutes: reminderMinutes.length > 0 ? reminderMinutes : undefined,
      });

      pushToast({
        type: 'success',
        message: t('events.created', { defaultValue: 'Событие создано' }),
      });

      onSuccess?.(event);
      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('events.createError', { defaultValue: 'Не удалось создать событие' });
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

  const commonReminders = [15, 30, 60, 120, 1440]; // minutes: 15min, 30min, 1h, 2h, 24h

  return createPortal(
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="create-event-dialog">
        <DialogHeader>
          <DialogTitle>{t('events.create', { defaultValue: 'Создать событие' })}</DialogTitle>
          <button
            type="button"
            className="dialog__close"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Закрыть' })}
          >
            <XIcon size={20} />
          </button>
        </DialogHeader>

        <div className="create-event-dialog__form">
          {error && <div className="create-event-dialog__error">{error}</div>}

          <div className="create-event-dialog__field">
            <Label htmlFor="event-title">
              {t('events.title', { defaultValue: 'Название' })} *
            </Label>
            <Input
              id="event-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('events.titlePlaceholder', { defaultValue: 'Введите название события' })}
              maxLength={256}
            />
          </div>

          <div className="create-event-dialog__field">
            <Label htmlFor="event-description">
              {t('events.description', { defaultValue: 'Описание' })}
            </Label>
            <Textarea
              id="event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('events.descriptionPlaceholder', { defaultValue: 'Описание события (необязательно)' })}
              rows={4}
            />
          </div>

          <div className="create-event-dialog__field">
            <Label htmlFor="event-start-time">
              {t('events.startTime', { defaultValue: 'Начало' })} *
            </Label>
            <Input
              id="event-start-time"
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
            />
          </div>

          <div className="create-event-dialog__field">
            <Label htmlFor="event-end-time">
              {t('events.endTime', { defaultValue: 'Окончание' })}
            </Label>
            <Input
              id="event-end-time"
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              min={startTime || undefined}
            />
          </div>

          <div className="create-event-dialog__field">
            <Label htmlFor="event-location">
              {t('events.location', { defaultValue: 'Место' })}
            </Label>
            <Input
              id="event-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t('events.locationPlaceholder', { defaultValue: 'Место проведения (необязательно)' })}
              maxLength={512}
            />
          </div>

          <div className="create-event-dialog__field">
            <Label htmlFor="event-external-url">
              {t('events.externalLink', { defaultValue: 'Внешняя ссылка' })}
            </Label>
            <Input
              id="event-external-url"
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder={t('events.externalUrlPlaceholder', { defaultValue: 'https://...' })}
              maxLength={512}
            />
          </div>

          <div className="create-event-dialog__field">
            <Label>{t('events.reminders', { defaultValue: 'Напоминания' })}</Label>
            <div className="create-event-dialog__reminders">
              {commonReminders.map((minutes) => {
                const hours = Math.floor(minutes / 60);
                const mins = minutes % 60;
                const label =
                  hours > 0
                    ? t('events.reminderHours', { hours, minutes: mins, defaultValue: '{{hours}}ч {{minutes}}м до' })
                    : t('events.reminderMinutes', { minutes, defaultValue: '{{minutes}}м до' });
                return (
                  <button
                    key={minutes}
                    type="button"
                    className={`create-event-dialog__reminder ${
                      reminderMinutes.includes(minutes)
                        ? 'create-event-dialog__reminder--selected'
                        : ''
                    }`}
                    onClick={() => handleToggleReminder(minutes)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t('common.cancel', { defaultValue: 'Отмена' })}
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !title.trim() || !startTime}>
            {loading
              ? t('common.creating', { defaultValue: 'Создание...' })
              : t('events.create', { defaultValue: 'Создать' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
    document.body,
  );
}

