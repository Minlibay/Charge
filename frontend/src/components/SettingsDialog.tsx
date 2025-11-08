import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

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
  const activeThemeClass = useMemo(
    () => themes.find((definition) => definition.name === localTheme)?.className,
    [localTheme, themes],
  );
  const closeLabel = t('settings.close');
  const previewBackgroundStyle = localBackground.trim() ? { background: localBackground } : undefined;

  return createPortal(
    <div
      className="modal-overlay settings-modal"
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className={clsx('modal-dialog', 'settings-dialog')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={clsx('modal-header', 'settings-header')}>
          <div>
            <h2 id="settings-title" className="modal-title">
              {t('settings.title')}
            </h2>
            <p className="modal-subtitle">
              {t('settings.subtitle', { defaultValue: 'Настройте внешний вид и поведение приложения под себя.' })}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label={closeLabel} onClick={onClose}>
            <svg className="button-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </header>
        <form onSubmit={handleSubmit} className={clsx('modal-content', 'settings-form')}>
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
          <div className="settings-preview">
            <span className="settings-preview__label">
              {t('settings.previewLabel', { defaultValue: 'Предпросмотр темы и фона' })}
            </span>
            <div className={clsx('theme-preview', activeThemeClass)}>
              <div className="theme-preview__canvas" style={previewBackgroundStyle}>
                <div className="theme-preview__surface">
                  <h3 className="theme-preview__title">
                    {t('settings.previewTitle', { defaultValue: 'Заголовок примера' })}
                  </h3>
                  <p className="theme-preview__meta">
                    {t('settings.previewDescription', {
                      defaultValue: 'Карточка автоматически использует цвета выбранной темы.',
                    })}
                  </p>
                  <div className="theme-preview__meta">
                    <span>{t('settings.previewPalette', { defaultValue: 'Акцентные цвета' })}</span>
                    <span className="theme-preview__swatches">
                      <span className="theme-preview__swatch theme-preview__swatch--primary" />
                      <span className="theme-preview__swatch theme-preview__swatch--muted" />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
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
          <div className={clsx('modal-footer', 'settings-actions')}>
            <button
              type="button"
              className="secondary button-with-icon"
              onClick={() => {
                setLocalToken('');
              }}
            >
              <svg className="button-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M7.25 2a5.25 5.25 0 1 1-3.67 8.98.75.75 0 0 1 1.06-1.06 3.75 3.75 0 1 0 0-5.32l.37.38a.75.75 0 0 1-1.06 1.06l-1.63-1.63a.75.75 0 0 1 0-1.06L3.95 1.7a.75.75 0 1 1 1.06 1.06L4.64 3.13A5.22 5.22 0 0 1 7.25 2Z"
                  fill="currentColor"
                />
              </svg>
              <span>{t('settings.reset', { defaultValue: 'Сбросить' })}</span>
            </button>
            <button type="submit" className="primary button-with-icon">
              <svg className="button-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M6.53 10.78a.75.75 0 0 1-1.06 0L3.47 8.78a.75.75 0 0 1 1.06-1.06l1.5 1.5 5.44-5.44a.75.75 0 1 1 1.06 1.06l-5.97 5.94Z"
                  fill="currentColor"
                />
              </svg>
              <span>{t('settings.save', { defaultValue: 'Сохранить' })}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
