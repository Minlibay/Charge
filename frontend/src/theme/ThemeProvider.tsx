import type { PropsWithChildren } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  getStoredMotionPreference,
  getStoredTheme,
  getStoredThemeBackground,
  setStoredMotionPreference,
  setStoredTheme,
  setStoredThemeBackground,
} from '../services/storage';

export type ThemeName = 'light' | 'dark' | 'midnight' | 'forest' | 'ocean';

export interface ThemeDefinition {
  name: ThemeName;
  className: string;
}

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
  availableThemes: ThemeDefinition[];
  customBackground: string;
  setCustomBackground: (background: string) => void;
  animationsEnabled: boolean;
  setAnimationsEnabled: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const THEME_DEFINITIONS: ThemeDefinition[] = [
  { name: 'dark', className: 'theme-dark' },
  { name: 'light', className: 'theme-light' },
  { name: 'midnight', className: 'theme-midnight' },
  { name: 'forest', className: 'theme-forest' },
  { name: 'ocean', className: 'theme-ocean' },
];

function resolveInitialTheme(): ThemeName {
  const stored = getStoredTheme();
  if (stored && THEME_DEFINITIONS.some((definition) => definition.name === stored)) {
    return stored as ThemeName;
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

function resolveInitialBackground(): string {
  return getStoredThemeBackground() ?? '';
}

function resolveInitialMotionPreference(): boolean {
  return getStoredMotionPreference();
}

export function ThemeProvider({ children }: PropsWithChildren): JSX.Element {
  const [theme, setThemeState] = useState<ThemeName>(resolveInitialTheme);
  const [customBackground, setCustomBackgroundState] = useState<string>(resolveInitialBackground);
  const [animationsEnabled, setAnimationsEnabledState] = useState<boolean>(resolveInitialMotionPreference);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    root.dataset.theme = theme;
    THEME_DEFINITIONS.forEach((definition) => {
      root.classList.remove(definition.className);
    });
    const active = THEME_DEFINITIONS.find((definition) => definition.name === theme);
    if (active) {
      root.classList.add(active.className);
    }
    setStoredTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    if (customBackground) {
      root.style.setProperty('--app-background-image', customBackground);
    } else {
      root.style.removeProperty('--app-background-image');
    }
    setStoredThemeBackground(customBackground);
  }, [customBackground]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    root.dataset.motion = animationsEnabled ? 'full' : 'reduced';
    setStoredMotionPreference(animationsEnabled);
  }, [animationsEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const listener = (event: MediaQueryListEvent) => {
      setThemeState(event.matches ? 'dark' : 'light');
    };
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const availableThemes = useMemo(() => THEME_DEFINITIONS.slice(), []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: setThemeState,
      toggleTheme: () => {
        const index = THEME_DEFINITIONS.findIndex((definition) => definition.name === theme);
        const nextIndex = (index + 1) % THEME_DEFINITIONS.length;
        setThemeState(THEME_DEFINITIONS[nextIndex].name);
      },
      availableThemes,
      customBackground,
      setCustomBackground: setCustomBackgroundState,
      animationsEnabled,
      setAnimationsEnabled: setAnimationsEnabledState,
    }),
    [animationsEnabled, availableThemes, customBackground, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
