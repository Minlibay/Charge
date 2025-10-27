import type { Message, RoomDetail, RoomSummary } from '../types';
import { getApiBase, getToken } from './storage';

export class ApiError extends Error {
  public status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApiFetchOptions extends RequestInit {
  json?: unknown;
}

export function resolveApiUrl(path: string): URL {
  const base = getApiBase();
  if (/^https?:/i.test(path)) {
    return new URL(path);
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, base.endsWith('/') ? base : `${base}/`);
}

export function buildWebsocketUrl(path: string): string {
  const url = resolveApiUrl(path);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { json, headers, ...rest } = options;
  const url = resolveApiUrl(path);
  const requestHeaders = new Headers(headers);
  const token = getToken();

  if (json !== undefined && rest.body !== undefined) {
    throw new Error('Provide either "json" or "body" when calling apiFetch');
  }

  if (json !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (!requestHeaders.has('Content-Type') && (rest.body === undefined || typeof rest.body === 'string')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (token) {
    requestHeaders.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url.toString(), {
    ...rest,
    headers: requestHeaders,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (!response.ok) {
    let message = response.statusText || 'Request failed';
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
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return null as T;
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return (await response.json()) as T;
  }

  return (await response.text()) as unknown as T;
}

export async function fetchRooms(): Promise<RoomSummary[]> {
  return apiFetch<RoomSummary[]>('/api/rooms');
}

export async function fetchRoomDetail(slug: string): Promise<RoomDetail> {
  return apiFetch<RoomDetail>(`/api/rooms/${encodeURIComponent(slug)}`);
}

export async function fetchChannelHistory(channelId: number, limit?: number): Promise<Message[]> {
  const params = new URLSearchParams();
  if (limit && Number.isFinite(limit)) {
    params.set('limit', String(limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<Message[]>(`/api/channels/${channelId}/history${suffix}`);
}

export interface WorkspaceConfiguration {
  iceServers: unknown;
  stun: string[];
  turn: {
    urls: string[];
    username: string | null;
    credential: string | null;
  };
  defaults: Record<string, unknown>;
  recording: Record<string, unknown> & { enabled: boolean };
  monitoring: Record<string, unknown>;
}

export async function fetchWorkspaceConfig(): Promise<WorkspaceConfiguration> {
  return apiFetch<WorkspaceConfiguration>('/api/config/webrtc');
}
