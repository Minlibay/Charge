import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { ChannelType } from '../../types';

const CHANNEL_TYPE_OPTIONS: Array<{
  value: ChannelType;
  labelKey: string;
  descriptionKey: string;
  icon: string;
}> = [
  {
    value: 'text',
    labelKey: 'channels.typeText',
    descriptionKey: 'channels.typeTextDescription',
    icon: '💬',
  },
  {
    value: 'voice',
    labelKey: 'channels.typeVoice',
    descriptionKey: 'channels.typeVoiceDescription',
    icon: '🔊',
  },
  {
    value: 'stage',
    labelKey: 'channels.typeStage',
    descriptionKey: 'channels.typeStageDescription',
    icon: '🎤',
  },
  {
    value: 'announcements',
    labelKey: 'channels.typeAnnouncements',
    descriptionKey: 'channels.typeAnnouncementsDescription',
    icon: '📢',
  },
  {
    value: 'forums',
    labelKey: 'channels.typeForums',
    descriptionKey: 'channels.typeForumsDescription',
    icon: '💬',
  },
  {
    value: 'events',
    labelKey: 'channels.typeEvents',
    descriptionKey: 'channels.typeEventsDescription',
    icon: '📅',
  },
];

interface CreateChannelDialogProps {
  open: boolean;
  defaultType?: ChannelType;
  onClose: () => void;
  onCreate: (name: string, type: ChannelType) => Promise<void>;
}

export function CreateChannelDialog({
  open,
  defaultType = 'text',
  onClose,
  onCreate,
}: CreateChannelDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelType>(defaultType);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setType(defaultType);
      setError(null);
      window.setTimeout(() => nameRef.current?.focus(), 0);
    }
  }, [defaultType, open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t('channels.createNameRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onCreate(name.trim(), type);
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('channels.createUnknownError'));
      }
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="create-channel-title">
        <header className="modal-header">
          <div>
            <h2 id="create-channel-title">{t('channels.createTitle')}</h2>
            <p className="modal-description">{t('channels.createSubtitle')}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            {t('channels.createNameLabel')}
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('channels.createNamePlaceholder')}
              required
            />
          </label>
          <div className="field">
            <label>{t('channels.createTypeLabel')}</label>
            <div className="channel-type-selector">
              {CHANNEL_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={clsx('channel-type-option', {
                    'channel-type-option--selected': type === option.value,
                  })}
                  onClick={() => setType(option.value)}
                >
                  <span className="channel-type-option__icon" aria-hidden="true">
                    {option.icon}
                  </span>
                  <div className="channel-type-option__content">
                    <span className="channel-type-option__label">
                      {t(option.labelKey, {
                        defaultValue:
                          option.value === 'text'
                            ? 'Текстовый канал'
                            : option.value === 'voice'
                              ? 'Голосовой канал'
                              : option.value === 'stage'
                                ? 'Сценический канал'
                                : option.value === 'announcements'
                                  ? 'Канал объявлений'
                                  : option.value === 'forums'
                                    ? 'Форум'
                                    : 'События',
                      })}
                    </span>
                    <span className="channel-type-option__description">
                      {t(option.descriptionKey, {
                        defaultValue:
                          option.value === 'text'
                            ? 'Обычный текстовый канал для общения'
                            : option.value === 'voice'
                              ? 'Голосовой канал для разговоров'
                              : option.value === 'stage'
                                ? 'Сценический канал для выступлений'
                                : option.value === 'announcements'
                                  ? 'Канал для важных объявлений с возможностью публикации в другие каналы'
                                  : option.value === 'forums'
                                    ? 'Форум для обсуждений с постами и тегами'
                                    : 'Канал для событий и мероприятий с календарем',
                      })}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
          {error && <p className="auth-form__error" role="alert">{error}</p>}
          <div className="auth-form__footer">
            <button type="button" className="ghost" onClick={onClose} disabled={loading}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary" disabled={loading}>
              {loading ? t('common.loading') : t('channels.createSubmit')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
