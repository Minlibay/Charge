import { create } from 'zustand';

import {
  acceptFriendRequest as apiAcceptFriendRequest,
  createDirectConversation as apiCreateDirectConversation,
  fetchConversations as apiFetchConversations,
  fetchConversationMessages as apiFetchConversationMessages,
  fetchFriendRequests as apiFetchFriendRequests,
  fetchFriendsList,
  fetchProfile as apiFetchProfile,
  rejectFriendRequest as apiRejectFriendRequest,
  sendDirectMessage as apiSendDirectMessage,
  sendFriendRequest as apiSendFriendRequest,
  updateDirectConversationNote as apiUpdateDirectConversationNote,
  updateProfileSettings,
  uploadAvatar as apiUploadAvatar,
} from '../services/api';
import type {
  DirectConversation,
  DirectConversationCreatePayload,
  DirectEvent,
  DirectMessage,
  FriendRequest,
  FriendUser,
  ProfileUpdatePayload,
  UserProfile,
} from '../types';
import { usePresenceStore } from './presenceStore';

interface DirectState {
  profile: UserProfile | null;
  friends: FriendUser[];
  incomingRequests: FriendRequest[];
  outgoingRequests: FriendRequest[];
  conversations: DirectConversation[];
  messagesByConversation: Record<number, DirectMessage[]>;
  loading: boolean;
  error?: string;
  initialize: () => Promise<void>;
  refreshProfile: () => Promise<UserProfile>;
  refreshFriends: () => Promise<void>;
  refreshRequests: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  createConversation: (payload: DirectConversationCreatePayload) => Promise<DirectConversation>;
  fetchMessages: (conversationId: number) => Promise<DirectMessage[]>;
  sendMessage: (conversationId: number, content: string) => Promise<DirectMessage>;
  updateNote: (conversationId: number, note: string | null) => Promise<void>;
  sendFriendRequest: (login: string) => Promise<void>;
  acceptRequest: (requestId: number) => Promise<void>;
  rejectRequest: (requestId: number) => Promise<void>;
  updateProfile: (payload: ProfileUpdatePayload) => Promise<UserProfile>;
  uploadAvatar: (file: File) => Promise<UserProfile>;
  ingestStatusSnapshot: (users: FriendUser[]) => void;
  ingestStatusUpdate: (user: FriendUser) => void;
  ingestDirectEvent: (event: DirectEvent) => void;
  clear: () => void;
}

const initialState: Pick<
  DirectState,
  | 'profile'
  | 'friends'
  | 'incomingRequests'
  | 'outgoingRequests'
  | 'conversations'
  | 'messagesByConversation'
  | 'loading'
  | 'error'
> = {
  profile: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  conversations: [],
  messagesByConversation: {},
  loading: false,
  error: undefined,
};

function normalizeFriend(user: FriendUser): FriendUser {
  return {
    id: user.id,
    login: user.login,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    status: user.status,
  };
}

function mapFriends(friends: FriendUser[], updates: Map<number, Partial<FriendUser>>): FriendUser[] {
  return friends.map((friend) => {
    const update = updates.get(friend.id);
    return update ? { ...friend, ...update } : friend;
  });
}

function mapConversationParticipants(
  conversation: DirectConversation,
  updates: Map<number, Partial<FriendUser>>,
): DirectConversation {
  return {
    ...conversation,
    participants: conversation.participants.map((participant) => {
      const update = updates.get(participant.user.id);
      return update
        ? { ...participant, user: { ...participant.user, ...update } }
        : participant;
    }),
  };
}

function ensureFriendEntries(
  existing: FriendUser[],
  conversations: DirectConversation[],
  profileId: number | undefined,
): FriendUser[] {
  const knownIds = new Set(existing.map((friend) => friend.id));
  const result = [...existing];
  conversations.forEach((conversation) => {
    conversation.participants.forEach((participant) => {
      if (participant.user.id === profileId) {
        return;
      }
      if (!knownIds.has(participant.user.id)) {
        result.push(normalizeFriend(participant.user));
        knownIds.add(participant.user.id);
      }
    });
  });
  return result;
}

