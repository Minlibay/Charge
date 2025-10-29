import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { MessageList } from '../MessageList';
import type { Message, RoomMemberSummary } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) {
        return key;
      }

      const template =
        (typeof options.defaultValue === 'string' && options.defaultValue) || key;

      return Object.entries(options).reduce((result, [name, value]) => {
        if (name === 'defaultValue') {
          return result;
        }
        return result.replaceAll(`{{${name}}}`, String(value));
      }, template);
    },
    i18n: { language: 'ru' },
  }),
}));

function buildMessage(overrides: Partial<Message> = {}): Message {
  const timestamp = new Date().toISOString();
  return {
    id: 1,
    channel_id: 7,
    author_id: 5,
    author: {
      id: 5,
      login: 'author',
      display_name: 'Author',
      avatar_url: null,
      status: 'online',
    },
    content: 'Привет!',
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
    ...overrides,
  };
}

const baseMembers: RoomMemberSummary[] = [];

describe('MessageList reactions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('opens picker and adds reaction with feedback', async () => {
    const message = buildMessage();
    const onAddReaction = vi.fn().mockResolvedValue(undefined);
    const onRemoveReaction = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <MessageList
        messages={[message]}
        members={baseMembers}
        currentUserId={1}
        currentRole="member"
        onReply={() => undefined}
        onOpenThread={() => undefined}
        onEditMessage={async () => undefined}
        onDeleteMessage={async () => undefined}
        onModerateMessage={async () => undefined}
        onAddReaction={onAddReaction}
        onRemoveReaction={onRemoveReaction}
        selfReactions={{}}
        context="channel"
        replyingToId={null}
        activeThreadRootId={null}
      />,
    );

    await act(async () => {
      await user.click(screen.getByLabelText('Добавить реакцию'));
    });

    const fireButton = screen.getByLabelText('Добавить реакцию 🔥');

    await act(async () => {
      await user.click(fireButton);
    });

    expect(onAddReaction).toHaveBeenCalledWith(message, '🔥');
    expect(screen.getByText(/Реакция добавлена/)).toBeInTheDocument();

    await act(async () => {
      vi.runAllTimers();
    });
  });

  it('removes existing reaction and highlights state', async () => {
    const message = buildMessage({
      reactions: [
        {
          emoji: '🔥',
          count: 2,
          reacted: true,
          user_ids: [1, 7],
        },
      ],
    });
    const onAddReaction = vi.fn().mockResolvedValue(undefined);
    const onRemoveReaction = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <MessageList
        messages={[message]}
        members={baseMembers}
        currentUserId={1}
        currentRole="member"
        onReply={() => undefined}
        onOpenThread={() => undefined}
        onEditMessage={async () => undefined}
        onDeleteMessage={async () => undefined}
        onModerateMessage={async () => undefined}
        onAddReaction={onAddReaction}
        onRemoveReaction={onRemoveReaction}
        selfReactions={{ [message.id]: ['🔥'] }}
        context="channel"
        replyingToId={null}
        activeThreadRootId={null}
      />,
    );

    const toggleButton = screen.getByLabelText('Переключить реакцию 🔥');
    expect(toggleButton.parentElement).toHaveClass('message__reaction--reacted');

    await act(async () => {
      await user.click(toggleButton);
    });

    expect(onRemoveReaction).toHaveBeenCalledWith(message, '🔥');
    expect(screen.getByText(/Реакция снята/)).toBeInTheDocument();

    await act(async () => {
      vi.runAllTimers();
    });
  });
});
