export const storageKeys = {
  apiBase: 'charge.apiBase',
  token: 'charge.token',
  room: 'charge.lastRoom',
  theme: 'charge.theme',
} as const;

type StorageKey = (typeof storageKeys)[keyof typeof storageKeys];

type StorageListener = () => void;

const listeners = new Set<StorageListener>();

const isBrowser = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

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
  return readValue(storageKeys.apiBase) || 'http://localhost:8000';
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
