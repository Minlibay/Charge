import { useTranslation } from 'react-i18next';

interface AuthOverlayProps {
  onOpenLogin: () => void;
  onOpenRegister: () => void;
  onOpenSettings: () => void;
}

export function AuthOverlay({ onOpenLogin, onOpenRegister, onOpenSettings }: AuthOverlayProps): JSX.Element {
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
        <button type="button" className="ghost" onClick={onOpenSettings}>
          {t('app.openSettings')}
        </button>
      </div>
    </div>
  );
}

