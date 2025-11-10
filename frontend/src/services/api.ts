import type {
  Channel,
  ChannelCategory,
  ChannelPermissionSummary,
  ChannelRolePermissionOverwrite,
  ChannelType,
  ChannelUserPermissionOverwrite,
  CustomRole,
  CustomRoleCreate,
  CustomRoleReorderEntry,
  CustomRoleUpdate,
  CustomRoleWithMemberCount,
  DirectConversation,
  DirectConversationCreatePayload,
  DirectConversationParticipant,
  DirectMessage,
  FriendRequest,
  FriendRequestList,
  FriendUser,
  Message,
  MessageHistoryPage,
  ProfileUpdatePayload,
  RoomDetail,
  RoomInvitation,
  RoomRole,
  RoomSummary,
  PinnedMessage,
  UserProfile,
  VoiceParticipant,
  VoiceRoomStats,
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
    credentials: rest.credentials ?? 'include',
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

export interface ChannelHistoryParams {
  limit?: number;
  before?: number;
  after?: number;
  around?: number;
  cursor?: string;
  direction?: 'backward' | 'forward';
}

export async function fetchChannelHistory(
  channelId: number,
  params: ChannelHistoryParams = {},
): Promise<MessageHistoryPage> {
  const search = new URLSearchParams();
  if (params.limit && Number.isFinite(params.limit)) {
    search.set('limit', String(params.limit));
  }
  if (params.before !== undefined && params.before !== null) {
    search.set('before', String(params.before));
  }
  if (params.after !== undefined && params.after !== null) {
    search.set('after', String(params.after));
  }
  if (params.around !== undefined && params.around !== null) {
    search.set('around', String(params.around));
  }
  if (params.cursor) {
    search.set('cursor', params.cursor);
  }
  if (params.direction) {
    search.set('direction', params.direction);
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return apiFetch<MessageHistoryPage>(`/api/channels/${channelId}/history${suffix}`);
}

export interface ChannelPermissionPayload {
  allow?: ChannelRolePermissionOverwrite['allow'];
  deny?: ChannelRolePermissionOverwrite['deny'];
}

export async function fetchChannelPermissions(channelId: number): Promise<ChannelPermissionSummary> {
  return apiFetch<ChannelPermissionSummary>(`/api/channels/${channelId}/permissions`);
}

export async function updateChannelRolePermissions(
  channelId: number,
  role: RoomRole,
  payload: ChannelPermissionPayload,
): Promise<ChannelRolePermissionOverwrite> {
  return apiFetch<ChannelRolePermissionOverwrite>(
    `/api/channels/${channelId}/permissions/roles/${role}`,
    {
      method: 'PUT',
      json: { allow: payload.allow ?? [], deny: payload.deny ?? [] },
    },
  );
}

export async function deleteChannelRolePermissions(channelId: number, role: RoomRole): Promise<void> {
  await apiFetch(`/api/channels/${channelId}/permissions/roles/${role}`, {
    method: 'DELETE',
  });
}

export async function updateChannelUserPermissions(
  channelId: number,
  userId: number,
  payload: ChannelPermissionPayload,
): Promise<ChannelUserPermissionOverwrite> {
  return apiFetch<ChannelUserPermissionOverwrite>(
    `/api/channels/${channelId}/permissions/users/${userId}`,
    {
      method: 'PUT',
      json: { allow: payload.allow ?? [], deny: payload.deny ?? [] },
    },
  );
}

export async function deleteChannelUserPermissions(channelId: number, userId: number): Promise<void> {
  await apiFetch(`/api/channels/${channelId}/permissions/users/${userId}`, {
    method: 'DELETE',
  });
}

export interface MessageReceiptUpdatePayload {
  delivered?: boolean;
  read?: boolean;
}

export async function updateMessageReceipt(
  channelId: number,
  messageId: number,
  payload: MessageReceiptUpdatePayload,
): Promise<Message> {
  return apiFetch<Message>(`/api/channels/${channelId}/messages/${messageId}/receipts`, {
    method: 'POST',
    json: payload,
  });
}

export async function fetchChannelPins(channelId: number): Promise<PinnedMessage[]> {
  return apiFetch<PinnedMessage[]>(`/api/channels/${channelId}/pins`);
}

export async function pinChannelMessage(
  channelId: number,
  messageId: number,
  note?: string | null,
): Promise<PinnedMessage> {
  return apiFetch<PinnedMessage>(`/api/channels/${channelId}/pins/${messageId}`, {
    method: 'POST',
    json: { note: note ?? null },
  });
}

export async function unpinChannelMessage(channelId: number, messageId: number): Promise<void> {
  await apiFetch(`/api/channels/${channelId}/pins/${messageId}`, {
    method: 'DELETE',
  });
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

export async function addMessageReaction(
  channelId: number,
  messageId: number,
  emoji: string,
): Promise<Message> {
  return apiFetch<Message>(`/api/channels/${channelId}/messages/${messageId}/reactions`, {
    method: 'POST',
    json: { emoji },
  });
}

export async function removeMessageReaction(
  channelId: number,
  messageId: number,
  emoji: string,
): Promise<Message> {
  const params = new URLSearchParams();
  params.set('emoji', emoji);
  const suffix = `?${params.toString()}`;
  return apiFetch<Message>(
    `/api/channels/${channelId}/messages/${messageId}/reactions${suffix}`,
    {
      method: 'DELETE',
    },
  );
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

export interface UpdateChannelPayload {
  name?: string;
  category_id?: number | null;
  topic?: string | null;
  slowmode_seconds?: number;
  is_nsfw?: boolean;
  is_private?: boolean;
}

export async function updateChannel(channelId: number, payload: UpdateChannelPayload): Promise<Channel> {
  return apiFetch<Channel>(`/api/channels/${channelId}`, {
    method: 'PATCH',
    json: payload,
  });
}

export async function archiveChannel(channelId: number): Promise<Channel> {
  return apiFetch<Channel>(`/api/channels/${channelId}/archive`, {
    method: 'POST',
  });
}

export async function unarchiveChannel(channelId: number): Promise<Channel> {
  return apiFetch<Channel>(`/api/channels/${channelId}/unarchive`, {
    method: 'POST',
  });
}

export interface ChannelReorderRequest {
  id: number;
  category_id: number | null;
  position: number;
}

export async function reorderChannels(slug: string, channels: ChannelReorderRequest[]): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/channels/reorder`, {
    method: 'POST',
    json: { channels },
  });
}

export interface CategoryReorderRequest {
  id: number;
  position: number;
}

export async function reorderCategories(
  slug: string,
  categories: CategoryReorderRequest[],
): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/categories/reorder`, {
    method: 'POST',
    json: { categories },
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

// Custom Roles API
export async function fetchCustomRoles(slug: string): Promise<CustomRoleWithMemberCount[]> {
  return apiFetch<CustomRoleWithMemberCount[]>(`/api/rooms/${encodeURIComponent(slug)}/roles`);
}

export async function createCustomRole(slug: string, payload: CustomRoleCreate): Promise<CustomRole> {
  return apiFetch<CustomRole>(`/api/rooms/${encodeURIComponent(slug)}/roles`, {
    method: 'POST',
    json: payload,
  });
}

export async function getCustomRole(slug: string, roleId: number): Promise<CustomRole> {
  return apiFetch<CustomRole>(`/api/rooms/${encodeURIComponent(slug)}/roles/${roleId}`);
}

export async function updateCustomRole(
  slug: string,
  roleId: number,
  payload: CustomRoleUpdate,
): Promise<CustomRole> {
  return apiFetch<CustomRole>(`/api/rooms/${encodeURIComponent(slug)}/roles/${roleId}`, {
    method: 'PATCH',
    json: payload,
  });
}

export async function deleteCustomRole(slug: string, roleId: number): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/roles/${roleId}`, {
    method: 'DELETE',
  });
}

export async function reorderCustomRoles(
  slug: string,
  roles: CustomRoleReorderEntry[],
): Promise<void> {
  await apiFetch(`/api/rooms/${encodeURIComponent(slug)}/roles/reorder`, {
    method: 'POST',
    json: { roles },
  });
}

export async function assignRoleToUser(slug: string, userId: number, roleId: number): Promise<void> {
  await apiFetch(
    `/api/rooms/${encodeURIComponent(slug)}/members/${userId}/roles/${roleId}`,
    {
      method: 'POST',
    },
  );
}

export async function removeRoleFromUser(slug: string, userId: number, roleId: number): Promise<void> {
  await apiFetch(
    `/api/rooms/${encodeURIComponent(slug)}/members/${userId}/roles/${roleId}`,
    {
      method: 'DELETE',
    },
  );
}

export async function getUserRoles(slug: string, userId: number): Promise<CustomRole[]> {
  return apiFetch<CustomRole[]>(
    `/api/rooms/${encodeURIComponent(slug)}/members/${userId}/roles`,
  );
}

export interface WorkspaceConfiguration {
  iceServers: unknown;
  stun: string[];
  turn: {
    urls: string[];
    username: string | null;
    realm: string | null;
    credential?: string | null;
    fallbackServers: unknown[];
  };
  defaults: Record<string, unknown>;
  recording: Record<string, unknown> & { enabled: boolean };
  monitoring: Record<string, unknown>;
}

export async function fetchWorkspaceConfig(): Promise<WorkspaceConfiguration> {
  return apiFetch<WorkspaceConfiguration>('/api/config/webrtc');
}

export async function fetchProfile(): Promise<UserProfile> {
  return apiFetch<UserProfile>('/api/profile/me');
}

export async function updateProfileSettings(payload: ProfileUpdatePayload): Promise<UserProfile> {
  return apiFetch<UserProfile>('/api/profile', { method: 'PATCH', json: payload });
}

export async function uploadAvatar(file: File): Promise<UserProfile> {
  const formData = new FormData();
  formData.append('avatar', file);
  return apiFetch<UserProfile>('/api/profile/avatar', { method: 'POST', body: formData });
}

export async function fetchFriendsList(): Promise<FriendUser[]> {
  return apiFetch<FriendUser[]>('/api/dm/friends');
}

export async function fetchFriendRequests(): Promise<FriendRequestList> {
  return apiFetch<FriendRequestList>('/api/dm/requests');
}

export async function sendFriendRequest(login: string): Promise<FriendRequest> {
  return apiFetch<FriendRequest>('/api/dm/requests', { method: 'POST', json: { login } });
}

export async function acceptFriendRequest(requestId: number): Promise<FriendRequest> {
  return apiFetch<FriendRequest>(`/api/dm/requests/${requestId}/accept`, { method: 'POST' });
}

export async function rejectFriendRequest(requestId: number): Promise<FriendRequest> {
  return apiFetch<FriendRequest>(`/api/dm/requests/${requestId}/reject`, { method: 'POST' });
}

export async function fetchConversations(): Promise<DirectConversation[]> {
  return apiFetch<DirectConversation[]>('/api/dm/conversations');
}

export async function createDirectConversation(
  payload: DirectConversationCreatePayload,
): Promise<DirectConversation> {
  return apiFetch<DirectConversation>('/api/dm/conversations', { method: 'POST', json: payload });
}

export async function updateDirectConversationNote(
  conversationId: number,
  note: string | null,
): Promise<DirectConversationParticipant> {
  return apiFetch<DirectConversationParticipant>(`/api/dm/conversations/${conversationId}/note`, {
    method: 'PATCH',
    json: { note },
  });
}

export async function fetchConversationMessages(conversationId: number): Promise<DirectMessage[]> {
  return apiFetch<DirectMessage[]>(`/api/dm/conversations/${conversationId}/messages`);
}

export async function sendDirectMessage(
  conversationId: number,
  content: string,
): Promise<DirectMessage> {
  return apiFetch<DirectMessage>(`/api/dm/conversations/${conversationId}/messages`, {
    method: 'POST',
    json: { content },
  });
}

export interface VoiceParticipantsResponse {
  participants: VoiceParticipant[];
  stats: VoiceRoomStats;
}

export async function fetchVoiceParticipants(roomSlug: string): Promise<VoiceParticipantsResponse> {
  return apiFetch<VoiceParticipantsResponse>(`/api/rooms/${encodeURIComponent(roomSlug)}/voice/participants`);
}