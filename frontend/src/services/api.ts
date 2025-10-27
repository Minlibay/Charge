import type {
  Channel,
  ChannelCategory,
  ChannelType,
  Message,
  RoomDetail,
  RoomInvitation,
  RoomRole,
  RoomSummary,
} from '../types';
import { getAccessToken, hasRefreshToken, refreshSession } from './session';
import { getApiBase } from './storage';

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
  const initialToken = getAccessToken();

  if (json !== undefined && rest.body !== undefined) {
    throw new Error('Provide either "json" or "body" when calling apiFetch');
  }

  if (json !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (!requestHeaders.has('Content-Type') && (rest.body === undefined || typeof rest.body === 'string')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (initialToken) {
    requestHeaders.set('Authorization', `Bearer ${initialToken}`);
  }

  const requestInit: RequestInit = {
    ...rest,
    headers: requestHeaders,
  };

  if (json !== undefined) {
    requestInit.body = JSON.stringify(json);
  } else if (rest.body !== undefined) {
    requestInit.body = rest.body;
  }

  const originalBody = requestInit.body;

  const execute = async (): Promise<Response> => {
    if (originalBody !== undefined && requestInit.body !== originalBody) {
      requestInit.body = originalBody;
    }
    return fetch(url.toString(), requestInit);
  };

  let response = await execute();

  if (response.status === 401 && hasRefreshToken()) {
    const refreshed = await refreshSession();
    if (refreshed?.accessToken) {
      requestHeaders.set('Authorization', `Bearer ${refreshed.accessToken}`);
      response = await execute();
    }
  }

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

export interface CreateMessagePayload {
  channelId: number;
  content?: string;
  parentId?: number | null;
  files?: File[];
}

export async function createMessage(payload: CreateMessagePayload): Promise<Message> {
  const formData = new FormData();
  formData.append('channel_id', String(payload.channelId));
  if (payload.content) {
    formData.append('content', payload.content);
  }
  if (payload.parentId !== undefined && payload.parentId !== null) {
    formData.append('parent_id', String(payload.parentId));
  }
  payload.files?.forEach((file) => {
    formData.append('files', file);
  });
  return apiFetch<Message>('/api/messages', { method: 'POST', body: formData });
}

export async function updateMessage(messageId: number, content: string): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${messageId}`, {
    method: 'PATCH',
    json: { content },
  });
}

export async function deleteMessage(messageId: number): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${messageId}`, { method: 'DELETE' });
}

export interface ModerateMessagePayload {
  action: 'suppress' | 'restore';
  note?: string;
}

export async function moderateMessage(messageId: number, payload: ModerateMessagePayload): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${messageId}/moderate`, {
    method: 'POST',
    json: payload,
  });
}

export async function fetchThreadMessages(channelId: number, messageId: number): Promise<Message[]> {
  return apiFetch<Message[]>(`/api/channels/${channelId}/threads/${messageId}`);
}

export interface CreateRoomPayload {
  title: string;
}

export async function createRoom(payload: CreateRoomPayload): Promise<RoomSummary> {
  return apiFetch<RoomSummary>('/api/rooms', { method: 'POST', json: payload });
}

export interface CreateCategoryPayload {
  name: string;
  position?: number;
}

export async function createCategory(
  slug: string,
  payload: CreateCategoryPayload,
): Promise<ChannelCategory> {
  return apiFetch<ChannelCategory>(`/api/rooms/${encodeURIComponent(slug)}/categories`, {
    method: 'POST',
    json: payload,
  });
}

export async function deleteCategory(slug: string, categoryId: number): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/categories/${categoryId}`, {
    method: 'DELETE',
  });
}

export interface CreateChannelPayload {
  name: string;
  type: ChannelType;
  category_id?: number | null;
}

export async function createChannel(
  slug: string,
  payload: CreateChannelPayload,
): Promise<Channel> {
  return apiFetch<Channel>(`/api/rooms/${encodeURIComponent(slug)}/channels`, {
    method: 'POST',
    json: payload,
  });
}

export async function deleteChannel(slug: string, letter: string): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/channels/${encodeURIComponent(letter)}`, {
    method: 'DELETE',
  });
}

export async function listInvitations(slug: string): Promise<RoomInvitation[]> {
  const params = new URLSearchParams({ room: slug });
  return apiFetch<RoomInvitation[]>(`/api/invites?${params.toString()}`);
}

export interface CreateInvitationPayload {
  room_slug: string;
  role: RoomRole;
  expires_at?: string | null;
}

export async function createInvitation(
  payload: CreateInvitationPayload,
): Promise<RoomInvitation> {
  return apiFetch<RoomInvitation>('/api/invites', { method: 'POST', json: payload });
}

export async function deleteInvitation(roomSlug: string, invitationId: number): Promise<void> {
  const params = new URLSearchParams({ room: roomSlug });
  await apiFetch(`/api/invites/${invitationId}?${params.toString()}`, { method: 'DELETE' });
}

export async function updateRoleLevel(
  slug: string,
  role: RoomRole,
  level: number,
): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/roles/hierarchy/${role}`, {
    method: 'PATCH',
    json: { level },
  });
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
