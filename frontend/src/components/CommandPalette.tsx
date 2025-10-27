import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Channel, RoomMemberSummary, RoomSummary } from '../types';

interface PaletteChannel extends Channel {
  roomSlug: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  rooms: RoomSummary[];
  channels: PaletteChannel[];
  users: RoomMemberSummary[];
  activeRoomSlug: string | null;
  onSelectRoom: (slug: string) => void | Promise<void>;
  onSelectChannel: (channelId: number) => void | Promise<void>;
  onFocusUser: (userId: number) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  type: 'room' | 'channel' | 'user';
  action: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onClose,
  rooms,
  channels,
  users,
  activeRoomSlug,
  onSelectRoom,
  onSelectChannel,
  onFocusUser,
}: CommandPaletteProps): JSX.Element | null {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  const roomTitleBySlug = useMemo(() => {
    const map = new Map<string, string>();
    rooms.forEach((room) => {
      map.set(room.slug, room.title);
    });
    return map;
  }, [rooms]);

  const items = useMemo<PaletteItem[]>(() => {
    const roomItems = rooms.map<PaletteItem>((room) => ({
      id: `room-${room.id}`,
      label: room.title,
      description: t('commandPalette.server', { defaultValue: 'Сервер' }),
      meta: room.slug,
      type: 'room',
      action: () => onSelectRoom(room.slug),
    }));

    const channelItems = channels.map<PaletteItem>((channel) => ({
      id: `channel-${channel.id}`,
      label: channel.name,
      description:
        channel.type === 'voice'
          ? t('commandPalette.voiceChannel', { defaultValue: 'Голосовой канал' })
          : t('commandPalette.textChannel', { defaultValue: 'Текстовый канал' }),
      meta: roomTitleBySlug.get(channel.roomSlug) ?? channel.roomSlug,
      type: 'channel',
      action: () => onSelectChannel(channel.id),
    }));

    const userItems = users.map<PaletteItem>((user) => ({
      id: `user-${user.user_id}`,
      label: user.display_name || user.login,
      description: t('commandPalette.user', { defaultValue: 'Участник' }),
      meta: roomTitleBySlug.get(activeRoomSlug ?? '') ?? undefined,
      type: 'user',
      action: () => onFocusUser(user.user_id),
    }));

    return [...roomItems, ...channelItems, ...userItems];
  }, [activeRoomSlug, channels, onFocusUser, onSelectChannel, onSelectRoom, roomTitleBySlug, rooms, t, users]);

  const normalizedQuery = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!normalizedQuery) {
      return items;
    }
    return items.filter((item) => {
      const haystack = `${item.label} ${item.meta ?? ''} ${item.description ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [items, normalizedQuery]);

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery]);

  useEffect(() => {
    if (!listRef.current) {
      return;
    }
    const active = listRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filtered.length]);

  if (!open) {
    return null;
  }

  const handleKeyDown = async (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) {
        return;
      }
      setActiveIndex((current) => Math.min(filtered.length - 1, Math.max(0, current + 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) {
        return;
      }
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = filtered[activeIndex];
      if (item) {
        await item.action();
        onClose();
      }
    }
  };

  const handleSelect = async (index: number) => {
    const item = filtered[index];
    if (!item) {
      return;
    }
    await item.action();
    onClose();
  };

  const content = (
    <div className="command-overlay" role="presentation" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        className="command-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="command-dialog__header">
          <h2 id="command-palette-title">{t('commandPalette.title')}</h2>
          <span className="command-dialog__hint">{t('commandPalette.hint')}</span>
        </header>
        <div className="command-dialog__input-wrapper">
          <span aria-hidden="true">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('commandPalette.placeholder')}
            aria-label={t('commandPalette.placeholder')}
          />
        </div>
        <ul ref={listRef} className="command-dialog__list" role="listbox" aria-live="polite">
          {filtered.length === 0 ? (
            <li className="command-dialog__empty">{t('commandPalette.empty')}</li>
          ) : (
            filtered.map((item, index) => (
              <li
                key={item.id}
                role="option"
                data-index={index}
                aria-selected={index === activeIndex}
                className={clsx('command-dialog__item', {
                  'command-dialog__item--active': index === activeIndex,
                })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void handleSelect(index)}
              >
                <div className="command-dialog__item-label">{item.label}</div>
                <div className="command-dialog__item-meta">
                  {item.description ? <span>{item.description}</span> : null}
                  {item.meta ? <span className="command-dialog__item-tag">{item.meta}</span> : null}
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
