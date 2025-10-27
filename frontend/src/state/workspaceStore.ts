import { create } from 'zustand';

import {
  fetchChannelHistory,
  fetchRoomDetail,
  fetchRooms,
} from '../services/api';
import { getLastRoom, setLastRoom } from '../services/storage';
import type {
  Channel,
  ChannelCategory,
  Message,
  PresenceUser,
  RoomDetail,
  RoomSummary,
  TypingUser,
  VoiceParticipant,
} from '../types';

interface WorkspaceState {
  rooms: RoomSummary[];
  roomDetails: Record<string, RoomDetail>;
  categoriesByRoom: Record<string, ChannelCategory[]>;
  channelsByRoom: Record<string, Channel[]>;
  messagesByChannel: Record<number, Message[]>;
  presenceByChannel: Record<number, PresenceUser[]>;
  typingByChannel: Record<number, TypingUser[]>;
  voiceParticipantsByRoom: Record<string, VoiceParticipant[]>;
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
  setError: (message: string | undefined) => void;
  reset: () => void;
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
    set((state) => ({
      voiceParticipantsByRoom: { ...state.voiceParticipantsByRoom, [roomSlug]: participants },
    }));
  },
  setError(message) {
    set({ error: message });
  },
  reset() {
    set({ ...initialState });
  },
}));
