import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { joinRoomByInvite } from '../services/auth';
import { ApiError } from '../services/api';
import type { RoomDetail } from '../types';

interface InviteJoinDialogProps {
  open: boolean;
  inviteCode?: string | null;
  onClose: () => void;
  onJoined?: (room: RoomDetail) => void;
}

export function InviteJoinDialog({ open, inviteCode, onClose, onJoined }: InviteJoinDialogProps): JSX.Element | null {
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
      // Don't close dialog here - let parent handle success dialog
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
      <div className="auth-modal invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-dialog-title">
        <header className="modal-header">
          <div className="modal-header__content">
            <h2 id="invite-dialog-title" className="modal-title">{t('invites.title')}</h2>
            <p className="modal-description">{t('invites.subtitle')}</p>
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
                <span className="auth-field__label">{t('invites.codeField')}</span>
                <input
                  ref={inputRef}
                  type="text"
                  className="auth-field__input"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t('invites.codePlaceholder')}
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
                  t('invites.submit')
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
