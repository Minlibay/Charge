import { useTranslation } from 'react-i18next';

import type { ThemeName } from '../theme';
import { DirectNotificationBell } from './notifications/DirectNotificationBell';

interface WorkspaceHeaderProps {
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  theme: ThemeName;
  onOpenCommandPalette: () => void;
  language: string;
  onChangeLanguage: (language: string) => void;
  loading: boolean;
  error?: string;
  tokenPresent: boolean;
  onOpenLogin: () => void;
  onOpenRegister: () => void;
  onOpenInvite: () => void;
  onOpenProfile: () => void;
  onOpenDirectMessages: () => void;
}

export function WorkspaceHeader({
  onOpenSettings,
  onToggleTheme,
  theme,
  onOpenCommandPalette,
  language,
  onChangeLanguage,
  loading,
  error,
  tokenPresent,
  onOpenLogin,
  onOpenRegister,
  onOpenInvite,
  onOpenProfile,
  onOpenDirectMessages,
}: WorkspaceHeaderProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <header className="workspace-header">
      <div className="workspace-header__info">
        <h1>{t('app.title')}</h1>
        <span className={tokenPresent ? 'token-status token-status--ok' : 'token-status token-status--missing'}>
          {tokenPresent ? t('app.serverReady') : t('app.tokenMissing')}
        </span>
        {loading && <span className="loading-indicator">{t('common.loading')}</span>}
        {error && <span className="error-indicator">{error}</span>}
      </div>
      <div className="workspace-header__actions">
        <div className="language-switcher" role="group" aria-label={t('settings.language')}>
          <button
            type="button"
            className={language.startsWith('ru') ? 'ghost ghost--active' : 'ghost'}
            onClick={() => onChangeLanguage('ru')}
          >
            {t('language.ru')}
          </button>
          <button
            type="button"
            className={language.startsWith('en') ? 'ghost ghost--active' : 'ghost'}
            onClick={() => onChangeLanguage('en')}
          >
            {t('language.en')}
          </button>
        </div>
        {tokenPresent ? (
          <>
            <button type="button" className="ghost" onClick={onOpenInvite}>
              {t('invites.openButton')}
            </button>
            <DirectNotificationBell onOpen={onOpenDirectMessages} t={t} />
            <button type="button" className="ghost" onClick={onOpenProfile}>
              {t('profile.open', { defaultValue: 'Профиль' })}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost" onClick={onOpenLogin}>
              {t('auth.loginAction')}
            </button>
            <button type="button" className="ghost" onClick={onOpenRegister}>
              {t('auth.registerAction')}
            </button>
          </>
        )}
        <button type="button" className="ghost" onClick={onOpenCommandPalette}>
          {t('app.openCommandPalette')}
        </button>
        <button type="button" className="ghost" onClick={onToggleTheme}>
          {t(`theme.${theme}`)}
        </button>
        <button type="button" className="primary" onClick={onOpenSettings}>
          {t('app.openSettings')}
        </button>
      </div>
    </header>
  );
}