export const useDirectStore = create<DirectState>((set, get) => ({
  ...initialState,
  async initialize() {
    set({ loading: true, error: undefined });
    try {
      const [profile, friends, requests, conversations] = await Promise.all([
        apiFetchProfile(),
        fetchFriendsList(),
        apiFetchFriendRequests(),
        apiFetchConversations(),
      ]);
      const normalizedFriends = friends.map(normalizeFriend);
      set({
        profile,
        friends: ensureFriendEntries(normalizedFriends, conversations, profile.id),
        incomingRequests: requests.incoming,
        outgoingRequests: requests.outgoing,
        conversations,
        messagesByConversation: {},
        loading: false,
        error: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить данные';
      set({ error: message, loading: false });
    }
  },
  async refreshProfile() {
    const profile = await apiFetchProfile();
    set({ profile });
    return profile;
  },
  async refreshFriends() {
    const friends = await fetchFriendsList();
    set({ friends: friends.map(normalizeFriend) });
  },
  async refreshRequests() {
    const requests = await apiFetchFriendRequests();
    set({ incomingRequests: requests.incoming, outgoingRequests: requests.outgoing });
  },
  async refreshConversations() {
    const conversations = await apiFetchConversations();
    set((state) => ({
      conversations,
      friends: ensureFriendEntries(state.friends, conversations, state.profile?.id),
    }));
  },
  async createConversation(payload: DirectConversationCreatePayload) {
    const conversation = await apiCreateDirectConversation(payload);
    set((state) => ({
      conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
      friends: ensureFriendEntries(state.friends, [conversation], state.profile?.id),
    }));
    return conversation;
  },
  async fetchMessages(conversationId: number) {
    const messages = await apiFetchConversationMessages(conversationId);
    set((state) => ({
      messagesByConversation: { ...state.messagesByConversation, [conversationId]: messages },
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unread_count: 0 } : conversation,
      ),
    }));
    return messages;
  },
  async sendMessage(conversationId: number, content: string) {
    const message = await apiSendDirectMessage(conversationId, content);
    set((state) => {
      const existing = state.messagesByConversation[conversationId] ?? [];
      const profileId = state.profile?.id;
      const conversations = state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              last_message: message,
              unread_count:
                message.sender_id === profileId ? conversation.unread_count : conversation.unread_count,
            }
          : conversation,
      );
      return {
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: [...existing, message],
        },
        conversations,
      };
    });
    return message;
  },
  async updateNote(conversationId: number, note: string | null) {
    const participant = await apiUpdateDirectConversationNote(conversationId, note);
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              participants: conversation.participants.map((item) =>
                item.user.id === participant.user.id ? { ...item, note: participant.note } : item,
              ),
            }
          : conversation,
      ),
    }));
  },
  async sendFriendRequest(login: string) {
    const request = await apiSendFriendRequest(login);
    set((state) => ({ outgoingRequests: [...state.outgoingRequests, request] }));
  },
  async acceptRequest(requestId: number) {
    const request = await apiAcceptFriendRequest(requestId);
    set((state) => {
      const incoming = state.incomingRequests.filter((item) => item.id !== requestId);
      const friend = normalizeFriend(
        request.requester.id === state.profile?.id ? request.addressee : request.requester,
      );
      const friends = state.friends.some((item) => item.id === friend.id)
        ? mapFriends(state.friends, new Map([[friend.id, friend]]))
        : [...state.friends, friend];
      return { incomingRequests: incoming, friends };
    });
    await get().refreshConversations();
  },
  async rejectRequest(requestId: number) {
    await apiRejectFriendRequest(requestId);
    set((state) => ({
      incomingRequests: state.incomingRequests.filter((item) => item.id !== requestId),
      outgoingRequests: state.outgoingRequests.filter((item) => item.id !== requestId),
    }));
  },
  async updateProfile(payload: ProfileUpdatePayload) {
    const profile = await updateProfileSettings(payload);
    set({ profile });
    return profile;
  },
  async uploadAvatar(file: File) {
    const profile = await apiUploadAvatar(file);
    set({ profile });
    return profile;
  },
  ingestStatusSnapshot(users: FriendUser[]) {
    const presence = usePresenceStore.getState();
    const seen = new Set<number>();
    users.forEach((user) => {
      presence.updateFriendStatus(user);
      seen.add(user.id);
    });
    const records = usePresenceStore.getState().records;
    for (const [id, record] of Object.entries(records)) {
      const numericId = Number(id);
      if (!seen.has(numericId) && record.online) {
        usePresenceStore.getState().markOffline(numericId);
      }
    }

    set((state) => {
      const updates = new Map<number, Partial<FriendUser>>();
      users.forEach((user) => updates.set(user.id, user));
      const friends = mapFriends(
        ensureFriendEntries(state.friends, state.conversations, state.profile?.id),
        updates,
      );
      const conversations = state.conversations.map((conversation) =>
        mapConversationParticipants(conversation, updates),
      );
      let profile = state.profile;
      if (profile) {
        const update = updates.get(profile.id);
        if (update) {
          profile = { ...profile, ...update };
        }
      }
      return { friends, conversations, profile };
    });
  },
  ingestStatusUpdate(user: FriendUser) {
    get().ingestStatusSnapshot([user]);
  },
  ingestDirectEvent(event: DirectEvent) {
    switch (event.type) {
      case 'direct_snapshot':
        set((state) => ({
          conversations: event.conversations,
          friends: ensureFriendEntries(state.friends, event.conversations, state.profile?.id),
        }));
        break;
      case 'message': {
        let conversationExists = false;
        set((state) => {
          const { profile } = state;
          const existing = state.messagesByConversation[event.conversation_id] ?? [];
          const existed = state.conversations.some((conversation) => conversation.id === event.conversation_id);
          const conversations = existed
            ? state.conversations.map((conversation) =>
                conversation.id === event.conversation_id
                  ? {
                      ...conversation,
                      last_message: event.message,
                      unread_count:
                        event.message.sender_id === profile?.id
                          ? conversation.unread_count
                          : conversation.unread_count + 1,
                    }
                  : conversation,
              )
            : [
                {
                  id: event.conversation_id,
                  title: null,
                  is_group: false,
                  participants: [],
                  last_message: event.message,
                  unread_count: event.message.sender_id === profile?.id ? 0 : 1,
                },
                ...state.conversations,
              ];
          conversationExists = existed;
          return {
            conversations,
            messagesByConversation: {
              ...state.messagesByConversation,
              [event.conversation_id]: [...existing, event.message],
            },
          };
        });
        if (!conversationExists) {
          void get().refreshConversations();
        }
        break;
      }
      case 'conversation_refresh':
        void get().refreshConversations();
        break;
      case 'note_updated':
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === event.conversation_id
              ? {
                  ...conversation,
                  participants: conversation.participants.map((participant) =>
                    participant.user.id === event.user_id
                      ? { ...participant, note: event.note }
                      : participant,
                  ),
                }
              : conversation,
          ),
        }));
        break;
      default:
        break;
    }
  },
  clear() {
    set({ ...initialState });
  },
}));

export type { DirectState };
