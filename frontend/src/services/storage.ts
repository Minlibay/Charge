export const storageKeys = {
  apiBase: 'charge.apiBase',
  token: 'charge.token',
  room: 'charge.lastRoom',
  theme: 'charge.theme',
  themeBackground: 'charge.themeBackground',
  themeMotion: 'charge.themeMotion',
  voicePlaybackVolume: 'charge.voicePlaybackVolume',
} as const;

type StorageKey = (typeof storageKeys)[keyof typeof storageKeys];

type StorageListener = () => void;

const listeners = new Set<StorageListener>();

const isBrowser = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

interface ChargeRuntimeConfig {
  apiBaseUrl?: string;
}

declare global {
  interface Window {
    __CHARGE_CONFIG__?: ChargeRuntimeConfig;
  }
}

function readConfiguredApiBase(): string | null {
  const envValue = import.meta.env?.VITE_API_BASE_URL;
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return envValue.trim();
  }

  if (typeof window !== 'undefined') {
    const runtimeValue = window.__CHARGE_CONFIG__?.apiBaseUrl;
    if (typeof runtimeValue === 'string' && runtimeValue.trim() !== '') {
      return runtimeValue.trim();
    }
  }

  return null;
}

interface NormalizeApiBaseOptions {
  onDrop?: () => void;
  onRewrite?: (normalized: string) => void;
}

function normalizeApiBase(value: string | null | undefined, options: NormalizeApiBaseOptions = {}): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    options.onDrop?.();
    return null;
  }

  if (!isBrowser) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed, window.location.origin);

    const devPorts = new Set(['5173', '4173']);
    const locationPort = window.location.port;
    const parsedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');

    if (
      locationPort &&
      devPorts.has(locationPort) &&
      parsed.hostname === window.location.hostname &&
      parsedPort === locationPort
    ) {
      options.onDrop?.();
      return null;
    }

    if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
      const sameHostname = parsed.hostname === window.location.hostname;
      const locationPort = window.location.port;

      if (sameHostname) {
        parsed.protocol = 'https:';

        if (locationPort && locationPort !== '443') {
          parsed.port = locationPort;
        } else {
          parsed.port = '';
        }

        const normalizedHttps = parsed.toString();

        if (normalizedHttps !== trimmed) {
          options.onRewrite?.(normalizedHttps);
        }

        return normalizedHttps;
      }

      // When the value targets a different host via HTTP while the UI runs on
      // HTTPS, browsers will block the requests as mixed content. Drop it so we
      // can safely fall back to the default base.
      options.onDrop?.();
      return null;
    }

    const normalized = parsed.toString();

    if (normalized !== trimmed) {
      options.onRewrite?.(normalized);
    }

    return normalized;
  } catch (error) {
    void error;
    return trimmed;
  }
}

function resolveDefaultApiBase(): string {
  const configured = normalizeApiBase(readConfiguredApiBase());
  if (configured) {
    return configured;
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location?.protocol || 'http:';
    const hostname = window.location?.hostname || 'localhost';
    const port = window.location?.port ?? '';

    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
    const devPorts = new Set(['5173', '4173']);

    if (isLocalhost && (port === '' || devPorts.has(port))) {
      return `${protocol}//${hostname}:8000`;
    }

    const shouldIncludePort = port !== '' && port !== '80' && port !== '443';
    const portSuffix = shouldIncludePort ? `:${port}` : '';

    return `${protocol}//${hostname}${portSuffix}`;
  }

  return 'http://localhost:8000';
}

const defaultApiBase = resolveDefaultApiBase();

function readValue(key: StorageKey): string | null {
  if (!isBrowser) {
    return null;
  }
  return window.localStorage.getItem(key);
}

function writeValue(key: StorageKey, value: string | null): void {
  if (!isBrowser) {
    return;
  }
  if (value === null || value === undefined || value === '') {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, value);
  }
  notifyListeners();
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: StorageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function parseNumber(value: string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeStoredApiBase(value: string | null): string | null {
  return normalizeApiBase(value, {
    onDrop: () => writeValue(storageKeys.apiBase, null),
    onRewrite: (normalized) => writeValue(storageKeys.apiBase, normalized),
  });
}

if (isBrowser) {
  window.addEventListener('storage', (event) => {
    if (!event.key) {
      return;
    }
    const trackedKeys = new Set(Object.values(storageKeys));
    if (trackedKeys.has(event.key as StorageKey)) {
      notifyListeners();
    }
  });
}

export function getApiBase(): string {
  const stored = sanitizeStoredApiBase(readValue(storageKeys.apiBase));
  return stored || defaultApiBase;
}

export function setApiBase(url: string | null | undefined): void {
  writeValue(storageKeys.apiBase, url ?? null);
}

export function getToken(): string | null {
  return readValue(storageKeys.token);
}

export function setToken(token: string | null | undefined): void {
  writeValue(storageKeys.token, token ?? null);
}

export function getLastRoom(): string | null {
  return readValue(storageKeys.room);
}

export function setLastRoom(slug: string | null | undefined): void {
  writeValue(storageKeys.room, slug ?? null);
}

export function getStoredTheme(): string | null {
  return readValue(storageKeys.theme);
}

export function setStoredTheme(theme: string | null | undefined): void {
  writeValue(storageKeys.theme, theme ?? null);
}

export function getStoredThemeBackground(): string | null {
  return readValue(storageKeys.themeBackground);
}

export function setStoredThemeBackground(background: string | null | undefined): void {
  writeValue(storageKeys.themeBackground, background ?? null);
}

export function getStoredMotionPreference(): boolean {
  const value = readValue(storageKeys.themeMotion);
  if (value === 'reduced') {
    return false;
  }
  if (value === 'full') {
    return true;
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return true;
}

export function setStoredMotionPreference(enabled: boolean): void {
  writeValue(storageKeys.themeMotion, enabled ? 'full' : 'reduced');
}

export function getVoicePlaybackVolume(): number | null {
  const stored = parseNumber(readValue(storageKeys.voicePlaybackVolume));
  if (stored === null) {
    return null;
  }
  return Math.min(Math.max(stored, 0), 2);
}

export function setVoicePlaybackVolume(volume: number): void {
  const safe = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 2) : 1;
  writeValue(storageKeys.voicePlaybackVolume, String(safe));
}
