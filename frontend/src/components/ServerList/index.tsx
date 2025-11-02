import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import type { ChannelType, RoomSummary } from '../../types';
import { CreateChannelDialog } from '../dialogs/CreateChannelDialog';
import { CreateCategoryDialog } from '../dialogs/CreateCategoryDialog';
import { CreateServerDialog } from './CreateServerDialog';
import { ServerTooltip } from './ServerTooltip';

interface ServerListProps {
  rooms: RoomSummary[];
  selectedRoomSlug: string | null;
  onSelect: (slug: string) => void;
}

export function ServerList({ rooms, selectedRoomSlug, onSelect }: ServerListProps): JSX.Element {
  const { t } = useTranslation();
  const createRoom = useWorkspaceStore((state) => state.createRoom);
  const createChannel = useWorkspaceStore((state) => state.createChannel);
  const createCategory = useWorkspaceStore((state) => state.createCategory);
  const categoriesByRoom = useWorkspaceStore((state) => state.categoriesByRoom);
  const roomDetails = useWorkspaceStore((state) => state.roomDetails);
  const unreadCountByChannel = useWorkspaceStore((state) => state.unreadCountByChannel);
  const mentionCountByChannel = useWorkspaceStore((state) => state.mentionCountByChannel);
  const channelRoomById = useWorkspaceStore((state) => state.channelRoomById);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [menuOpenSlug, setMenuOpenSlug] = useState<string | null>(null);
  const [channelDialog, setChannelDialog] = useState<
    { slug: string; type: ChannelType; categoryId: number | null } | null
  >(null);
  const [categoryDialogSlug, setCategoryDialogSlug] = useState<string | null>(null);
  const menuRooms = useMemo(() => new Map(rooms.map((room) => [room.slug, room])), [rooms]);
  const roomBadgeSummary = useMemo(() => {
    const summary = new Map<string, { unread: number; mentions: number }>();
    for (const [idString, slug] of Object.entries(channelRoomById)) {
      const channelId = Number(idString);
      if (!Number.isFinite(channelId)) {
        continue;
      }
      const unread = unreadCountByChannel[channelId] ?? 0;
      const mentions = mentionCountByChannel[channelId] ?? 0;
      if (unread === 0 && mentions === 0) {
        continue;
      }
      const entry = summary.get(slug) ?? { unread: 0, mentions: 0 };
      entry.unread += unread;
      entry.mentions += mentions;
      summary.set(slug, entry);
    }
    return summary;
  }, [channelRoomById, mentionCountByChannel, unreadCountByChannel]);

  const formatBadgeCount = (value: number): string => {
    if (value > 99) {
      return '99+';
    }
    return String(value);
  };

  useEffect(() => {
    if (!menuOpenSlug) {
      return;
    }
    const handleClick = () => setMenuOpenSlug(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuOpenSlug]);

  const handleCreateChannel = async (slug: string, type: ChannelType) => {
    setChannelDialog({ slug, type, categoryId: null });
    setMenuOpenSlug(null);
  };

  const handleCreateCategory = (slug: string) => {
    setCategoryDialogSlug(slug);
    setMenuOpenSlug(null);
  };

  const handleSubmitChannel = async (name: string, type: ChannelType) => {
    if (!channelDialog) {
      return;
    }
    await createChannel(channelDialog.slug, {
      name,
      type,
      category_id: channelDialog.categoryId,
    });
    onSelect(channelDialog.slug);
    setChannelDialog(null);
  };

  const handleSubmitCategory = async (name: string, position?: number) => {
    if (!categoryDialogSlug) {
      return;
    }
    await createCategory(categoryDialogSlug, name, position);
    onSelect(categoryDialogSlug);
    setCategoryDialogSlug(null);
  };

  const currentCategoryPosition = categoryDialogSlug
    ? (categoriesByRoom[categoryDialogSlug]?.length ?? 0)
    : 0;

  const channelCreationOptions: Array<{ type: ChannelType; label: string }> = useMemo(
    () => [
      { type: 'text', label: t('channels.createText') },
      { type: 'voice', label: t('channels.createVoice') },
      { type: 'stage', label: t('channels.createStage') },
      { type: 'announcements', label: t('channels.createAnnouncements') },
      { type: 'forums', label: t('channels.createForums') },
      { type: 'events', label: t('channels.createEvents') },
    ],
    [t],
  );

  return (
    <>
      <h2 className="sr-only">{t('servers.title')}</h2>
      <ul className="server-list" aria-label={t('servers.title')}>
        {rooms.length === 0 ? (
          <li className="server-list__item">
            <p className="server-list__empty" role="status">
              {t('servers.empty')}
            </p>
          </li>
        ) : (
          rooms.map((room) => {
            const isActive = room.slug === selectedRoomSlug;
            const isMenuOpen = menuOpenSlug === room.slug;
            const role = roomDetails[room.slug]?.current_role;
            const canManage = role === 'owner' || role === 'admin';
            const badge = roomBadgeSummary.get(room.slug);
            const mentionCount = badge?.mentions ?? 0;
            const unreadCount = badge?.unread ?? 0;
            const hasBadge = mentionCount > 0 || unreadCount > 0;
            const badgeValue = mentionCount > 0 ? mentionCount : unreadCount;
            const initials =
              room.title
                .split(/\s+/)
                .map((chunk) => chunk.charAt(0).toUpperCase())
                .slice(0, 2)
                .join('') || '#';
            return (
              <li key={room.id} className="server-list__item">
                <ServerTooltip label={room.title}>
                  <button
                    type="button"
                    className={clsx('server-pill', {
                      'server-pill--active': isActive,
                      'server-pill--unread': unreadCount > 0,
                      'server-pill--mention': mentionCount > 0,
                    })}
                    onClick={() => onSelect(room.slug)}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={room.title}
                  >
                    <span className="server-pill__initials" aria-hidden="true">
                      {initials}
                    </span>
                    {hasBadge ? (
                      <span className="server-pill__badge" aria-hidden="true">
                        <span
                          className={clsx('server-pill__badge-value', {
                            'server-pill__badge-value--mention': mentionCount > 0,
                          })}
                        >
                          {formatBadgeCount(badgeValue)}
                        </span>
                      </span>
                    ) : null}
                  </button>
                </ServerTooltip>
                {canManage && (
                  <>
                    <button
                      type="button"
                      className="server-menu-button"
                      aria-label={t('servers.manageServer', { title: room.title })}
                      aria-haspopup="menu"
                      aria-expanded={isMenuOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpenSlug((prev) => (prev === room.slug ? null : room.slug));
                      }}
                    >
                      ⋯
                    </button>
                    {isMenuOpen && (
                      <div className="context-menu" role="menu">
                        {channelCreationOptions.map((option) => (
                          <button
                            key={option.type}
                            type="button"
                            role="menuitem"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCreateChannel(room.slug, option.type);
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCreateCategory(room.slug);
                          }}
                        >
                          {t('channels.createCategory')}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })
        )}
        <li className="server-list__item">
          <ServerTooltip label={t('servers.create')}>
            <button
              type="button"
              className="server-pill server-pill--create"
              onClick={() => setCreateServerOpen(true)}
              aria-label={t('servers.create')}
            >
              <span className="server-pill__initials" aria-hidden="true">
                +
              </span>
            </button>
          </ServerTooltip>
        </li>
      </ul>
      <CreateServerDialog
        open={createServerOpen}
        onClose={() => setCreateServerOpen(false)}
        onCreate={(title) => createRoom(title)}
      />
      <CreateChannelDialog
        open={Boolean(channelDialog)}
        defaultType={channelDialog?.type}
        onClose={() => setChannelDialog(null)}
        onCreate={(name, type) => handleSubmitChannel(name, type)}
      />
      <CreateCategoryDialog
        open={categoryDialogSlug !== null}
        defaultPosition={currentCategoryPosition}
        onClose={() => setCategoryDialogSlug(null)}
        onCreate={(name, position) => handleSubmitCategory(name, position)}
        roomTitle={categoryDialogSlug ? menuRooms.get(categoryDialogSlug)?.title ?? '' : ''}
      />
    </>
  );
}
