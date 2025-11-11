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
      <div className="auth-modal server-modal" role="dialog" aria-modal="true" aria-labelledby="create-server-title">
        <header className="modal-header">
          <div className="modal-header__content">
            <h2 id="create-server-title" className="modal-title">{t('servers.createTitle')}</h2>
            <p className="modal-description">{t('servers.createSubtitle')}</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <svg className="modal-close__icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M5 5L15 15M15 5L5 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>
        <div className="modal-content">
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-form__fields">
              <label className="auth-field">
                <span className="auth-field__label">{t('servers.createNameLabel')}</span>
                <input
                  ref={inputRef}
                  type="text"
                  className="auth-field__input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t('servers.createNamePlaceholder')}
                  required
                />
              </label>
            </div>
            {error && (
              <div className="auth-form__error-container" role="alert">
                <p className="auth-form__error">{error}</p>
              </div>
            )}
            <div className="auth-form__footer">
              <button type="button" className="auth-button auth-button--secondary" onClick={onClose} disabled={loading}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="auth-button auth-button--primary" disabled={loading}>
                {loading ? (
                  <>
                    <span className="auth-button__spinner" aria-hidden="true"></span>
                    <span>{t('common.loading')}</span>
                  </>
                ) : (
                  t('servers.createSubmit')
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}
