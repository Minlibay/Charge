import { create } from 'zustand';

import type { FriendUser, PresenceStatus, PresenceUser } from '../types';

type PresenceBroadcastMessage =
  | { type: 'channelSnapshot'; channelId: number; users: PresenceUser[]; source: string }
  | { type: 'statusUpdate'; user: FriendUser; source: string }
  | { type: 'markOffline'; userId: number; source: string };

interface PresenceRecord {
  id: number;
  displayName: string;
  avatarUrl: string | null;
  status: PresenceStatus;
  online: boolean;
  lastSeen: number;
}

interface PresenceState {
  records: Record<number, PresenceRecord>;
  channelMembers: Record<number, number[]>;
  setChannelSnapshot: (channelId: number, users: PresenceUser[], broadcast?: boolean) => void;
  clearChannel: (channelId: number) => void;
  updateFriendStatus: (user: FriendUser, broadcast?: boolean) => void;
  markOffline: (userId: number, broadcast?: boolean) => void;
  getUser: (userId: number) => PresenceRecord | undefined;
  getChannelPresence: (channelId: number) => PresenceRecord[];
}

const CLIENT_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const broadcastChannel =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel('charge-presence')
    : null;

function normalizeRecord(
  payload: Pick<FriendUser, 'id' | 'login' | 'display_name' | 'avatar_url' | 'status'>,
  overrides?: Partial<PresenceRecord>,
): PresenceRecord {
  return {
    id: payload.id,
    displayName: payload.display_name ?? payload.login,
    avatarUrl: payload.avatar_url ?? null,
    status: payload.status,
    online: overrides?.online ?? true,
    lastSeen: overrides?.lastSeen ?? Date.now(),
  };
}

function normalizePresenceUser(user: PresenceUser): PresenceRecord {
  return {
    id: user.id,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    status: user.status,
    online: true,
    lastSeen: Date.now(),
  };
}

function postMessage(message: Omit<PresenceBroadcastMessage, 'source'>): void {
  if (!broadcastChannel) {
    return;
  }
  broadcastChannel.postMessage({ ...message, source: CLIENT_ID });
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  records: {},
  channelMembers: {},
  setChannelSnapshot(channelId, users, shouldBroadcast = true) {
    set((state) => {
      const records = { ...state.records } as Record<number, PresenceRecord>;
      const previous = new Set(state.channelMembers[channelId] ?? []);
      const nextMembers: number[] = [];
      const now = Date.now();

      for (const user of users) {
        nextMembers.push(user.id);
        previous.delete(user.id);
        records[user.id] = normalizePresenceUser(user);
        records[user.id].lastSeen = now;
      }

      for (const userId of previous) {
        const existing = records[userId];
        if (!existing) {
          continue;
        }
        records[userId] = {
          ...existing,
          online: false,
          lastSeen: now,
        };
      }

      return {
        records,
        channelMembers: { ...state.channelMembers, [channelId]: nextMembers },
      };
    });

    if (shouldBroadcast) {
      postMessage({ type: 'channelSnapshot', channelId, users });
    }
  },
  clearChannel(channelId) {
    set((state) => {
      if (!(channelId in state.channelMembers)) {
        return state;
      }
      const members = state.channelMembers[channelId] ?? [];
      const records = { ...state.records };
      const now = Date.now();
      for (const userId of members) {
        const record = records[userId];
        if (!record) {
          continue;
        }
        records[userId] = { ...record, online: false, lastSeen: now };
      }
      const channelMembers = { ...state.channelMembers };
      delete channelMembers[channelId];
      return { records, channelMembers };
    });
  },
  updateFriendStatus(user, shouldBroadcast = true) {
    set((state) => {
      const record = state.records[user.id];
      return {
        records: {
          ...state.records,
          [user.id]: normalizeRecord(user, { online: true, lastSeen: Date.now(), ...record }),
        },
      };
    });

    if (shouldBroadcast) {
      postMessage({ type: 'statusUpdate', user });
    }
  },
  markOffline(userId, shouldBroadcast = true) {
    set((state) => {
      const record = state.records[userId];
      if (!record) {
        return state;
      }
      return {
        records: {
          ...state.records,
          [userId]: { ...record, online: false, lastSeen: Date.now() },
        },
      };
    });

    if (shouldBroadcast) {
      postMessage({ type: 'markOffline', userId });
    }
  },
  getUser(userId) {
    return get().records[userId];
  },
  getChannelPresence(channelId) {
    const memberIds = get().channelMembers[channelId] ?? [];
    return memberIds
      .map((userId) => get().records[userId])
      .filter((record): record is PresenceRecord => Boolean(record));
  },
}));

if (broadcastChannel) {
  broadcastChannel.addEventListener('message', (event) => {
    const data = event.data as PresenceBroadcastMessage | undefined;
    if (!data || typeof data !== 'object' || data.source === CLIENT_ID) {
      return;
    }
    switch (data.type) {
      case 'channelSnapshot':
        usePresenceStore.getState().setChannelSnapshot(data.channelId, data.users, false);
        break;
      case 'statusUpdate':
        usePresenceStore.getState().updateFriendStatus(data.user, false);
        break;
      case 'markOffline':
        usePresenceStore.getState().markOffline(data.userId, false);
        break;
      default:
        break;
    }
  });
}

export function getPresenceRecord(userId: number): PresenceRecord | undefined {
  return usePresenceStore.getState().getUser(userId);
}

export function getChannelPresence(channelId: number): PresenceRecord[] {
  return usePresenceStore.getState().getChannelPresence(channelId);
}
