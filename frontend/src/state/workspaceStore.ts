import { create } from 'zustand';

import {
  createCategory as apiCreateCategory,
  createChannel as apiCreateChannel,
  createInvitation as apiCreateInvitation,
  createRoom as apiCreateRoom,
  deleteCategory as apiDeleteCategory,
  deleteChannel as apiDeleteChannel,
  deleteInvitation as apiDeleteInvitation,
  fetchChannelHistory,
  fetchRoomDetail,
  fetchRooms,
  listInvitations,
  updateRoleLevel as apiUpdateRoleLevel,
} from '../services/api';
import { getLastRoom, setLastRoom } from '../services/storage';
import type {
  Channel,
  ChannelCategory,
  Message,
  PresenceUser,
  RoomRole,
  RoomDetail,
  RoomSummary,
  RoomMemberSummary,
  TypingUser,
  VoiceParticipant,
  VoiceRoomStats,
  VoiceFeatureFlags,
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

interface WorkspaceState {
  rooms: RoomSummary[];
  roomDetails: Record<string, RoomDetail>;
  categoriesByRoom: Record<string, ChannelCategory[]>;
  channelsByRoom: Record<string, Channel[]>;
  messagesByChannel: Record<number, Message[]>;
  presenceByChannel: Record<number, PresenceUser[]>;
  typingByChannel: Record<number, TypingUser[]>;
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
  selectRoom: (slug: string) => void;
  selectChannel: (channelId: number) => void;
  ingestHistory: (channelId: number, messages: Message[]) => void;
  ingestMessage: (channelId: number, message: Message) => void;
  setPresenceSnapshot: (channelId: number, users: PresenceUser[]) => void;
  setTypingSnapshot: (channelId: number, users: TypingUser[]) => void;
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
  refreshInvitations: (slug: string) => Promise<void>;
  createInvitation: (
    slug: string,
    payload: { role: RoomRole; expires_at?: string | null },
  ) => Promise<void>;
  deleteInvitation: (slug: string, invitationId: number) => Promise<void>;
  updateRoleLevel: (slug: string, role: RoomRole, level: number) => Promise<void>;
}

const initialState: Pick<
  WorkspaceState,
  | 'rooms'
  | 'roomDetails'
  | 'categoriesByRoom'
  | 'channelsByRoom'
  | 'messagesByChannel'
  | 'presenceByChannel'
  | 'typingByChannel'
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
  presenceByChannel: {},
  typingByChannel: {},
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
  const textChannel = channels.find((channel) => channel.type === 'text');
  return (textChannel ?? channels[0]).id;
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
      const channels = (state.channelsByRoom[slug] ?? []).map((channel) =>
        channel.category_id === categoryId ? { ...channel, category_id: null } : channel,
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
      const channels = [...(state.channelsByRoom[slug] ?? []), channel].sort((a, b) =>
        a.letter.localeCompare(b.letter),
      );
      const detail = state.roomDetails[slug];
      return {
        channelsByRoom: { ...state.channelsByRoom, [slug]: channels },
        roomDetails: detail
          ? {
              ...state.roomDetails,
              [slug]: { ...detail, channels },
            }
          : state.roomDetails,
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
      const detail = state.roomDetails[slug];
      const nextSelected = state.selectedChannelId;
      const messagesByChannel = { ...state.messagesByChannel };
      const presenceByChannel = { ...state.presenceByChannel };
      const typingByChannel = { ...state.typingByChannel };
      if (removedChannel) {
        delete messagesByChannel[removedChannel.id];
        delete presenceByChannel[removedChannel.id];
        delete typingByChannel[removedChannel.id];
      }
      return {
        channelsByRoom: { ...state.channelsByRoom, [slug]: channels },
        roomDetails: detail
          ? {
              ...state.roomDetails,
              [slug]: { ...detail, channels },
            }
          : state.roomDetails,
        selectedChannelId:
          nextSelected && !channels.some((channel) => channel.id === nextSelected)
            ? pickDefaultChannel(channels)
            : nextSelected,
        messagesByChannel,
        presenceByChannel,
        typingByChannel,
      };
    });
  },
  async refreshInvitations(slug) {
    const invitations = await listInvitations(slug);
    set((state) => {
      const detail = state.roomDetails[slug];
      return detail
        ? {
            roomDetails: {
              ...state.roomDetails,
              [slug]: { ...detail, invitations },
            },
          }
        : {};
    });
  },
  async createInvitation(slug, payload) {
    await apiCreateInvitation({ room_slug: slug, ...payload });
    await get().refreshInvitations(slug);
  },
  async deleteInvitation(slug, invitationId) {
    await apiDeleteInvitation(slug, invitationId);
    await get().refreshInvitations(slug);
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
  async loadRoom(slug) {
    set({ loading: true, error: undefined });
    try {
      const detail = await fetchRoomDetail(slug);
      setLastRoom(slug);

      set((state) => {
        const channels = detail.channels.slice().sort((a, b) => a.letter.localeCompare(b.letter));
        const categories = detail.categories
          .slice()
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
        const selectedChannelId = pickDefaultChannel(channels);

        return {
          roomDetails: { ...state.roomDetails, [slug]: detail },
          channelsByRoom: { ...state.channelsByRoom, [slug]: channels },
          categoriesByRoom: { ...state.categoriesByRoom, [slug]: categories },
          membersByRoom: { ...state.membersByRoom, [slug]: detail.members },
          selectedRoomSlug: slug,
          selectedChannelId,
          loading: false,
          error: undefined,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить комнату';
      set({ error: message, loading: false });
    }
  },
  async refreshChannelHistory(channelId) {
    try {
      const history = await fetchChannelHistory(channelId);
      set((state) => ({
        messagesByChannel: { ...state.messagesByChannel, [channelId]: history },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось обновить историю канала';
      set({ error: message });
    }
  },
  selectRoom(slug) {
    void get().loadRoom(slug);
  },
  selectChannel(channelId) {
    set({ selectedChannelId: channelId });
    void get().refreshChannelHistory(channelId);
  },
  ingestHistory(channelId, messages) {
    set((state) => ({
      messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
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
      return {
        messagesByChannel: { ...state.messagesByChannel, [channelId]: next },
      };
    });
  },
  setPresenceSnapshot(channelId, users) {
    set((state) => ({
      presenceByChannel: { ...state.presenceByChannel, [channelId]: users },
    }));
  },
  setTypingSnapshot(channelId, users) {
    set((state) => ({
      typingByChannel: { ...state.typingByChannel, [channelId]: users },
    }));
  },
  setVoiceParticipants(roomSlug, participants) {
    const sorted = participants
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
    set((state) => ({
      voiceParticipantsByRoom: { ...state.voiceParticipantsByRoom, [roomSlug]: sorted },
    }));
  },
  updateVoiceParticipant(roomSlug, participant) {
    set((state) => {
      const bucket = state.voiceParticipantsByRoom[roomSlug] ?? [];
      const index = bucket.findIndex((item) => item.id === participant.id);
      const next =
        index >= 0
          ? [...bucket.slice(0, index), participant, ...bucket.slice(index + 1)]
          : [...bucket, participant];
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
      return {
        voiceParticipantsByRoom: { ...state.voiceParticipantsByRoom, [roomSlug]: next },
        voiceActivity: nextActivity,
        voiceRemoteStreams: nextStreams,
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
      if (!stream) {
        if (!(participantId in state.voiceRemoteStreams)) {
          return {};
        }
        const next = { ...state.voiceRemoteStreams } as Record<number, MediaStream | null>;
        delete next[participantId];
        return { voiceRemoteStreams: next };
      }
      return {
        voiceRemoteStreams: { ...state.voiceRemoteStreams, [participantId]: stream },
      };
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
    });
  },
  setError(message) {
    set({ error: message });
  },
  reset() {
    set({ ...initialState });
  },
}));
