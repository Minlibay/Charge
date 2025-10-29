import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

type MutableLocation = {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
  href: string;
};

const originalWindowLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
const originalGlobalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalEnvApiBase = import.meta.env?.VITE_API_BASE_URL;

function setLocation(url: string): void {
  const parsed = new URL(url);
  const mock: MutableLocation = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    origin: parsed.origin,
    href: parsed.href,
  };

  Object.defineProperty(window, 'location', {
    value: mock,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'location', {
    value: mock,
    configurable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  delete window.__CHARGE_CONFIG__;
  (import.meta.env as Record<string, unknown>).VITE_API_BASE_URL = '';
});

afterEach(() => {
  if (originalWindowLocationDescriptor) {
    Object.defineProperty(window, 'location', originalWindowLocationDescriptor);
  }
  if (originalGlobalLocationDescriptor) {
    Object.defineProperty(globalThis, 'location', originalGlobalLocationDescriptor);
  }
  (import.meta.env as Record<string, unknown>).VITE_API_BASE_URL = originalEnvApiBase;
});

describe('API base resolution', () => {
  it('falls back to the backend port when running on the Vite dev server', async () => {
    setLocation('http://localhost:5173/');
    window.__CHARGE_CONFIG__ = { apiBaseUrl: 'http://localhost:5173' };

    const { getApiBase } = await import('../storage');
    expect(getApiBase()).toBe('http://localhost:8000');
  });

  it('drops stored dev-server origins to avoid mixed-port failures', async () => {
    setLocation('http://localhost:5173/');
    window.localStorage.setItem('charge.apiBase', 'http://localhost:5173');

    const { getApiBase } = await import('../storage');

    expect(getApiBase()).toBe('http://localhost:8000');
    expect(window.localStorage.getItem('charge.apiBase')).toBeNull();
  });

  it('keeps the production origin when served over HTTPS', async () => {
    setLocation('https://charvi.ru/');
    window.__CHARGE_CONFIG__ = { apiBaseUrl: 'https://charvi.ru' };

    const { getApiBase } = await import('../storage');

    expect(getApiBase()).toBe('https://charvi.ru/');
  });
});
