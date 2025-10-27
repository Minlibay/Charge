import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import type { ChannelType, RoomSummary } from '../../types';
import { CreateChannelDialog } from '../dialogs/CreateChannelDialog';
import { CreateCategoryDialog } from '../dialogs/CreateCategoryDialog';
import { CreateServerDialog } from './CreateServerDialog';

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
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [menuOpenSlug, setMenuOpenSlug] = useState<string | null>(null);
  const [channelDialog, setChannelDialog] = useState<
    { slug: string; type: ChannelType; categoryId: number | null } | null
  >(null);
  const [categoryDialogSlug, setCategoryDialogSlug] = useState<string | null>(null);
  const menuRooms = useMemo(() => new Map(rooms.map((room) => [room.slug, room])), [rooms]);

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

  return (
    <>
      <header className="sidebar-header">
        <h2>{t('servers.title')}</h2>
        <button type="button" className="ghost" onClick={() => setCreateServerOpen(true)}>
          {t('servers.create')}
        </button>
      </header>
      {rooms.length === 0 ? (
        <p className="sidebar-empty" role="status">
          {t('servers.empty')}
        </p>
      ) : (
        <ul className="server-list">
          {rooms.map((room) => {
            const isActive = room.slug === selectedRoomSlug;
            const isMenuOpen = menuOpenSlug === room.slug;
            const role = roomDetails[room.slug]?.current_role;
            const canManage = role === 'owner' || role === 'admin';
            return (
              <li key={room.id} className={clsx('server-list__item', { 'server-list__item--active': isActive })}>
                <button
                  type="button"
                  className={clsx('server-pill', { 'server-pill--active': isActive })}
                  onClick={() => onSelect(room.slug)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="server-pill__initials" aria-hidden="true">
                    {room.title
                      .split(/\s+/)
                      .map((chunk) => chunk.charAt(0).toUpperCase())
                      .slice(0, 2)
                      .join('') || '#'}
                  </span>
                  <span className="server-pill__label">{room.title}</span>
                </button>
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
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCreateChannel(room.slug, 'text');
                          }}
                        >
                          {t('channels.createText')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCreateChannel(room.slug, 'voice');
                          }}
                        >
                          {t('channels.createVoice')}
                        </button>
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
          })}
        </ul>
      )}
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
