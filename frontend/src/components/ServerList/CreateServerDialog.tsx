import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface CreateServerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string) => Promise<void>;
}

export function CreateServerDialog({ open, onClose, onCreate }: CreateServerDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle('');
      setError(null);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

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
    if (!title.trim()) {
      setError(t('servers.createNameRequired'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await onCreate(title.trim());
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('servers.createUnknownError'));
      }
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="create-server-title">
        <header className="modal-header">
          <div>
            <h2 id="create-server-title">{t('servers.createTitle')}</h2>
            <p className="modal-description">{t('servers.createSubtitle')}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            {t('servers.createNameLabel')}
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('servers.createNamePlaceholder')}
              required
            />
          </label>
          {error && <p className="auth-form__error" role="alert">{error}</p>}
          <div className="auth-form__footer">
            <button type="button" className="ghost" onClick={onClose} disabled={loading}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary" disabled={loading}>
              {loading ? t('common.loading') : t('servers.createSubmit')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
