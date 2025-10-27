import { create } from 'zustand';

import {
  ApiError,
  acceptFriendRequest as apiAcceptFriendRequest,
  fetchConversations as apiFetchConversations,
  fetchDirectMessages as apiFetchDirectMessages,
  fetchFriendRequests as apiFetchFriendRequests,
  fetchFriendsList,
  fetchProfile as apiFetchProfile,
  rejectFriendRequest as apiRejectFriendRequest,
  sendDirectMessage as apiSendDirectMessage,
  sendFriendRequest as apiSendFriendRequest,
  updateProfileSettings,
  uploadAvatar as apiUploadAvatar,
} from '../services/api';
import type {
  DirectConversation,
  DirectMessage,
  FriendRequest,
  FriendUser,
  ProfileUpdatePayload,
  UserProfile,
} from '../types';

interface FriendsState {
  profile: UserProfile | null;
  friends: FriendUser[];
  incomingRequests: FriendRequest[];
  outgoingRequests: FriendRequest[];
  conversations: DirectConversation[];
  messagesByUser: Record<number, DirectMessage[]>;
  loading: boolean;
  error?: string;
  initialize: () => Promise<void>;
  refreshProfile: () => Promise<UserProfile>;
  refreshFriends: () => Promise<void>;
  refreshRequests: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  fetchMessages: (userId: number) => Promise<DirectMessage[]>;
  sendFriendRequest: (login: string) => Promise<void>;
  acceptRequest: (requestId: number) => Promise<void>;
  rejectRequest: (requestId: number) => Promise<void>;
  updateProfile: (payload: ProfileUpdatePayload) => Promise<UserProfile>;
  uploadAvatar: (file: File) => Promise<UserProfile>;
  sendMessage: (userId: number, content: string) => Promise<DirectMessage>;
  ingestStatusSnapshot: (users: FriendUser[]) => void;
  ingestStatusUpdate: (user: FriendUser) => void;
  ingestDirectMessage: (message: DirectMessage) => void;
  clear: () => void;
}

const initialState: Pick<
  FriendsState,
  | 'profile'
  | 'friends'
  | 'incomingRequests'
  | 'outgoingRequests'
  | 'conversations'
  | 'messagesByUser'
  | 'loading'
  | 'error'
> = {
  profile: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  conversations: [],
  messagesByUser: {},
  loading: false,
  error: undefined,
};

function mapFriends(friends: FriendUser[], updates: Map<number, Partial<FriendUser>>): FriendUser[] {
  return friends.map((friend) => {
    const update = updates.get(friend.id);
    return update ? { ...friend, ...update } : friend;
  });
}

function mapConversations(
  conversations: DirectConversation[],
  updates: Map<number, Partial<FriendUser>>,
): DirectConversation[] {
  return conversations.map((conversation) => {
    const update = updates.get(conversation.participant.id);
    if (!update) {
      return conversation;
    }
    return {
      ...conversation,
      participant: { ...conversation.participant, ...update },
    };
  });
}

function normalizeFriend(user: FriendUser): FriendUser {
  return {
    id: user.id,
    login: user.login,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    status: user.status,
  };
}

