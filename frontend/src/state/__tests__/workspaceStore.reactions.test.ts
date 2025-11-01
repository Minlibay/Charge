import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../types';
import { useWorkspaceStore } from '../workspaceStore';
import * as sessionModule from '../../services/session';

function createMessage(overrides: Partial<Message> = {}): Message {
  const timestamp = '2024-01-01T12:00:00Z';
  return {
    id: 1,
    channel_id: 7,
    author_id: 2,
    author: null,
    content: 'Hello world',
    created_at: timestamp,
    updated_at: timestamp,
    edited_at: null,
    deleted_at: null,
    moderated_at: null,
    moderation_note: null,
    moderated_by: null,
    parent_id: null,
    thread_root_id: null,
    reply_count: 0,
    thread_reply_count: 0,
    attachments: [],
    reactions: [],
    delivered_count: 0,
    read_count: 0,
    delivered_at: null,
    read_at: null,
    pinned_at: null,
    pinned_by: null,
    ...overrides,
  };
}

describe('workspaceStore reactions', () => {
  beforeEach(() => {
    vi.spyOn(sessionModule, 'getCurrentUserId').mockReturnValue(42);
    useWorkspaceStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useWorkspaceStore.getState().reset();
  });

  it('tracks self reactions from history and removes them when cleared', () => {
    const withReaction = createMessage({
      reactions: [
        {
          emoji: '🔥',
          count: 1,
          reacted: true,
          user_ids: [42],
        },
      ],
    });

    const store = useWorkspaceStore.getState();
    store.ingestHistory(7, {
      items: [withReaction],
      next_cursor: null,
      prev_cursor: null,
      has_more_backward: false,
      has_more_forward: false,
    });

    expect(useWorkspaceStore.getState().selfReactionsByMessage[withReaction.id]).toEqual(['🔥']);

    const withoutReaction = createMessage({ id: withReaction.id, reactions: [] });
    store.ingestMessage(7, withoutReaction);

    expect(useWorkspaceStore.getState().selfReactionsByMessage[withReaction.id]).toBeUndefined();
  });
});
