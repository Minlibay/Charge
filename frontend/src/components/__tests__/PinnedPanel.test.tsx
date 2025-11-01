import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PinnedPanel } from '../messages/PinnedPanel';
import type { Message, MessageAuthor, PinnedMessage } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template =
        (options && typeof options.defaultValue === 'string' && options.defaultValue) || key;
      if (!options) {
        return template;
      }
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

function buildAuthor(): MessageAuthor {
  return {
    id: 5,
    login: 'alex',
    display_name: 'Alex',
    avatar_url: null,
    status: 'online',
  };
}

function buildMessage(overrides: Partial<Message> = {}): Message {
  const timestamp = '2024-01-01T12:00:00Z';
  return {
    id: 101,
    channel_id: 7,
    author_id: 5,
    author: buildAuthor(),
    content: 'Закреплённое сообщение',
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

function buildPinnedMessage(overrides: Partial<PinnedMessage> = {}): PinnedMessage {
  const baseMessage = overrides.message ?? buildMessage(overrides.message as Partial<Message>);
  return {
    id: overrides.id ?? 1,
    channel_id: overrides.channel_id ?? baseMessage.channel_id,
    message_id: overrides.message_id ?? baseMessage.id,
    message: baseMessage,
    pinned_at: overrides.pinned_at ?? '2024-01-01T12:00:00Z',
    pinned_by: overrides.pinned_by ?? baseMessage.author,
    note: overrides.note ?? null,
  };
}

describe('PinnedPanel', () => {

  it('toggles expansion to reveal pinned messages', async () => {
    const pins = [
      buildPinnedMessage({ id: 1, message: buildMessage({ id: 201, content: 'Первая заметка' }) }),
      buildPinnedMessage({ id: 2, message: buildMessage({ id: 202, content: 'Вторая заметка' }) }),
    ];

    render(<PinnedPanel pins={pins} />);

    expect(screen.getByText('Закрепы (2)')).toBeInTheDocument();
    expect(screen.queryByText('Первая заметка')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Закрепы (2)' });
    await userEvent.click(toggle);

    expect(screen.getByText('Первая заметка')).toBeInTheDocument();
    expect(screen.getByText('Вторая заметка')).toBeInTheDocument();
  });

  it('invokes callbacks for refresh, select, and unpin', async () => {
    const pin = buildPinnedMessage({ id: 3, message: buildMessage({ id: 303, content: 'Нужно увидеть' }) });
    const onRefresh = vi.fn();
    const onSelect = vi.fn();
    const onUnpin = vi.fn();

    render(
      <PinnedPanel pins={[pin]} onRefresh={onRefresh} onSelect={onSelect} onUnpin={onUnpin} loading={false} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Закрепы (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Нужно увидеть/ }));
    expect(onSelect).toHaveBeenCalledWith(pin.message_id);

    await userEvent.click(screen.getByRole('button', { name: 'Открепить' }));
    expect(onUnpin).toHaveBeenCalledWith(pin.message_id);
  });
});
