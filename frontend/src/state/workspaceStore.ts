import { create } from 'zustand';

import {
  createCategory as apiCreateCategory,
  createChannel as apiCreateChannel,
  createInvitation as apiCreateInvitation,
  createRoom as apiCreateRoom,
  ChannelPermissionPayload,
  deleteChannelRolePermissions as apiDeleteChannelRolePermissions,
  deleteChannelUserPermissions as apiDeleteChannelUserPermissions,
  deleteCategory as apiDeleteCategory,
  deleteChannel as apiDeleteChannel,
  deleteInvitation as apiDeleteInvitation,
  fetchChannelHistory,
  fetchChannelPins,
  fetchChannelPermissions,
  fetchRoomDetail,
  fetchRooms,
  listInvitations,
  pinChannelMessage,
  reorderCategories as apiReorderCategories,
  reorderChannels as apiReorderChannels,
  unpinChannelMessage,
  updateChannelRolePermissions as apiUpdateChannelRolePermissions,
  updateChannelUserPermissions as apiUpdateChannelUserPermissions,
  updateRoleLevel as apiUpdateRoleLevel,
} from '../services/api';
import {
  getLastRoom,
  setLastRoom,
  getVoicePlaybackVolume as getStoredVoicePlaybackVolume,
  setVoicePlaybackVolume as setStoredVoicePlaybackVolume,
} from '../services/storage';
import { usePresenceStore } from '../stores/presenceStore';
import { getCurrentUserId } from '../services/session';
import { messageMentionsLogin } from '../utils/mentions';
import {
  TEXT_CHANNEL_TYPES,
  type Channel,
  type ChannelPermissionSummary,
  type ChannelRolePermissionOverwrite,
  type ChannelUserPermissionOverwrite,
  type ChannelCategory,
  type Message,
  type MessageHistoryPage,
  type PinnedMessage,
  type PresenceUser,
  type RoomInvitation,
  type RoomRole,
  type RoomDetail,
  type RoomSummary,
  type RoomMemberSummary,
  type TypingUser,
  type VoiceParticipant,
  type VoiceQualityMetrics,
  type VoiceRoomStats,
  type VoiceFeatureFlags,
  type ScreenShareQuality,
} from '../types';

type VoiceConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface VoiceDeviceLists {
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

interface VoiceActivityState {
  [participantId: number]: {
    level: number;
    speaking: boolean;
  };
}

const CHANNEL_TYPE_ORDER: Channel['type'][] = [
  'text',
  'announcements',
  'forums',
  'events',
  'voice',
  'stage',
];

const CHANNEL_TYPE_RANK = new Map(CHANNEL_TYPE_ORDER.map((type, index) => [type, index] as const));

function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort((a, b) => {
    const aCategory = a.category_id ?? -1;
    const bCategory = b.category_id ?? -1;
    if (aCategory !== bCategory) {
      return aCategory - bCategory;
    }
    if (a.position !== b.position) {
      return a.position - b.position;
    }
    if (a.type !== b.type) {
      const aRank = CHANNEL_TYPE_RANK.get(a.type) ?? Number.MAX_SAFE_INTEGER;
      const bRank = CHANNEL_TYPE_RANK.get(b.type) ?? Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      return a.type.localeCompare(b.type);
    }
    return a.name.localeCompare(b.name);
  });
}

function sortMembers(members: RoomMemberSummary[]): RoomMemberSummary[] {
  return [...members].sort((a, b) => {
    const aName = (a.display_name ?? a.login ?? '').toLowerCase();
    const bName = (b.display_name ?? b.login ?? '').toLowerCase();
    return aName.localeCompare(bName);
  });
}