export const useFriendsStore = create<FriendsState>((set, get) => ({
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
      set({
        profile,
        friends,
        incomingRequests: requests.incoming,
        outgoingRequests: requests.outgoing,
        conversations,
        loading: false,
        error: undefined,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Не удалось загрузить профиль';
      set({ loading: false, error: message });
    }
  },
  async refreshProfile() {
    const profile = await apiFetchProfile();
    set({ profile });
    return profile;
  },
  async refreshFriends() {
    const friends = await fetchFriendsList();
    set({ friends });
  },
  async refreshRequests() {
    const requests = await apiFetchFriendRequests();
    set({ incomingRequests: requests.incoming, outgoingRequests: requests.outgoing });
  },
  async refreshConversations() {
    const conversations = await apiFetchConversations();
    set({ conversations });
  },
  async fetchMessages(userId: number) {
    const messages = await apiFetchDirectMessages(userId);
    set((state) => ({
      messagesByUser: { ...state.messagesByUser, [userId]: messages },
      conversations: state.conversations.map((conversation) =>
        conversation.participant.id === userId
          ? { ...conversation, unread_count: 0 }
          : conversation,
      ),
    }));
    return messages;
  },
  async sendFriendRequest(login: string) {
    const request = await apiSendFriendRequest(login);
    set((state) => ({ outgoingRequests: [...state.outgoingRequests, request] }));
  },
  async acceptRequest(requestId: number) {
    const request = await apiAcceptFriendRequest(requestId);
    set((state) => {
      const incoming = state.incomingRequests.filter((item) => item.id !== requestId);
      const friend = normalizeFriend(request.requester.id === state.profile?.id ? request.addressee : request.requester);
      return {
        incomingRequests: incoming,
        friends: state.friends.some((item) => item.id === friend.id)
          ? mapFriends(state.friends, new Map([[friend.id, friend]]))
          : [...state.friends, friend],
      };
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
  async sendMessage(userId: number, content: string) {
    const message = await apiSendDirectMessage(userId, content);
    set((state) => {
      const existing = state.messagesByUser[userId] ?? [];
      const messagesByUser = {
        ...state.messagesByUser,
        [userId]: [...existing, message],
      };
      const existingConversation = state.conversations.find(
        (conversation) => conversation.participant.id === userId,
      );
      const participant =
        state.friends.find((friend) => friend.id === userId) ||
        existingConversation?.participant ||
        null;
      let conversations = state.conversations.map((conversation) =>
        conversation.participant.id === userId
          ? {
              ...conversation,
              last_message: message,
              unread_count: conversation.unread_count,
            }
          : conversation,
      );
      if (!existingConversation && participant) {
        conversations = [
          ...conversations,
          {
            id: message.conversation_id,
            participant,
            last_message: message,
            unread_count: 0,
          },
        ];
      }
      return { messagesByUser, conversations };
    });
    return message;
  },
  ingestStatusSnapshot(users: FriendUser[]) {
    if (users.length === 0) {
      return;
    }
    set((state) => {
      const updates = new Map<number, Partial<FriendUser>>();
      users.forEach((user) => updates.set(user.id, user));
      const existingIds = new Set(state.friends.map((friend) => friend.id));
      const appendedFriends = state.friends.slice();
      users.forEach((user) => {
        if (user.id !== state.profile?.id && !existingIds.has(user.id)) {
          appendedFriends.push(user);
        }
      });
      const friends = mapFriends(appendedFriends, updates);
      const conversations = mapConversations(state.conversations, updates);
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
  ingestDirectMessage(message: DirectMessage) {
    set((state) => {
      const participantId =
        message.sender_id === state.profile?.id ? message.recipient_id : message.sender_id;
      const messages = state.messagesByUser[participantId] ?? [];
      const existingConversation = state.conversations.find(
        (conversation) => conversation.participant.id === participantId,
      );
      const participant =
        (message.sender_id === participantId ? message.sender : null) ||
        existingConversation?.participant ||
        state.friends.find((friend) => friend.id === participantId) ||
        null;
      const updatedMessages = {
        ...state.messagesByUser,
        [participantId]: [...messages, message],
      };
      let conversations = state.conversations.map((conversation) =>
        conversation.participant.id === participantId
          ? {
              ...conversation,
              last_message: message,
              unread_count:
                message.sender_id === participantId
                  ? conversation.unread_count + 1
                  : conversation.unread_count,
            }
          : conversation,
      );
      if (!existingConversation && participant) {
        conversations = [
          ...conversations,
          {
            id: message.conversation_id,
            participant,
            last_message: message,
            unread_count: message.sender_id === participantId ? 1 : 0,
          },
        ];
      }
      const friends =
        participant && !state.friends.some((friend) => friend.id === participant.id)
          ? [...state.friends, participant]
          : state.friends;
      return { messagesByUser: updatedMessages, conversations, friends };
    });
  },
  clear() {
    set({ ...initialState });
  },
}));
