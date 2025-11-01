import { act } from '@testing-library/react';

import { useDirectStore } from '../directStore';
import type { DirectConversation, DirectMessage, FriendUser } from '../../types';

describe('directStore', () => {
  beforeEach(() => {
    act(() => {
      useDirectStore.getState().clear();
    });
  });

  function seedConversation(conversation: DirectConversation): void {
    act(() => {
      useDirectStore.setState((state) => ({
        ...state,
        profile: {
          id: 1,
          login: 'alice',
          display_name: 'Alice',
          avatar_url: null,
          status: 'online',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversations: [conversation],
      }));
    });
  }

  test('ingest message event increases unread counter', () => {
    const bob: FriendUser = {
      id: 2,
      login: 'bob',
      display_name: 'Bob',
      avatar_url: null,
      status: 'online',
    };
    seedConversation({
      id: 42,
      title: null,
      is_group: false,
      participants: [
        {
          user: {
            id: 1,
            login: 'alice',
            display_name: 'Alice',
            avatar_url: null,
            status: 'online',
          },
          nickname: null,
          note: null,
          joined_at: new Date().toISOString(),
          last_read_at: null,
        },
        {
          user: bob,
          nickname: null,
          note: null,
          joined_at: new Date().toISOString(),
          last_read_at: null,
        },
      ],
      last_message: null,
      unread_count: 0,
    });

    const message: DirectMessage = {
      id: 99,
      conversation_id: 42,
      sender_id: 2,
      recipient_id: null,
      content: 'Hello',
      created_at: new Date().toISOString(),
      read_at: null,
      sender: bob,
    };

    act(() => {
      useDirectStore.getState().ingestDirectEvent({
        type: 'message',
        conversation_id: 42,
        message,
      });
    });

    const state = useDirectStore.getState();
    expect(state.conversations[0].unread_count).toBe(1);
    expect(state.messagesByConversation[42]).toHaveLength(1);
  });

  test('status snapshot updates friends and participants', () => {
    const friend: FriendUser = {
      id: 2,
      login: 'bob',
      display_name: 'Bob',
      avatar_url: null,
      status: 'online',
    };
    seedConversation({
      id: 11,
      title: null,
      is_group: false,
      participants: [
        {
          user: {
            id: 1,
            login: 'alice',
            display_name: 'Alice',
            avatar_url: null,
            status: 'online',
          },
          nickname: null,
          note: null,
          joined_at: new Date().toISOString(),
          last_read_at: null,
        },
        {
          user: friend,
          nickname: null,
          note: null,
          joined_at: new Date().toISOString(),
          last_read_at: null,
        },
      ],
      last_message: null,
      unread_count: 0,
    });

    act(() => {
      useDirectStore.getState().ingestStatusSnapshot([
        { ...friend, status: 'idle' },
      ]);
    });

    const state = useDirectStore.getState();
    expect(state.friends.find((entry) => entry.id === friend.id)?.status).toBe('idle');
    const participant = state.conversations[0].participants.find((entry) => entry.user.id === friend.id);
    expect(participant?.user.status).toBe('idle');
  });
});