function sortInvitations(invitations: RoomInvitation[]): RoomInvitation[] {
  return [...invitations].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

interface WorkspaceState {
  rooms: RoomSummary[];
  roomDetails: Record<string, RoomDetail>;
  categoriesByRoom: Record<string, ChannelCategory[]>;
  channelsByRoom: Record<string, Channel[]>;
  messagesByChannel: Record<number, Message[]>;
  historyMetaByChannel: Record<number, ChannelHistoryMeta>;
  loadingOlderByChannel: Record<number, boolean>;
  loadingNewerByChannel: Record<number, boolean>;
  loadingPinsByChannel: Record<number, boolean>;
  pinnedByChannel: Record<number, PinnedMessage[]>;
  presenceByChannel: Record<number, PresenceUser[]>;
  typingByChannel: Record<number, TypingUser[]>;
  lastReadMessageIdByChannel: Record<number, number | null>;
  unreadCountByChannel: Record<number, number>;
  mentionCountByChannel: Record<number, number>;
  selfReactionsByMessage: Record<number, string[]>;
  channelRoomById: Record<number, string>;
  channelPermissions: Record<number, ChannelPermissionSummary>;
  voiceParticipantsByRoom: Record<string, VoiceParticipant[]>;
  voiceStatsByRoom: Record<string, VoiceRoomStats>;
  voiceConnectionStatus: VoiceConnectionStatus;
  voiceConnectionError?: string;
  voiceRoomSlug: string | null;
  activeVoiceChannelId: number | null;
  voiceLocalParticipantId: number | null;
  voiceLocalRole: string | null;
  voiceFeatures: VoiceFeatureFlags | null;
  voiceActivity: VoiceActivityState;
  voiceRemoteStreams: Record<number, MediaStream | null>;
  voiceDevices: VoiceDeviceLists;
  selectedMicrophoneId: string | null;
  selectedSpeakerId: string | null;
  selectedCameraId: string | null;
  voicePlaybackVolume: number;
  voiceParticipantVolumes: Record<number, number>;
  voiceGain: number;
  voiceAutoGain: boolean;
  voiceInputLevel: number;
  screenShareQuality: ScreenShareQuality;
  muted: boolean;
  deafened: boolean;
  videoEnabled: boolean;
  membersByRoom: Record<string, RoomMemberSummary[]>;
  selectedRoomSlug: string | null;
  selectedChannelId: number | null;
  loading: boolean;
  error?: string;
  initialize: () => Promise<void>;
  loadRoom: (slug: string) => Promise<void>;
  refreshChannelHistory: (channelId: number) => Promise<void>;
  loadOlderHistory: (channelId: number) => Promise<void>;
  loadNewerHistory: (channelId: number) => Promise<void>;
  selectRoom: (slug: string) => void;
  selectChannel: (channelId: number) => void;
  ingestHistory: (channelId: number, page: MessageHistoryPage) => void;
  ingestMessage: (channelId: number, message: Message) => void;
  registerChannelRoom: (slug: string, channels: Channel[]) => void;
  setChannelsByRoom: (slug: string, channels: Channel[]) => void;
  updateChannel: (slug: string, channel: Channel) => void;
  setCategoriesByRoom: (slug: string, categories: ChannelCategory[]) => void;
  setMembersByRoom: (slug: string, members: RoomMemberSummary[]) => void;
  setInvitationsByRoom: (slug: string, invitations: RoomInvitation[]) => void;
  upsertInvitation: (slug: string, invitation: RoomInvitation) => void;
  removeInvitation: (slug: string, invitationId: number) => void;
  setPresenceSnapshot: (channelId: number, users: PresenceUser[]) => void;
  setTypingSnapshot: (channelId: number, users: TypingUser[]) => void;
  loadPinnedMessages: (channelId: number) => Promise<void>;
  pinMessage: (channelId: number, messageId: number, note?: string | null) => Promise<void>;
  unpinMessage: (channelId: number, messageId: number) => Promise<void>;
  setVoiceParticipants: (roomSlug: string, participants: VoiceParticipant[]) => void;
  updateVoiceParticipant: (roomSlug: string, participant: VoiceParticipant) => void;
  removeVoiceParticipant: (roomSlug: string, participantId: number) => void;
  setVoiceStats: (roomSlug: string, stats: VoiceRoomStats) => void;
  setVoiceConnectionStatus: (status: VoiceConnectionStatus, error?: string) => void;
  setVoiceConnectionMeta: (meta: {
    roomSlug?: string | null;
    channelId?: number | null;
    localParticipantId?: number | null;
    localRole?: string | null;
    features?: VoiceFeatureFlags | null;
  }) => void;
  setVoiceMuted: (muted: boolean) => void;
  setVoiceDeafened: (deafened: boolean) => void;
  setVoiceVideoEnabled: (enabled: boolean) => void;
  setVoiceDevices: (devices: VoiceDeviceLists) => void;
  setSelectedMicrophoneId: (deviceId: string | null) => void;
  setSelectedSpeakerId: (deviceId: string | null) => void;
  setSelectedCameraId: (deviceId: string | null) => void;
  setVoicePlaybackVolume: (volume: number) => void;
  setVoiceParticipantVolume: (participantId: number, volume: number | null) => void;
  setVoiceParticipantQuality: (
    roomSlug: string,
    participantId: number,
    track: string,
    metrics: VoiceQualityMetrics,
  ) => void;
  setVoiceGain: (gain: number) => void;
  setVoiceAutoGain: (enabled: boolean) => void;
  setVoiceInputLevel: (level: number) => void;
  setScreenShareQuality: (quality: ScreenShareQuality) => void;
  setVoiceActivity: (participantId: number, activity: { level: number; speaking: boolean }) => void;
  clearVoiceActivity: (participantId: number) => void;
  setVoiceRemoteStream: (participantId: number, stream: MediaStream | null) => void;
  setActiveVoiceChannel: (channelId: number | null) => void;
  resetVoiceState: () => void;
  setError: (message: string | undefined) => void;
  reset: () => void;
  createRoom: (title: string) => Promise<void>;
  createCategory: (slug: string, name: string, position?: number) => Promise<void>;
  deleteCategory: (slug: string, categoryId: number) => Promise<void>;
  createChannel: (
    slug: string,
    payload: { name: string; type: Channel['type']; category_id?: number | null },
  ) => Promise<Channel>;
  deleteChannel: (slug: string, letter: string) => Promise<void>;
  reorderChannels: (
    slug: string,
    ordering: { id: number; category_id: number | null; position: number }[],
  ) => Promise<void>;
  reorderCategories: (slug: string, ordering: { id: number; position: number }[]) => Promise<void>;
  refreshInvitations: (slug: string) => Promise<void>;
  createInvitation: (
    slug: string,
    payload: { role: RoomRole; expires_at?: string | null },
  ) => Promise<void>;
  deleteInvitation: (slug: string, invitationId: number) => Promise<void>;
  updateRoleLevel: (slug: string, role: RoomRole, level: number) => Promise<void>;
  loadChannelPermissions: (channelId: number) => Promise<ChannelPermissionSummary>;
  updateChannelRolePermissions: (
    channelId: number,
    role: RoomRole,
    payload: ChannelPermissionPayload,
  ) => Promise<ChannelRolePermissionOverwrite>;
  deleteChannelRolePermissions: (channelId: number, role: RoomRole) => Promise<void>;
  updateChannelUserPermissions: (
    channelId: number,
    userId: number,
    payload: ChannelPermissionPayload,
  ) => Promise<ChannelUserPermissionOverwrite>;
  deleteChannelUserPermissions: (channelId: number, userId: number) => Promise<void>;
}

const initialState: Pick<
  WorkspaceState,
  | 'rooms'
  | 'roomDetails'
  | 'categoriesByRoom'
  | 'channelsByRoom'
  | 'messagesByChannel'
  | 'historyMetaByChannel'
  | 'loadingOlderByChannel'
  | 'loadingNewerByChannel'
  | 'loadingPinsByChannel'
  | 'pinnedByChannel'
  | 'presenceByChannel'
  | 'typingByChannel'
  | 'lastReadMessageIdByChannel'
  | 'unreadCountByChannel'
  | 'mentionCountByChannel'
  | 'selfReactionsByMessage'
  | 'channelRoomById'
  | 'channelPermissions'
  | 'voiceParticipantsByRoom'
  | 'voiceStatsByRoom'
  | 'voiceConnectionStatus'
  | 'voiceConnectionError'
  | 'voiceRoomSlug'
  | 'activeVoiceChannelId'
  | 'voiceLocalParticipantId'
  | 'voiceLocalRole'
  | 'voiceFeatures'
  | 'voiceActivity'
  | 'voiceRemoteStreams'
  | 'voiceDevices'
  | 'selectedMicrophoneId'
  | 'selectedSpeakerId'
  | 'selectedCameraId'
  | 'voicePlaybackVolume'
  | 'voiceParticipantVolumes'
  | 'voiceGain'
  | 'voiceAutoGain'
  | 'voiceInputLevel'
  | 'screenShareQuality'
  | 'muted'
  | 'deafened'
  | 'videoEnabled'
  | 'membersByRoom'
  | 'selectedRoomSlug'
  | 'selectedChannelId'
  | 'loading'
  | 'error'
> = {
  rooms: [],
  roomDetails: {},
  categoriesByRoom: {},
  channelsByRoom: {},
  messagesByChannel: {},
  historyMetaByChannel: {},
  loadingOlderByChannel: {},
  loadingNewerByChannel: {},
  loadingPinsByChannel: {},
  pinnedByChannel: {},
  presenceByChannel: {},
  typingByChannel: {},
  lastReadMessageIdByChannel: {},
  unreadCountByChannel: {},
  mentionCountByChannel: {},
  selfReactionsByMessage: {},
  channelRoomById: {},
  channelPermissions: {},
  voiceParticipantsByRoom: {},
  voiceStatsByRoom: {},
  voiceConnectionStatus: 'disconnected',
  voiceConnectionError: undefined,
  voiceRoomSlug: null,
  activeVoiceChannelId: null,
  voiceLocalParticipantId: null,
  voiceLocalRole: null,
  voiceFeatures: null,
  voiceActivity: {},
  voiceRemoteStreams: {},
  voiceDevices: { microphones: [], speakers: [], cameras: [] },
  selectedMicrophoneId: null,
  selectedSpeakerId: null,
  selectedCameraId: null,
  voicePlaybackVolume: getStoredVoicePlaybackVolume() ?? 1,
  voiceParticipantVolumes: {},
  voiceGain: 1,
  voiceAutoGain: true,
  voiceInputLevel: 0,
  screenShareQuality: 'high',
  muted: false,
  deafened: false,
  videoEnabled: false,
  membersByRoom: {},
  selectedRoomSlug: null,
  selectedChannelId: null,
  loading: false,
  error: undefined,
};

function pickDefaultChannel(channels: Channel[]): number | null {
  if (!channels.length) {
    return null;
  }
  const preferred = channels.find((channel) => TEXT_CHANNEL_TYPES.includes(channel.type));
  return (preferred ?? channels[0]).id;
}

function mergeChannelRoomMap(
  previous: Record<number, string>,
  slug: string,
  channels: Channel[],
): Record<number, string> {
  const next: Record<number, string> = { ...previous };
  const allowed = new Set(channels.map((channel) => channel.id));
  for (const [idString, mappedSlug] of Object.entries(next)) {
    if (mappedSlug === slug && !allowed.has(Number(idString))) {
      delete next[Number(idString)];
    }
  }
  for (const channel of channels) {
    next[channel.id] = slug;
  }
  return next;
}

function resolveSelfLogin(state: WorkspaceState, channelId: number): string | null {
  const currentUserId = getCurrentUserId();
  if (currentUserId === null) {
    return null;
  }
  const roomSlug = state.channelRoomById[channelId];
  if (!roomSlug) {
    return null;
  }
  const members = state.membersByRoom[roomSlug] ?? [];
  const membership = members.find((member) => member.user_id === currentUserId);
  return membership?.login ?? null;
}

function computeChannelMetrics(
  state: WorkspaceState,
  channelId: number,
  messages: Message[],
): { lastReadId: number | null; unreadCount: number; mentionCount: number } {
  const currentUserId = getCurrentUserId();
  const previousLastRead = state.lastReadMessageIdByChannel[channelId] ?? null;
  let lastReadId = previousLastRead;

  for (const message of messages) {
    if (message.read_at) {
      lastReadId = lastReadId === null ? message.id : Math.max(lastReadId, message.id);
    }
  }

  const threshold = lastReadId ?? 0;
  let unreadCount = 0;
  let mentionCount = 0;
  const selfLogin = resolveSelfLogin(state, channelId);

  for (const message of messages) {
    if (message.read_at) {
      continue;
    }
    if (message.deleted_at) {
      continue;
    }
    if (message.author_id === currentUserId) {
      continue;
    }
    if (message.id <= threshold) {
      continue;
    }
    unreadCount += 1;
    if (selfLogin && messageMentionsLogin(message.content, selfLogin)) {
      mentionCount += 1;
    }
  }

  return { lastReadId, unreadCount, mentionCount };
}

function extractSelfReactions(message: Message): string[] {
  const currentUserId = getCurrentUserId();
  if (currentUserId === null) {
    return [];
  }
  return message.reactions
    .filter((reaction) => reaction.user_ids.includes(currentUserId))
    .map((reaction) => reaction.emoji);
}

function syncSelfReactions(
  current: Record<number, string[]>,
  messages: Message[],
  previous: Message[] = [],
): Record<number, string[]> {
  const next = { ...current } as Record<number, string[]>;
  const currentIds = new Set(messages.map((message) => message.id));
  for (const item of previous) {
    if (!currentIds.has(item.id)) {
      delete next[item.id];
    }
  }
  for (const message of messages) {
    const own = extractSelfReactions(message);
    if (own.length > 0) {
      next[message.id] = own;
    } else {
      delete next[message.id];
    }
  }
  return next;
}

interface ChannelHistoryMeta {
  nextCursor: string | null;
  prevCursor: string | null;
  hasMoreBackward: boolean;
  hasMoreForward: boolean;
}

function mergeMessageLists(
  existing: Message[],
  incoming: Message[],
  strategy: 'replace' | 'prepend' | 'append',
): Message[] {
  const map = new Map<number, Message>();
  if (strategy === 'prepend') {
    for (const message of incoming) {
      map.set(message.id, message);
    }
    for (const message of existing) {
      map.set(message.id, message);
    }
  } else if (strategy === 'append') {
    for (const message of existing) {
      map.set(message.id, message);
    }
    for (const message of incoming) {
      map.set(message.id, message);
    }
  } else {
    for (const message of incoming) {
      map.set(message.id, message);
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return merged;
}

function mergeHistoryMeta(
  existing: ChannelHistoryMeta | undefined,
  page: MessageHistoryPage,
  strategy: 'replace' | 'prepend' | 'append',
): ChannelHistoryMeta {
  if (!existing || strategy === 'replace') {
    return {
      nextCursor: page.next_cursor,
      prevCursor: page.prev_cursor,
      hasMoreBackward: page.has_more_backward,
      hasMoreForward: page.has_more_forward,
    };
  }
  if (strategy === 'prepend') {
    return {
      nextCursor: page.next_cursor ?? existing.nextCursor,
      prevCursor: existing.prevCursor ?? page.prev_cursor ?? null,
      hasMoreBackward: page.has_more_backward,
      hasMoreForward: existing.hasMoreForward || page.has_more_forward,
    };
  }
  return {
    nextCursor: existing.nextCursor ?? page.next_cursor ?? null,
    prevCursor: page.prev_cursor ?? existing.prevCursor,
    hasMoreBackward: existing.hasMoreBackward || page.has_more_backward,
    hasMoreForward: page.has_more_forward,
  };
}

function applyHistoryPage(
  state: WorkspaceState,
  channelId: number,
  page: MessageHistoryPage,
  strategy: 'replace' | 'prepend' | 'append',
): Partial<WorkspaceState> {
  const existing = state.messagesByChannel[channelId] ?? [];
  const mergedMessages = mergeMessageLists(existing, page.items, strategy);
  const metrics = computeChannelMetrics(state, channelId, mergedMessages);
  const selfReactions = syncSelfReactions(state.selfReactionsByMessage, mergedMessages, existing);
  const nextMeta = mergeHistoryMeta(state.historyMetaByChannel[channelId], page, strategy);

  return {
    messagesByChannel: { ...state.messagesByChannel, [channelId]: mergedMessages },
    historyMetaByChannel: { ...state.historyMetaByChannel, [channelId]: nextMeta },
    lastReadMessageIdByChannel: {
      ...state.lastReadMessageIdByChannel,
      [channelId]: metrics.lastReadId,
    },
    unreadCountByChannel: { ...state.unreadCountByChannel, [channelId]: metrics.unreadCount },
    mentionCountByChannel: { ...state.mentionCountByChannel, [channelId]: metrics.mentionCount },
    selfReactionsByMessage: selfReactions,
  };
}

function getChannelById(state: WorkspaceState, channelId: number): Channel | undefined {
  const slug = state.channelRoomById[channelId];
  if (!slug) {
    return undefined;
  }
  return state.channelsByRoom[slug]?.find((channel) => channel.id === channelId);
}

function isTextChannel(state: WorkspaceState, channelId: number): boolean {
  const channel = getChannelById(state, channelId);
  return Boolean(channel && TEXT_CHANNEL_TYPES.includes(channel.type));
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...initialState,
  async initialize() {
    const lastRoom = getLastRoom();
    set({ ...initialState, loading: true, error: undefined });

    try {
      const rooms = await fetchRooms();
      set({ rooms });

      const preferredRoom =
        (lastRoom && rooms.some((room) => room.slug === lastRoom) && lastRoom) || rooms[0]?.slug || null;

      if (preferredRoom) {
        await get().loadRoom(preferredRoom);
      } else {
        set({ loading: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить комнаты';
      set({ error: message });
      if (lastRoom) {
        try {
          await get().loadRoom(lastRoom);
        } catch (roomError) {
          const roomMessage =
            roomError instanceof Error ? roomError.message : 'Не удалось загрузить комнату';
          set({ error: roomMessage, loading: false });
        }
      } else {
        set({ loading: false });
      }
    }
  },
  registerChannelRoom(slug, channels) {
    set((state) => ({
      channelRoomById: mergeChannelRoomMap(state.channelRoomById, slug, channels),
    }));
  },
  setChannelsByRoom(slug, channels) {
    set((state) => {
      const previous = state.channelsByRoom[slug] ?? [];
      const sorted = sortChannels(channels);
      const previousIds = new Set(previous.map((channel) => channel.id));
      const nextIds = new Set(sorted.map((channel) => channel.id));

      const messagesByChannel = { ...state.messagesByChannel } as Record<number, Message[]>;
      const presenceByChannel = { ...state.presenceByChannel } as Record<number, PresenceUser[]>;
      const typingByChannel = { ...state.typingByChannel } as Record<number, TypingUser[]>;
      const lastReadMessageIdByChannel = {
        ...state.lastReadMessageIdByChannel,
      } as Record<number, number | null>;
      const unreadCountByChannel = { ...state.unreadCountByChannel } as Record<number, number>;
      const mentionCountByChannel = { ...state.mentionCountByChannel } as Record<number, number>;
      const selfReactionsByMessage = { ...state.selfReactionsByMessage } as Record<number, string[]>;

      for (const channel of previous) {
        if (nextIds.has(channel.id)) {
          continue;
        }
        delete messagesByChannel[channel.id];
        delete presenceByChannel[channel.id];
        delete typingByChannel[channel.id];
        delete lastReadMessageIdByChannel[channel.id];
        delete unreadCountByChannel[channel.id];
        delete mentionCountByChannel[channel.id];
        const priorMessages = state.messagesByChannel[channel.id] ?? [];
        for (const message of priorMessages) {
          delete selfReactionsByMessage[message.id];
        }
      }

      for (const channel of sorted) {
        if (!previousIds.has(channel.id)) {
          if (!(channel.id in lastReadMessageIdByChannel)) {
            lastReadMessageIdByChannel[channel.id] = null;
          }
          if (!(channel.id in unreadCountByChannel)) {
            unreadCountByChannel[channel.id] = 0;
          }
          if (!(channel.id in mentionCountByChannel)) {
            mentionCountByChannel[channel.id] = 0;
          }
        }
      }

      const channelRoomById = mergeChannelRoomMap(state.channelRoomById, slug, sorted);
      let selectedChannelId = state.selectedChannelId;
      if (state.selectedRoomSlug === slug) {
        if (selectedChannelId === null || !nextIds.has(selectedChannelId)) {
          selectedChannelId = pickDefaultChannel(sorted);
        }
      }

      const detail = state.roomDetails[slug];
      const roomDetails = detail
        ? { ...state.roomDetails, [slug]: { ...detail, channels: sorted } }
        : state.roomDetails;

      return {
        channelsByRoom: { ...state.channelsByRoom, [slug]: sorted },
        roomDetails,
        channelRoomById,
        messagesByChannel,
        presenceByChannel,
        typingByChannel,
        lastReadMessageIdByChannel,
        unreadCountByChannel,
        mentionCountByChannel,
        selfReactionsByMessage,
        selectedChannelId,
      };
    });
  },
  updateChannel(slug, channel) {
    set((state) => {
      const existing = state.channelsByRoom[slug] ?? [];
      const index = existing.findIndex((candidate) => candidate.id === channel.id);
      const updated =
        index === -1
          ? sortChannels([...existing, channel])
          : sortChannels([
              ...existing.slice(0, index),
              channel,
              ...existing.slice(index + 1),
            ]);

      const channelRoomById = mergeChannelRoomMap(state.channelRoomById, slug, updated);
      const lastReadMessageIdByChannel = { ...state.lastReadMessageIdByChannel } as Record<number, number | null>;
      const unreadCountByChannel = { ...state.unreadCountByChannel } as Record<number, number>;
      const mentionCountByChannel = { ...state.mentionCountByChannel } as Record<number, number>;
      if (index === -1) {
        if (!(channel.id in lastReadMessageIdByChannel)) {
          lastReadMessageIdByChannel[channel.id] = null;
        }
        if (!(channel.id in unreadCountByChannel)) {
          unreadCountByChannel[channel.id] = 0;
        }
        if (!(channel.id in mentionCountByChannel)) {
          mentionCountByChannel[channel.id] = 0;
        }
      }

      let selectedChannelId = state.selectedChannelId;
      if (state.selectedRoomSlug === slug && selectedChannelId === null) {
        selectedChannelId = pickDefaultChannel(updated);
      }

      const detail = state.roomDetails[slug];
      const roomDetails = detail
        ? { ...state.roomDetails, [slug]: { ...detail, channels: updated } }
        : state.roomDetails;

      return {
        channelsByRoom: { ...state.channelsByRoom, [slug]: updated },
        roomDetails,
        channelRoomById,
        lastReadMessageIdByChannel,
        unreadCountByChannel,
        mentionCountByChannel,
        selectedChannelId,
      };
    });
  },
  setCategoriesByRoom(slug, categories) {
    set((state) => {
      const sorted = categories
        .slice()
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      const detail = state.roomDetails[slug];
      const roomDetails = detail
        ? { ...state.roomDetails, [slug]: { ...detail, categories: sorted } }
        : state.roomDetails;
      return {
        categoriesByRoom: { ...state.categoriesByRoom, [slug]: sorted },
        roomDetails,
      };
    });
  },
  setMembersByRoom(slug, members) {
    set((state) => {
      const sorted = sortMembers(members);
      const detail = state.roomDetails[slug];
      const roomDetails = detail
        ? { ...state.roomDetails, [slug]: { ...detail, members: sorted } }
        : state.roomDetails;
      return {
        membersByRoom: { ...state.membersByRoom, [slug]: sorted },
        roomDetails,
      };
    });
  },
  setInvitationsByRoom(slug, invitations) {
    set((state) => {
      const detail = state.roomDetails[slug];
      if (!detail) {
        return {};
      }
      const sorted = sortInvitations(invitations);
      return {
        roomDetails: {
          ...state.roomDetails,
          [slug]: { ...detail, invitations: sorted },
        },
      };
    });
  },
  upsertInvitation(slug, invitation) {
    set((state) => {
      const detail = state.roomDetails[slug];
      if (!detail) {
        return {};
      }
      const invitations = detail.invitations.filter((item) => item.id !== invitation.id);
      invitations.push(invitation);
      const sorted = sortInvitations(invitations);
      return {
        roomDetails: {
          ...state.roomDetails,
          [slug]: { ...detail, invitations: sorted },
        },
      };
    });
  },
  removeInvitation(slug, invitationId) {
    set((state) => {
      const detail = state.roomDetails[slug];
      if (!detail) {
        return {};
      }
      const invitations = detail.invitations.filter((invitation) => invitation.id !== invitationId);
      return {
        roomDetails: {
          ...state.roomDetails,
          [slug]: { ...detail, invitations },
        },
      };
    });
  },
  async createRoom(title) {
    const room = await apiCreateRoom({ title });
    set((state) => ({ rooms: [...state.rooms, room] }));
    await get().loadRoom(room.slug);
  },
  async createCategory(slug, name, position = 0) {
    const category = await apiCreateCategory(slug, { name, position });
    set((state) => {
      const categories = [...(state.categoriesByRoom[slug] ?? []), category].sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      );
      const detail = state.roomDetails[slug];
      return {
        categoriesByRoom: { ...state.categoriesByRoom, [slug]: categories },
        roomDetails: detail
          ? {
              ...state.roomDetails,
              [slug]: { ...detail, categories },
            }
          : state.roomDetails,
      };
    });
  },
  async deleteCategory(slug, categoryId) {
    await apiDeleteCategory(slug, categoryId);
    set((state) => {
      const categories = (state.categoriesByRoom[slug] ?? []).filter((category) => category.id !== categoryId);
      const channels = sortChannels(
        (state.channelsByRoom[slug] ?? []).map((channel) =>
          channel.category_id === categoryId ? { ...channel, category_id: null } : channel,
        ),
      );
      const detail = state.roomDetails[slug];
      return {
        categoriesByRoom: { ...state.categoriesByRoom, [slug]: categories },
        channelsByRoom: { ...state.channelsByRoom, [slug]: channels },
        roomDetails: detail
          ? {
              ...state.roomDetails,
              [slug]: { ...detail, categories, channels },
            }
          : state.roomDetails,
      };
    });
  },
  async createChannel(slug, payload) {
    const channel = await apiCreateChannel(slug, payload);
    set((state) => {
      const channels = sortChannels([...(state.channelsByRoom[slug] ?? []), channel]);
      const detail = state.roomDetails[slug];
      const channelRoomById = mergeChannelRoomMap(state.channelRoomById, slug, channels);
      return {
        channelsByRoom: { ...state.channelsByRoom, [slug]: channels },
        roomDetails: detail
          ? {
              ...state.roomDetails,
              [slug]: { ...detail, channels },
            }
          : state.roomDetails,
        channelRoomById,
        lastReadMessageIdByChannel: {
          ...state.lastReadMessageIdByChannel,
          [channel.id]: null,
        },
        unreadCountByChannel: { ...state.unreadCountByChannel, [channel.id]: 0 },
        mentionCountByChannel: { ...state.mentionCountByChannel, [channel.id]: 0 },
      };
    });
    return channel;
  },
  async deleteChannel(slug, letter) {
    await apiDeleteChannel(slug, letter);
    set((state) => {
      const currentChannels = state.channelsByRoom[slug] ?? [];
      const removedChannel = currentChannels.find((channel) => channel.letter === letter);
      const channels = currentChannels.filter((channel) => channel.letter !== letter);
      const sortedChannels = sortChannels(channels);
      const detail = state.roomDetails[slug];
      const nextSelected = state.selectedChannelId;
      const messagesByChannel = { ...state.messagesByChannel };
      const presenceByChannel = { ...state.presenceByChannel };
      const typingByChannel = { ...state.typingByChannel };
      const lastReadMessageIdByChannel = { ...state.lastReadMessageIdByChannel };
      const unreadCountByChannel = { ...state.unreadCountByChannel };
      const mentionCountByChannel = { ...state.mentionCountByChannel };
      const selfReactionsByMessage = { ...state.selfReactionsByMessage } as Record<number, string[]>;
      let channelRoomById = state.channelRoomById;
      if (removedChannel) {
        delete messagesByChannel[removedChannel.id];
        delete presenceByChannel[removedChannel.id];
        delete typingByChannel[removedChannel.id];
        delete lastReadMessageIdByChannel[removedChannel.id];
        delete unreadCountByChannel[removedChannel.id];
        delete mentionCountByChannel[removedChannel.id];
        const existingMessages = state.messagesByChannel[removedChannel.id] ?? [];
        for (const message of existingMessages) {
          delete selfReactionsByMessage[message.id];
        }
        channelRoomById = mergeChannelRoomMap(state.channelRoomById, slug, sortedChannels);
      }
      return {
        channelsByRoom: { ...state.channelsByRoom, [slug]: sortedChannels },
        roomDetails: detail
          ? {
              ...state.roomDetails,
              [slug]: { ...detail, channels: sortedChannels },
            }
          : state.roomDetails,
        selectedChannelId:
          nextSelected && !sortedChannels.some((channel) => channel.id === nextSelected)
            ? pickDefaultChannel(sortedChannels)
            : nextSelected,
        messagesByChannel,
        presenceByChannel,
        typingByChannel,
        channelRoomById,
        lastReadMessageIdByChannel,
        unreadCountByChannel,
        mentionCountByChannel,
        selfReactionsByMessage,
      };
    });
  },
  async reorderChannels(slug, ordering) {
    const stateBefore = get();
    const existing = stateBefore.channelsByRoom[slug] ?? [];
    if (existing.length === 0) {
      await apiReorderChannels(slug, ordering);
      return;
    }
    const entryMap = new Map(ordering.map((entry) => [entry.id, entry]));
    const updated = existing.map((channel) => {
      const entry = entryMap.get(channel.id);
      if (!entry) {
        return channel;
      }
      return {
        ...channel,
        category_id: entry.category_id,
        position: entry.position,
      };
    });
    const sorted = sortChannels(updated);
    const detailBefore = stateBefore.roomDetails[slug];
    const previousChannelRoomById = mergeChannelRoomMap(
      stateBefore.channelRoomById,
      slug,
      existing,
    );
    const nextChannelRoomById = mergeChannelRoomMap(stateBefore.channelRoomById, slug, sorted);

    set(() => ({
      channelsByRoom: { ...stateBefore.channelsByRoom, [slug]: sorted },
      roomDetails: detailBefore
        ? {
            ...stateBefore.roomDetails,
            [slug]: { ...detailBefore, channels: sorted },
          }
        : stateBefore.roomDetails,
      channelRoomById: nextChannelRoomById,
    }));

    try {
      await apiReorderChannels(slug, ordering);
    } catch (error) {
      set((state) => ({
        channelsByRoom: { ...state.channelsByRoom, [slug]: existing },
        roomDetails: detailBefore
          ? {
              ...state.roomDetails,
              [slug]: { ...detailBefore, channels: existing },
            }
          : state.roomDetails,
        channelRoomById: previousChannelRoomById,
      }));
      throw error;
    }
  },
  async reorderCategories(slug, ordering) {
    const stateBefore = get();
    const existing = stateBefore.categoriesByRoom[slug] ?? [];
    if (existing.length === 0) {
      await apiReorderCategories(slug, ordering);
      return;
    }
    const positionMap = new Map(ordering.map((entry) => [entry.id, entry.position]));
    const updated = [...existing].map((category) =>
      positionMap.has(category.id)
        ? { ...category, position: positionMap.get(category.id) ?? category.position }
        : category,
    );
    updated.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const detailBefore = stateBefore.roomDetails[slug];

    set(() => ({
      categoriesByRoom: { ...stateBefore.categoriesByRoom, [slug]: updated },
      roomDetails: detailBefore
        ? {
            ...stateBefore.roomDetails,
            [slug]: { ...detailBefore, categories: updated },
          }
        : stateBefore.roomDetails,
    }));

    try {
      await apiReorderCategories(slug, ordering);
    } catch (error) {
      set((state) => ({
        categoriesByRoom: { ...state.categoriesByRoom, [slug]: existing },
        roomDetails: detailBefore
          ? {
              ...state.roomDetails,
              [slug]: { ...detailBefore, categories: existing },
            }
          : state.roomDetails,
      }));
      throw error;
    }
  },
  async refreshInvitations(slug) {
    const invitations = await listInvitations(slug);
    get().setInvitationsByRoom(slug, invitations);
  },
  async createInvitation(slug, payload) {
    const invitation = await apiCreateInvitation({ room_slug: slug, ...payload });
    get().upsertInvitation(slug, invitation);
  },
  async deleteInvitation(slug, invitationId) {
    const detail = get().roomDetails[slug];
    const previous = detail ? detail.invitations.slice() : null;
    if (detail) {
      get().removeInvitation(slug, invitationId);
    }
    try {
      await apiDeleteInvitation(slug, invitationId);
    } catch (error) {
      if (previous) {
        get().setInvitationsByRoom(slug, previous);
      }
      throw error;
    }
  },
  async updateRoleLevel(slug, role, level) {
    await apiUpdateRoleLevel(slug, role, level);
    set((state) => {
      const detail = state.roomDetails[slug];
      if (!detail) {
        return {};
      }
      const role_hierarchy = detail.role_hierarchy.map((entry) =>
        entry.role === role ? { ...entry, level } : entry,
      );
      role_hierarchy.sort((a, b) => b.level - a.level);
      return {
        roomDetails: {
          ...state.roomDetails,
          [slug]: { ...detail, role_hierarchy },
        },
      };
    });
  },
  async loadChannelPermissions(channelId) {
    const summary = await fetchChannelPermissions(channelId);
    set((state) => ({
      channelPermissions: { ...state.channelPermissions, [channelId]: summary },
    }));
    return summary;
  },
  async updateChannelRolePermissions(channelId, role, payload) {
    const entry = await apiUpdateChannelRolePermissions(channelId, role, payload);
    set((state) => {
      const existing = state.channelPermissions[channelId];
      const base: ChannelPermissionSummary = existing
        ? { ...existing, roles: [...existing.roles], users: [...existing.users] }
        : { channel_id: channelId, roles: [], users: [] };
      const roles = base.roles.filter((item) => item.role !== role);
      roles.push(entry);
      roles.sort((a, b) => a.role.localeCompare(b.role));
      return {
        channelPermissions: {
          ...state.channelPermissions,
          [channelId]: { ...base, roles },
        },
      };
    });
    return entry;
  },
  async deleteChannelRolePermissions(channelId, role) {
    await apiDeleteChannelRolePermissions(channelId, role);
    set((state) => {
      const existing = state.channelPermissions[channelId];
      if (!existing) {
        return {};
      }
      const roles = existing.roles.filter((item) => item.role !== role);
      return {
        channelPermissions: {
          ...state.channelPermissions,
          [channelId]: { ...existing, roles },
        },
      };
    });
  },
  async updateChannelUserPermissions(channelId, userId, payload) {
    const entry = await apiUpdateChannelUserPermissions(channelId, userId, payload);
    set((state) => {
      const existing = state.channelPermissions[channelId];
      const base: ChannelPermissionSummary = existing
        ? { ...existing, roles: [...existing.roles], users: [...existing.users] }
        : { channel_id: channelId, roles: [], users: [] };
      const users = base.users.filter((item) => item.user_id !== userId);
      users.push(entry);
      users.sort((a, b) => a.login.localeCompare(b.login));
      return {
        channelPermissions: {
          ...state.channelPermissions,
          [channelId]: { ...base, users },
        },
      };
    });
    return entry;
  },
  async deleteChannelUserPermissions(channelId, userId) {
    await apiDeleteChannelUserPermissions(channelId, userId);
    set((state) => {
      const existing = state.channelPermissions[channelId];
      if (!existing) {
        return {};
      }
      const users = existing.users.filter((item) => item.user_id !== userId);
      return {
        channelPermissions: {
          ...state.channelPermissions,
          [channelId]: { ...existing, users },
        },
      };
    });
  },
  async loadRoom(slug) {
    const existingDetail = get().roomDetails[slug];
    if (existingDetail) {
      setLastRoom(slug);
      set((state) => {
        const channels = state.channelsByRoom[slug] ?? existingDetail.channels ?? [];
        const availableChannelIds = new Set(channels.map((channel) => channel.id));
        let selectedChannelId = state.selectedChannelId;
        if (!selectedChannelId || !availableChannelIds.has(selectedChannelId)) {
          selectedChannelId = pickDefaultChannel(channels);
        }
        return {
          selectedRoomSlug: slug,
          selectedChannelId,
          loading: false,
          error: undefined,
        };
      });
      return;
    }

    set({ loading: true, error: undefined });
    try {
      const detail = await fetchRoomDetail(slug);
      setLastRoom(slug);

      set((state) => {
        const channels = detail.channels.slice().sort((a, b) => a.letter.localeCompare(b.letter));
        const categories = detail.categories
          .slice()
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
        const members = sortMembers(detail.members);
        const invitations = sortInvitations(detail.invitations);
        const selectedChannelId = pickDefaultChannel(channels);
        const nextChannelRoomById = mergeChannelRoomMap(state.channelRoomById, slug, channels);
        const nextLastRead = { ...state.lastReadMessageIdByChannel } as Record<number, number | null>;
        const nextUnread = { ...state.unreadCountByChannel } as Record<number, number>;
        const nextMentions = { ...state.mentionCountByChannel } as Record<number, number>;
        const metricsState = { ...state, channelRoomById: nextChannelRoomById } as WorkspaceState;

        for (const channel of channels) {
          const messages = state.messagesByChannel[channel.id];
          if (!messages) {
            if (!(channel.id in nextLastRead)) {
              nextLastRead[channel.id] = null;
            }
            if (!(channel.id in nextUnread)) {
              nextUnread[channel.id] = 0;
            }
            if (!(channel.id in nextMentions)) {
              nextMentions[channel.id] = 0;
            }
            continue;
          }
          const metrics = computeChannelMetrics(metricsState, channel.id, messages);
          nextLastRead[channel.id] = metrics.lastReadId;
          nextUnread[channel.id] = metrics.unreadCount;
          nextMentions[channel.id] = metrics.mentionCount;
        }

        const roomDetails: RoomDetail = {
          ...detail,
          channels,
          categories,
          members,
          invitations,
        };

        return {
          roomDetails: { ...state.roomDetails, [slug]: roomDetails },
          channelsByRoom: { ...state.channelsByRoom, [slug]: channels },
          categoriesByRoom: { ...state.categoriesByRoom, [slug]: categories },
          membersByRoom: { ...state.membersByRoom, [slug]: members },
          selectedRoomSlug: slug,
          selectedChannelId,
          loading: false,
          error: undefined,
          channelRoomById: nextChannelRoomById,
          lastReadMessageIdByChannel: nextLastRead,
          unreadCountByChannel: nextUnread,
          mentionCountByChannel: nextMentions,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить комнату';
      set({ error: message, loading: false });
    }
  },
  async refreshChannelHistory(channelId) {
    const state = get();
    if (!isTextChannel(state, channelId)) {
      return;
    }
    try {
      const page = await fetchChannelHistory(channelId);
      set((state) => ({
        ...applyHistoryPage(state, channelId, page, 'replace'),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось обновить историю канала';
      set({ error: message });
    }
  },
  async loadOlderHistory(channelId) {
    const state = get();
    if (!isTextChannel(state, channelId)) {
      return;
    }
    const { historyMetaByChannel, loadingOlderByChannel } = state;
    const meta = historyMetaByChannel[channelId];
    if (!meta?.nextCursor || loadingOlderByChannel[channelId]) {
      return;
    }
    set((state) => ({
      loadingOlderByChannel: { ...state.loadingOlderByChannel, [channelId]: true },
    }));
    try {
      const page = await fetchChannelHistory(channelId, {
        cursor: meta.nextCursor,
        direction: 'backward',
      });
      set((state) => ({
        ...applyHistoryPage(state, channelId, page, 'prepend'),
        loadingOlderByChannel: { ...state.loadingOlderByChannel, [channelId]: false },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось обновить историю канала';
      set((state) => ({
        loadingOlderByChannel: { ...state.loadingOlderByChannel, [channelId]: false },
        error: message,
      }));
    }
  },
  async loadNewerHistory(channelId) {
    const state = get();
    if (!isTextChannel(state, channelId)) {
      return;
    }
    const { historyMetaByChannel, loadingNewerByChannel } = state;
    const meta = historyMetaByChannel[channelId];
    if (!meta?.prevCursor || loadingNewerByChannel[channelId]) {
      return;
    }
    set((state) => ({
      loadingNewerByChannel: { ...state.loadingNewerByChannel, [channelId]: true },
    }));
    try {
      const page = await fetchChannelHistory(channelId, {
        cursor: meta.prevCursor,
        direction: 'forward',
      });
      set((state) => ({
        ...applyHistoryPage(state, channelId, page, 'append'),
        loadingNewerByChannel: { ...state.loadingNewerByChannel, [channelId]: false },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось обновить историю канала';
      set((state) => ({
        loadingNewerByChannel: { ...state.loadingNewerByChannel, [channelId]: false },
        error: message,
      }));
    }
  },
  selectRoom(slug) {
    void get().loadRoom(slug);
  },
  selectChannel(channelId) {
    set({ selectedChannelId: channelId });
  },
  ingestHistory(channelId, page) {
    set((state) => ({
      ...applyHistoryPage(state, channelId, page, 'replace'),
    }));
  },
  ingestMessage(channelId, message) {
    set((state) => {
      const existing = state.messagesByChannel[channelId] ?? [];
      const next = existing.slice();
      const index = next.findIndex((item) => item.id === message.id);
      if (index >= 0) {
        next[index] = message;
      } else {
        next.push(message);
      }
      next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const metrics = computeChannelMetrics(state, channelId, next);
      const selfReactions = { ...state.selfReactionsByMessage } as Record<number, string[]>;
      const own = extractSelfReactions(message);
      if (own.length > 0) {
        selfReactions[message.id] = own;
      } else {
        delete selfReactions[message.id];
      }
      return {
        messagesByChannel: { ...state.messagesByChannel, [channelId]: next },
        lastReadMessageIdByChannel: {
          ...state.lastReadMessageIdByChannel,
          [channelId]: metrics.lastReadId,
        },
        unreadCountByChannel: { ...state.unreadCountByChannel, [channelId]: metrics.unreadCount },
        mentionCountByChannel: { ...state.mentionCountByChannel, [channelId]: metrics.mentionCount },
        selfReactionsByMessage: selfReactions,
      };
    });
  },
  setPresenceSnapshot(channelId, users) {
    usePresenceStore.getState().setChannelSnapshot(channelId, users);
    set((state) => ({
      presenceByChannel: { ...state.presenceByChannel, [channelId]: users },
    }));
  },
  setTypingSnapshot(channelId, users) {
    set((state) => ({
      typingByChannel: { ...state.typingByChannel, [channelId]: users },
    }));
  },
  async loadPinnedMessages(channelId) {
    const currentState = get();
    if (!isTextChannel(currentState, channelId)) {
      return;
    }
    set((state) => ({
      loadingPinsByChannel: { ...state.loadingPinsByChannel, [channelId]: true },
    }));
    try {
      const pins = await fetchChannelPins(channelId);
      set((state) => {
        const previousMessages = state.messagesByChannel[channelId] ?? [];
        let nextMessages = previousMessages;
        let changed = false;

        for (const pin of pins) {
          const index = nextMessages.findIndex((message) => message.id === pin.message_id);
          if (index >= 0) {
            if (!changed) {
              nextMessages = nextMessages.slice();
              changed = true;
            }
            nextMessages[index] = pin.message;
          }
        }

        const updates: Partial<WorkspaceState> = {
          pinnedByChannel: { ...state.pinnedByChannel, [channelId]: pins },
          loadingPinsByChannel: { ...state.loadingPinsByChannel, [channelId]: false },
        };

        if (changed) {
          nextMessages.sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
          const metrics = computeChannelMetrics(state, channelId, nextMessages);
          const selfReactions = syncSelfReactions(
            state.selfReactionsByMessage,
            nextMessages,
            previousMessages,
          );
          Object.assign(updates, {
            messagesByChannel: { ...state.messagesByChannel, [channelId]: nextMessages },
            lastReadMessageIdByChannel: {
              ...state.lastReadMessageIdByChannel,
              [channelId]: metrics.lastReadId,
            },
            unreadCountByChannel: {
              ...state.unreadCountByChannel,
              [channelId]: metrics.unreadCount,
            },
            mentionCountByChannel: {
              ...state.mentionCountByChannel,
              [channelId]: metrics.mentionCount,
            },
            selfReactionsByMessage: selfReactions,
          });
        }

        return updates;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить закрепы';
      set((state) => ({
        loadingPinsByChannel: { ...state.loadingPinsByChannel, [channelId]: false },
        error: message,
      }));
    }
  },
  async pinMessage(channelId, messageId, note) {
    try {
      const pin = await pinChannelMessage(channelId, messageId, note ?? null);
      set((state) => {
        const existing = state.pinnedByChannel[channelId] ?? [];
        const filtered = existing.filter((item) => item.message_id !== pin.message_id);
        const nextPins = [pin, ...filtered];
        nextPins.sort(
          (a, b) => new Date(b.pinned_at).getTime() - new Date(a.pinned_at).getTime(),
        );

        const previousMessages = state.messagesByChannel[channelId] ?? [];
        const index = previousMessages.findIndex((item) => item.id === pin.message_id);

        const updates: Partial<WorkspaceState> = {
          pinnedByChannel: { ...state.pinnedByChannel, [channelId]: nextPins },
        };

        if (index >= 0) {
          const nextMessages = previousMessages.slice();
          nextMessages[index] = pin.message;
          nextMessages.sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
          const metrics = computeChannelMetrics(state, channelId, nextMessages);
          const selfReactions = syncSelfReactions(
            state.selfReactionsByMessage,
            nextMessages,
            previousMessages,
          );
          Object.assign(updates, {
            messagesByChannel: { ...state.messagesByChannel, [channelId]: nextMessages },
            lastReadMessageIdByChannel: {
              ...state.lastReadMessageIdByChannel,
              [channelId]: metrics.lastReadId,
            },
            unreadCountByChannel: {
              ...state.unreadCountByChannel,
              [channelId]: metrics.unreadCount,
            },
            mentionCountByChannel: {
              ...state.mentionCountByChannel,
              [channelId]: metrics.mentionCount,
            },
            selfReactionsByMessage: selfReactions,
          });
        }

        return updates;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось закрепить сообщение';
      set({ error: message });
    }
  },
  async unpinMessage(channelId, messageId) {
    try {
      await unpinChannelMessage(channelId, messageId);
      set((state) => {
        const existing = state.pinnedByChannel[channelId] ?? [];
        const nextPins = existing.filter((item) => item.message_id !== messageId);
        const previousMessages = state.messagesByChannel[channelId] ?? [];
        const index = previousMessages.findIndex((item) => item.id === messageId);

        const updates: Partial<WorkspaceState> = {
          pinnedByChannel: { ...state.pinnedByChannel, [channelId]: nextPins },
        };

        if (index >= 0) {
          const nextMessages = previousMessages.slice();
          nextMessages[index] = {
            ...nextMessages[index],
            pinned_at: null,
            pinned_by: null,
          };
          const metrics = computeChannelMetrics(state, channelId, nextMessages);
          const selfReactions = syncSelfReactions(
            state.selfReactionsByMessage,
            nextMessages,
            previousMessages,
          );
          Object.assign(updates, {
            messagesByChannel: { ...state.messagesByChannel, [channelId]: nextMessages },
            lastReadMessageIdByChannel: {
              ...state.lastReadMessageIdByChannel,
              [channelId]: metrics.lastReadId,
            },
            unreadCountByChannel: {
              ...state.unreadCountByChannel,
              [channelId]: metrics.unreadCount,
            },
            mentionCountByChannel: {
              ...state.mentionCountByChannel,
              [channelId]: metrics.mentionCount,
            },
            selfReactionsByMessage: selfReactions,
          });
        }

        return updates;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось открепить сообщение';
      set({ error: message });
    }
  },
  setVoiceParticipants(roomSlug, participants) {
    const sorted = participants
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
    set((state) => {
      const nextByRoom = { ...state.voiceParticipantsByRoom, [roomSlug]: sorted };
      const allowed = new Set<number>();
      for (const list of Object.values(nextByRoom)) {
        for (const participant of list) {
          allowed.add(participant.id);
        }
      }
      const nextVolumes: Record<number, number> = {};
      for (const [idString, value] of Object.entries(state.voiceParticipantVolumes)) {
        const id = Number(idString);
        if (!Number.isFinite(id)) {
          continue;
        }
        if (allowed.has(id)) {
          nextVolumes[id] = value;
        }
      }
      return {
        voiceParticipantsByRoom: nextByRoom,
        voiceParticipantVolumes: nextVolumes,
      };
    });
  },
  updateVoiceParticipant(roomSlug, participant) {
    set((state) => {
      const bucket = state.voiceParticipantsByRoom[roomSlug] ?? [];
      const index = bucket.findIndex((item) => item.id === participant.id);
      const merged = index >= 0 ? { ...bucket[index], ...participant } : participant;
      const next =
        index >= 0
          ? [...bucket.slice(0, index), merged, ...bucket.slice(index + 1)]
          : [...bucket, merged];
      next.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
      );
      return {
        voiceParticipantsByRoom: { ...state.voiceParticipantsByRoom, [roomSlug]: next },
      };
    });
  },
  removeVoiceParticipant(roomSlug, participantId) {
    set((state) => {
      const bucket = state.voiceParticipantsByRoom[roomSlug] ?? [];
      const next = bucket.filter((participant) => participant.id !== participantId);
      const nextActivity = { ...state.voiceActivity } as VoiceActivityState;
      delete nextActivity[participantId];
      const nextStreams = { ...state.voiceRemoteStreams } as Record<number, MediaStream | null>;
      delete nextStreams[participantId];
      const nextVolumes = { ...state.voiceParticipantVolumes } as Record<number, number>;
      delete nextVolumes[participantId];
      return {
        voiceParticipantsByRoom: { ...state.voiceParticipantsByRoom, [roomSlug]: next },
        voiceActivity: nextActivity,
        voiceRemoteStreams: nextStreams,
        voiceParticipantVolumes: nextVolumes,
      };
    });
  },
  setVoiceStats(roomSlug, stats) {
    set((state) => ({
      voiceStatsByRoom: { ...state.voiceStatsByRoom, [roomSlug]: stats },
    }));
  },
  setVoiceConnectionStatus(status, error) {
    set({ voiceConnectionStatus: status, voiceConnectionError: error });
  },
  setVoiceConnectionMeta(meta) {
    set((state) => ({
      voiceRoomSlug: meta.roomSlug !== undefined ? meta.roomSlug : state.voiceRoomSlug,
      activeVoiceChannelId:
        meta.channelId !== undefined ? meta.channelId : state.activeVoiceChannelId,
      voiceLocalParticipantId:
        meta.localParticipantId !== undefined
          ? meta.localParticipantId
          : state.voiceLocalParticipantId,
      voiceLocalRole: meta.localRole !== undefined ? meta.localRole : state.voiceLocalRole,
      voiceFeatures: meta.features !== undefined ? meta.features : state.voiceFeatures,
    }));
  },
  setVoiceMuted(muted) {
    set({ muted });
  },
  setVoiceDeafened(deafened) {
    set({ deafened });
  },
  setVoiceVideoEnabled(enabled) {
    set({ videoEnabled: enabled });
  },
  setVoiceDevices(devices) {
    set({ voiceDevices: devices });
  },
  setSelectedMicrophoneId(deviceId) {
    set({ selectedMicrophoneId: deviceId });
  },
  setSelectedSpeakerId(deviceId) {
    set({ selectedSpeakerId: deviceId });
  },
  setSelectedCameraId(deviceId) {
    set({ selectedCameraId: deviceId });
  },
  setVoicePlaybackVolume(volume) {
    const clamped = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 2) : 1;
    set((state) => {
      if (Math.abs(state.voicePlaybackVolume - clamped) < 0.001) {
        return {};
      }
      return { voicePlaybackVolume: clamped };
    });
    setStoredVoicePlaybackVolume(clamped);
  },
  setVoiceParticipantVolume(participantId, volume) {
    set((state) => {
      const next = { ...state.voiceParticipantVolumes } as Record<number, number>;
      if (volume === null || !Number.isFinite(volume)) {
        if (!(participantId in next)) {
          return {};
        }
        delete next[participantId];
        return { voiceParticipantVolumes: next };
      }
      const clamped = Math.min(Math.max(volume, 0), 2);
      if (Math.abs(clamped - 1) < 0.001) {
        if (participantId in next) {
          delete next[participantId];
          return { voiceParticipantVolumes: next };
        }
        return {};
      }
      if (Math.abs((next[participantId] ?? NaN) - clamped) < 0.001) {
        return {};
      }
      next[participantId] = clamped;
      return { voiceParticipantVolumes: next };
    });
  },
  setVoiceParticipantQuality(roomSlug, participantId, track, metrics) {
    set((state) => {
      const bucket = state.voiceParticipantsByRoom[roomSlug] ?? [];
      const index = bucket.findIndex((item) => item.id === participantId);
      if (index < 0) {
        return {};
      }
      const participant = bucket[index];
      const quality = { ...(participant.quality ?? {}) } as Record<string, VoiceQualityMetrics>;
      quality[track] = { ...metrics };
      const nextParticipant = { ...participant, quality } as VoiceParticipant;
      const next = [...bucket];
      next[index] = nextParticipant;
      return {
        voiceParticipantsByRoom: { ...state.voiceParticipantsByRoom, [roomSlug]: next },
      };
    });
  },
  setVoiceGain(gain) {
    const clamped = Number.isFinite(gain) ? Math.min(Math.max(gain, 0.1), 4) : 1;
    set({ voiceGain: clamped });
  },
  setVoiceAutoGain(enabled) {
    set({ voiceAutoGain: enabled });
  },
  setVoiceInputLevel(level) {
    const safeLevel = Number.isFinite(level) ? Math.min(Math.max(level, 0), 1) : 0;
    set({ voiceInputLevel: safeLevel });
  },
  setScreenShareQuality(quality) {
    set({ screenShareQuality: quality });
  },
  setVoiceActivity(participantId, activity) {
    set((state) => ({
      voiceActivity: { ...state.voiceActivity, [participantId]: activity },
    }));
  },
  clearVoiceActivity(participantId) {
    set((state) => {
      if (!(participantId in state.voiceActivity)) {
        return {};
      }
      const next = { ...state.voiceActivity } as VoiceActivityState;
      delete next[participantId];
      return { voiceActivity: next };
    });
  },
  setVoiceRemoteStream(participantId, stream) {
    set((state) => {
      const logger = console; // Use console directly here since logger might not be available
      logger.debug('[store] setVoiceRemoteStream called', {
        participantId,
        hasStream: stream !== null,
        streamId: stream?.id,
        currentStreams: Object.keys(state.voiceRemoteStreams),
        currentStreamForParticipant: state.voiceRemoteStreams[participantId] ? 'exists' : 'missing',
      });
      
      if (!stream) {
        if (!(participantId in state.voiceRemoteStreams)) {
          logger.debug('[store] Stream is null and not in store, no update needed', { participantId });
          return {};
        }
        const next = { ...state.voiceRemoteStreams } as Record<number, MediaStream | null>;
        delete next[participantId];
        logger.debug('[store] Removed stream from store', {
          participantId,
          remainingStreams: Object.keys(next),
        });
        return { voiceRemoteStreams: next };
      }
      
      const next = {
        voiceRemoteStreams: { ...state.voiceRemoteStreams, [participantId]: stream },
      };
      
      logger.debug('[store] Stream added to store', {
        participantId,
        streamId: stream.id,
        allStreamIds: Object.keys(next.voiceRemoteStreams),
        audioTracks: stream.getAudioTracks().length,
      });
      
      return next;
    });
  },
  setActiveVoiceChannel(channelId) {
    set({ activeVoiceChannelId: channelId });
  },
  resetVoiceState() {
    set({
      voiceParticipantsByRoom: {},
      voiceStatsByRoom: {},
      voiceConnectionStatus: initialState.voiceConnectionStatus,
      voiceConnectionError: undefined,
      voiceRoomSlug: null,
      activeVoiceChannelId: null,
      voiceLocalParticipantId: null,
      voiceLocalRole: null,
      voiceFeatures: null,
      voiceActivity: {},
      voiceRemoteStreams: {},
      voiceInputLevel: 0,
      screenShareQuality: initialState.screenShareQuality,
      voiceParticipantVolumes: {},
    });
  },
  setError(message) {
    set({ error: message });
  },
  reset() {
    set({ ...initialState });
  },
}));
