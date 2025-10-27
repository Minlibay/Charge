import { useTranslation } from 'react-i18next';

import type { ThemeName } from '../theme';

interface WorkspaceHeaderProps {
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  theme: ThemeName;
  language: string;
  onChangeLanguage: (language: string) => void;
  apiBase: string;
  loading: boolean;
  error?: string;
  tokenPresent: boolean;
}

export function WorkspaceHeader({
  onOpenSettings,
  onToggleTheme,
  theme,
  language,
  onChangeLanguage,
  apiBase,
  loading,
  error,
  tokenPresent,
}: WorkspaceHeaderProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <header className="workspace-header">
      <div className="workspace-header__info">
        <h1>{t('app.title')}</h1>
        <span className="api-base" title={apiBase}>
          {apiBase}
        </span>
        <span className={tokenPresent ? 'token-status token-status--ok' : 'token-status token-status--missing'}>
          {tokenPresent ? t('app.tokenReady') : t('app.tokenMissing')}
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
        <button type="button" className="ghost" onClick={onToggleTheme}>
          {theme === 'dark' ? t('theme.dark') : t('theme.light')}
        </button>
        <button type="button" className="primary" onClick={onOpenSettings}>
          {t('app.openSettings')}
        </button>
      </div>
    </header>
  );
}
