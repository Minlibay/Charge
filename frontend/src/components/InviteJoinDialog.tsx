import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { joinRoomByInvite } from '../services/auth';
import { ApiError } from '../services/api';
import type { RoomDetail } from '../types';

interface InviteJoinDialogProps {
  open: boolean;
  onClose: () => void;
  onJoined?: (room: RoomDetail) => void;
}

export function InviteJoinDialog({ open, onClose, onJoined }: InviteJoinDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setCode('');
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
    if (!code.trim()) {
      setError(t('invites.codeRequired'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const room = await joinRoomByInvite(code.trim());
      onJoined?.(room);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('invites.unexpectedError'));
      }
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-dialog-title">
        <header className="modal-header">
          <div>
            <h2 id="invite-dialog-title">{t('invites.title')}</h2>
            <p className="modal-description">{t('invites.subtitle')}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            {t('invites.codeField')}
            <input
              ref={inputRef}
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('invites.codePlaceholder')}
              required
            />
          </label>
          {error && <p className="auth-form__error" role="alert">{error}</p>}
          <div className="auth-form__footer">
            <button type="button" className="ghost" onClick={onClose} disabled={loading}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary" disabled={loading}>
              {loading ? t('common.loading') : t('invites.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
