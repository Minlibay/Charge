import type { PropsWithChildren } from 'react';
import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useNavigate } from '../../router';

interface AuthLayoutProps {
  title: string;
  description?: string;
  onClose?: () => void;
}

export function AuthLayout({
  title,
  description,
  onClose,
  children,
}: PropsWithChildren<AuthLayoutProps>): JSX.Element | null {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const closeHandler = useMemo<() => void>(
    () => () => {
      if (onClose) {
        onClose();
      } else {
        navigate('/', { replace: true });
      }
    },
    [navigate, onClose],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeHandler();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeHandler]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <header className="modal-header">
          <div className="modal-header__content">
            <h2 id="auth-modal-title" className="modal-title">{title}</h2>
            {description && <p className="modal-description">{description}</p>}
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={closeHandler}
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
        <div className="modal-content">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
