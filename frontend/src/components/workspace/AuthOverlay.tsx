import { useTranslation } from 'react-i18next';

import { logout } from '../../services/session';

interface AuthOverlayProps {
  onOpenLogin: () => void;
  onOpenRegister: () => void;
}

export function AuthOverlay({ onOpenLogin, onOpenRegister }: AuthOverlayProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="auth-overlay" role="alert">
      <p>{t('app.signInRequired')}</p>
      <div className="auth-overlay__actions">
        <button type="button" className="primary" onClick={onOpenLogin}>
          {t('auth.loginAction')}
        </button>
        <button type="button" className="ghost" onClick={onOpenRegister}>
          {t('auth.registerAction')}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            logout();
            onOpenLogin();
          }}
        >
          {t('app.logout')}
        </button>
      </div>
    </div>
  );
}

