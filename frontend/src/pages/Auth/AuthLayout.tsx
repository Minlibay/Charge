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
          <div>
            <h2 id="auth-modal-title">{title}</h2>
            {description && <p className="modal-description">{description}</p>}
          </div>
          <button type="button" className="ghost" onClick={closeHandler} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
