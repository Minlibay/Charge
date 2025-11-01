import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ChannelType } from '../../types';

const CHANNEL_TYPE_OPTIONS: Array<{ value: ChannelType; labelKey: string }> = [
  { value: 'text', labelKey: 'channels.typeText' },
  { value: 'voice', labelKey: 'channels.typeVoice' },
  { value: 'stage', labelKey: 'channels.typeStage' },
  { value: 'announcements', labelKey: 'channels.typeAnnouncements' },
  { value: 'forums', labelKey: 'channels.typeForums' },
  { value: 'events', labelKey: 'channels.typeEvents' },
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
          <label className="field">
            {t('channels.createTypeLabel')}
            <select value={type} onChange={(event) => setType(event.target.value as ChannelType)}>
              {CHANNEL_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </label>
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
