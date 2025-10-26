import { getApiBase, getToken } from './storage.js';

function resolveApiUrl(path) {
  const base = getApiBase();
  if (/^https?:/i.test(path)) {
    return new URL(path);
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, base.endsWith('/') ? base : `${base}/`);
}

async function apiFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const url = resolveApiUrl(path);
  const requestHeaders = new Headers({ 'Content-Type': 'application/json', ...headers });
  const token = getToken();
  if (token) {
    requestHeaders.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url.toString(), {
    method,
    headers: requestHeaders,
    body,
  });

  if (!response.ok) {
    let message = response.statusText || 'Запрос завершился с ошибкой';
    try {
      const data = await response.json();
      if (data && typeof data.detail === 'string') {
        message = data.detail;
      } else if (data && typeof data.message === 'string') {
        message = data.message;
      }
    } catch (error) {
      // ignore json parse errors
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

function buildWebsocketUrl(path) {
  const apiUrl = resolveApiUrl(path);
  apiUrl.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return apiUrl.toString();
}

export { apiFetch, buildWebsocketUrl, resolveApiUrl };
