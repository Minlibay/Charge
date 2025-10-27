import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface CreateCategoryDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, position?: number) => Promise<void>;
  defaultPosition?: number;
  roomTitle?: string;
}

export function CreateCategoryDialog({
  open,
  onClose,
  onCreate,
  defaultPosition = 0,
  roomTitle,
}: CreateCategoryDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [position, setPosition] = useState<number>(defaultPosition);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setPosition(defaultPosition);
      setError(null);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [defaultPosition, open]);

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
      setError(t('channels.categoryNameRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onCreate(name.trim(), position);
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
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="create-category-title">
        <header className="modal-header">
          <div>
            <h2 id="create-category-title">{t('channels.categoryCreateTitle')}</h2>
            <p className="modal-description">{t('channels.categoryCreateSubtitle', { title: roomTitle ?? '' })}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            {t('channels.categoryNameLabel')}
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('channels.categoryNamePlaceholder')}
              required
            />
          </label>
          <label className="field">
            {t('channels.categoryPositionLabel')}
            <input
              type="number"
              min={0}
              value={position}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                setPosition(Number.isNaN(nextValue) ? 0 : nextValue);
              }}
            />
            <span className="field-hint">{t('channels.categoryPositionHint')}</span>
          </label>
          {error && <p className="auth-form__error" role="alert">{error}</p>}
          <div className="auth-form__footer">
            <button type="button" className="ghost" onClick={onClose} disabled={loading}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary" disabled={loading}>
              {loading ? t('common.loading') : t('channels.categoryCreateSubmit')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
