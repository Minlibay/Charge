import { useTranslation } from 'react-i18next';

import type { ThemeName } from '../theme';
import { DirectNotificationBell } from './notifications/DirectNotificationBell';
import {
  GlobeIcon,
  LogInIcon,
  MoonIcon,
  SearchIcon,
  SlidersIcon,
  SunIcon,
  UserIcon,
  UserPlusIcon,
} from './icons/LucideIcons';

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
  const ThemeIcon = theme === 'light' ? MoonIcon : SunIcon;

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
          <span className="language-switcher__icon" aria-hidden="true">
            <GlobeIcon size={16} strokeWidth={1.8} />
          </span>
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
            <button type="button" className="ghost button-with-icon" onClick={onOpenInvite}>
              <UserPlusIcon size={18} strokeWidth={1.8} />
              {t('invites.openButton')}
            </button>
            <DirectNotificationBell onOpen={onOpenDirectMessages} t={t} />
            <button type="button" className="ghost button-with-icon" onClick={onOpenProfile}>
              <UserIcon size={18} strokeWidth={1.8} />
              {t('profile.open', { defaultValue: 'Профиль' })}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost button-with-icon" onClick={onOpenLogin}>
              <LogInIcon size={18} strokeWidth={1.8} />
              {t('auth.loginAction')}
            </button>
            <button type="button" className="ghost button-with-icon" onClick={onOpenRegister}>
              <UserPlusIcon size={18} strokeWidth={1.8} />
              {t('auth.registerAction')}
            </button>
          </>
        )}
        <button type="button" className="ghost button-with-icon" onClick={onOpenCommandPalette}>
          <SearchIcon size={18} strokeWidth={1.8} />
          {t('app.openCommandPalette')}
        </button>
        <button type="button" className="ghost button-with-icon" onClick={onToggleTheme}>
          <ThemeIcon size={18} strokeWidth={1.8} />
          {t(`theme.${theme}`)}
        </button>
        <button type="button" className="primary button-with-icon" onClick={onOpenSettings}>
          <SlidersIcon size={18} strokeWidth={1.8} />
          {t('app.openSettings')}
        </button>
      </div>
    </header>
  );
}
