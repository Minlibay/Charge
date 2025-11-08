import { useTranslation } from 'react-i18next';

import type { ThemeName } from '../theme';
import { DirectNotificationBell } from './notifications/DirectNotificationBell';
import {
  GlobeIcon,
  LogInIcon,
  LogOutIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  UserIcon,
  UserPlusIcon,
} from './icons/LucideIcons';

interface WorkspaceHeaderProps {
  onLogout: () => void;
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
  onLogout,
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

  const subtitle = t('app.subtitle');
  const hasSubtitle = subtitle && subtitle !== 'app.subtitle';
  const connectionTone = error
    ? 'error'
    : loading
      ? 'pending'
      : tokenPresent
        ? 'online'
        : 'offline';
  const connectionMessage = error
    ? t('app.connectionStatusError')
    : loading
      ? t('app.connectionStatusLoading')
      : tokenPresent
        ? t('app.serverReady')
        : t('app.tokenMissing');
  const connectionDescription =
    error ?? (loading ? t('common.loading') : undefined) ?? (!tokenPresent ? t('app.signInRequired') : undefined);

  return (
    <header className="workspace-header">
      <div className="workspace-header__primary">
        <div className="workspace-header__titles">
          <h1>{t('app.title')}</h1>
          {hasSubtitle && <p className="workspace-header__subtitle">{subtitle}</p>}
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
        <button type="button" className="primary button-with-icon" onClick={onLogout}>
          <LogOutIcon size={18} strokeWidth={1.8} />
          {t('app.logout')}
        </button>
        </div>
      </div>
      <div
        className="workspace-header__status-block"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="workspace-header__status-label">{t('app.connectionStatusLabel')}</span>
        <span className={`workspace-header__status workspace-header__status--${connectionTone}`}>
          <span className="workspace-header__status-dot" aria-hidden="true" />
          {connectionMessage}
        </span>
        {connectionDescription && (
          <span className="workspace-header__status-description">{connectionDescription}</span>
        )}
      </div>
    </header>
  );
}
