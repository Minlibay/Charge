import { useTranslation } from 'react-i18next';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function OfflineIndicator(): JSX.Element | null {
  const { t } = useTranslation();
  const isOnline = useOnlineStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div className="offline-indicator" role="alert" aria-live="polite">
      <div className="offline-indicator__content">
        <span className="offline-indicator__icon">⚠️</span>
        <span className="offline-indicator__message">
          {t('app.offline', { defaultValue: 'Нет подключения к интернету' })}
        </span>
      </div>
    </div>
  );
}

