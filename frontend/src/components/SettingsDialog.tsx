import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ThemeDefinition, ThemeName } from '../theme';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  token: string | null;
  onTokenChange: (value: string | null) => void;
  theme: ThemeName;
  themes: ThemeDefinition[];
  onThemeChange: (theme: ThemeName) => void;
  customBackground: string;
  onCustomBackgroundChange: (background: string) => void;
  animationsEnabled: boolean;
  onAnimationsEnabledChange: (enabled: boolean) => void;
  language: string;
  onLanguageChange: (language: string) => void;
}

export function SettingsDialog({
  open,
  onClose,
  token,
  onTokenChange,
  theme,
  themes,
  onThemeChange,
  customBackground,
  onCustomBackgroundChange,
  animationsEnabled,
  onAnimationsEnabledChange,
  language,
  onLanguageChange,
}: SettingsDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const [localToken, setLocalToken] = useState(token ?? '');
  const [localTheme, setLocalTheme] = useState<ThemeName>(theme);
  const [localBackground, setLocalBackground] = useState(customBackground);
  const [localAnimations, setLocalAnimations] = useState(animationsEnabled);
  const [localLanguage, setLocalLanguage] = useState(language.startsWith('ru') ? 'ru' : 'en');
  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setLocalToken(token ?? '');
      setLocalTheme(theme);
      setLocalBackground(customBackground);
      setLocalAnimations(animationsEnabled);
      setLocalLanguage(language.startsWith('ru') ? 'ru' : 'en');
      window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    }
  }, [animationsEnabled, customBackground, language, open, theme, token]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    if (open) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onTokenChange(localToken.trim() || null);
    onThemeChange(localTheme);
    onCustomBackgroundChange(localBackground.trim());
    onAnimationsEnabledChange(localAnimations);
    onLanguageChange(localLanguage);
    onClose();
  };

  if (!open) {
    return null;
  }

  const primaryThemes = themes.filter((definition) => definition.variant === 'default');
  const experimentalThemes = themes.filter((definition) => definition.variant === 'experimental');

  return createPortal(
    <div className="settings-overlay" role="presentation">
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <h2 id="settings-title">{t('settings.title')}</h2>
          <button type="button" className="ghost" onClick={onClose}>
            {t('settings.close')}
          </button>
        </header>
        <form onSubmit={handleSubmit} className="settings-form">
          <label className="field">
            {t('settings.token')}
            <textarea
              ref={firstFieldRef}
              value={localToken}
              onChange={(event) => setLocalToken(event.target.value)}
              rows={3}
              placeholder="eyJhbGciOiJI..."
            />
            <small className="field-hint">{t('settings.tokenHint')}</small>
          </label>
          <label className="field">
            {t('settings.theme')}
            <select value={localTheme} onChange={(event) => setLocalTheme(event.target.value as ThemeName)}>
              {primaryThemes.map((definition) => (
                <option key={definition.name} value={definition.name}>
                  {t(`theme.${definition.name}`)}
                </option>
              ))}
              {experimentalThemes.length > 0 && (
                <optgroup label={t('settings.themeExperimentalGroup')}>
                  {experimentalThemes.map((definition) => (
                    <option key={definition.name} value={definition.name}>
                      {t(`theme.${definition.name}`)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <small className="field-hint">{t('settings.themeHint')}</small>
          </label>
          <label className="field">
            {t('settings.background')}
            <input
              value={localBackground}
              onChange={(event) => setLocalBackground(event.target.value)}
              placeholder={t('settings.backgroundPlaceholder', {
                defaultValue: 'linear-gradient(...)',
              })}
            />
            <small className="field-hint">{t('settings.backgroundHint')}</small>
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={localAnimations}
              onChange={(event) => setLocalAnimations(event.target.checked)}
            />
            <span>{t('settings.animations')}</span>
          </label>
          <label className="field">
            {t('settings.language')}
            <select value={localLanguage} onChange={(event) => setLocalLanguage(event.target.value)}>
              <option value="ru">{t('language.ru')}</option>
              <option value="en">{t('language.en')}</option>
            </select>
          </label>
          <div className="settings-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setLocalToken('');
              }}
            >
              {t('settings.reset')}
            </button>
            <button type="submit" className="primary">
              {t('settings.save')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
