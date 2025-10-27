import { getApiBase, getToken as getLegacyToken, setToken as setLegacyToken } from './storage';

export interface SessionData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number | null;
}

const SESSION_STORAGE_KEY = 'charge.session';
const listeners = new Set<() => void>();

const isBrowser = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

let cachedSession: SessionData | null | undefined;
let refreshTimeout: number | null = null;
let refreshPromise: Promise<SessionData | null> | null = null;

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

function decodeBase64(input: string): string | null {
  if (typeof window !== 'undefined' && typeof window.atob === 'function') {
    return window.atob(input);
  }
  const globalScope = globalThis as unknown as {
    atob?: (data: string) => string;
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
  };
  if (typeof globalScope.atob === 'function') {
    return globalScope.atob(input);
  }
  if (globalScope.Buffer) {
    return globalScope.Buffer.from(input, 'base64').toString('utf8');
  }
  return null;
}

function decodeTokenPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1];
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = decodeBase64(normalized);
    if (!decoded) {
      return null;
    }
    return JSON.parse(decoded);
  } catch (error) {
    console.warn('Failed to decode token payload', error);
    return null;
  }
}

function computeExpiresAt(accessToken: string, expiresIn?: number | null): number | null {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }
  const payload = decodeTokenPayload(accessToken);
  if (payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    return Math.floor(payload.exp * 1000);
  }
  return null;
}

function normalizeSession(data: SessionData | null): SessionData | null {
  if (!data) {
    return null;
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt:
      typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)
        ? data.expiresAt
        : computeExpiresAt(data.accessToken),
  };
}

function readStoredSession(): SessionData | null {
  if (!isBrowser) {
    return null;
  }
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SessionData>;
      return normalizeSession({
        accessToken: String(parsed.accessToken ?? ''),
        refreshToken:
          parsed.refreshToken !== undefined && parsed.refreshToken !== null
            ? String(parsed.refreshToken)
            : null,
        expiresAt:
          typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
            ? parsed.expiresAt
            : null,
      });
    } catch (error) {
      console.warn('Failed to parse stored session, clearing', error);
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }
  const legacyToken = getLegacyToken();
  if (legacyToken) {
    return normalizeSession({ accessToken: legacyToken, refreshToken: null, expiresAt: null });
  }
  return null;
}

function persistSession(session: SessionData | null): void {
  if (!isBrowser) {
    cachedSession = session;
    notifyListeners();
    return;
  }

  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    setLegacyToken(null);
    cachedSession = null;
    if (refreshTimeout !== null) {
      window.clearTimeout(refreshTimeout);
      refreshTimeout = null;
    }
    notifyListeners();
    return;
  }

  const payload = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  } satisfies SessionData;

  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Failed to persist session', error);
  }

  setLegacyToken(session.accessToken);
  cachedSession = payload;
  scheduleRefresh(payload);
  notifyListeners();
}

function scheduleRefresh(session: SessionData): void {
  if (!isBrowser) {
    return;
  }
  if (refreshTimeout !== null) {
    window.clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  if (!session.refreshToken || !session.expiresAt) {
    return;
  }
  const delay = session.expiresAt - Date.now() - 60_000;
  const timeout = Number.isFinite(delay) ? Math.max(delay, 5_000) : null;
  if (timeout === null) {
    return;
  }
  refreshTimeout = window.setTimeout(() => {
    void refreshSession();
  }, timeout);
}

function ensureSession(): SessionData | null {
  if (cachedSession === undefined) {
    cachedSession = readStoredSession();
    if (cachedSession) {
      scheduleRefresh(cachedSession);
    }
  }
  return cachedSession ?? null;
}

function buildSessionFromResponse(
  response: TokenResponse,
  fallbackRefresh: string | null,
): SessionData {
  const accessToken = response.access_token;
  const refreshToken = response.refresh_token ?? fallbackRefresh ?? null;
  const expiresAt = computeExpiresAt(accessToken, response.expires_in);
  return normalizeSession({ accessToken, refreshToken, expiresAt }) as SessionData;
}

function resolveApiUrl(path: string): URL {
  const base = getApiBase();
  if (/^https?:/i.test(path)) {
    return new URL(path);
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalized, base.endsWith('/') ? base : `${base}/`);
}

async function requestTokenRefresh(refreshToken: string): Promise<TokenResponse> {
  const url = resolveApiUrl('/api/auth/refresh');
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    throw new Error(`Refresh failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return (await response.json()) as TokenResponse;
  }

  const raw = await response.text();
  throw new Error(`Unexpected refresh payload: ${raw}`);
}

export function getSession(): SessionData | null {
  return ensureSession();
}

export function getAccessToken(): string | null {
  return ensureSession()?.accessToken ?? null;
}

export function hasRefreshToken(): boolean {
  return Boolean(ensureSession()?.refreshToken);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSession(session: SessionData | null): void {
  const normalized = normalizeSession(session);
  persistSession(normalized);
}

export function setAccessToken(
  accessToken: string | null,
  options: { refreshToken?: string | null; expiresAt?: number | null } = {},
): void {
  if (!accessToken) {
    setSession(null);
    return;
  }
  const current = ensureSession();
  setSession({
    accessToken,
    refreshToken: options.refreshToken ?? current?.refreshToken ?? null,
    expiresAt: options.expiresAt ?? computeExpiresAt(accessToken),
  });
}

export function storeTokenResponse(response: TokenResponse): SessionData {
  const next = buildSessionFromResponse(response, null);
  setSession(next);
  return next;
}

export async function initializeSession(): Promise<SessionData | null> {
  const session = ensureSession();
  if (!session) {
    return null;
  }
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    return refreshSession();
  }
  scheduleRefresh(session);
  return session;
}

export async function refreshSession(): Promise<SessionData | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const session = ensureSession();
  if (!session || !session.refreshToken) {
    return null;
  }

  refreshPromise = (async () => {
    try {
      const response = await requestTokenRefresh(session.refreshToken as string);
      const next = buildSessionFromResponse(response, session.refreshToken);
      setSession(next);
      return next;
    } catch (error) {
      console.warn('Failed to refresh session', error);
      setSession(null);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}
