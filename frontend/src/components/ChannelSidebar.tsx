import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../state/workspaceStore';
import type { Channel, ChannelCategory, RoomInvitation, RoomRole, RoomRoleLevel } from '../types';
import { CreateChannelDialog } from './dialogs/CreateChannelDialog';
import { CreateCategoryDialog } from './dialogs/CreateCategoryDialog';
import { InviteManagerDialog } from './dialogs/InviteManagerDialog';
import { RoleManagerDialog } from './dialogs/RoleManagerDialog';

interface ChannelSidebarProps {
  channels: Channel[];
  categories: ChannelCategory[];
  selectedChannelId: number | null;
  onSelectChannel: (channelId: number) => void;
  roomTitle?: string;
  currentRole?: RoomRole | null;
  roomSlug?: string | null;
  invitations?: RoomInvitation[];
  roleHierarchy?: RoomRoleLevel[];
}

export function ChannelSidebar({
  channels,
  categories,
  selectedChannelId,
  onSelectChannel,
  roomTitle,
  currentRole,
  roomSlug,
  invitations = [],
  roleHierarchy = [],
}: ChannelSidebarProps): JSX.Element {
  const { t } = useTranslation();
  const createChannel = useWorkspaceStore((state) => state.createChannel);
  const deleteChannel = useWorkspaceStore((state) => state.deleteChannel);
  const createCategory = useWorkspaceStore((state) => state.createCategory);
  const deleteCategory = useWorkspaceStore((state) => state.deleteCategory);
  const setError = useWorkspaceStore((state) => state.setError);
  const [channelMenuOpen, setChannelMenuOpen] = useState<number | null>(null);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState<number | null>(null);
  const [channelDialog, setChannelDialog] = useState<
    { categoryId: number | null; type: Channel['type'] } | null
  >(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const canManage = currentRole === 'owner' || currentRole === 'admin';

  useEffect(() => {
    if (!channelMenuOpen && !categoryMenuOpen) {
      return;
    }
    const handler = () => {
      setChannelMenuOpen(null);
      setCategoryMenuOpen(null);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [categoryMenuOpen, channelMenuOpen]);

  const { grouped, ungroupedText, ungroupedVoice } = useMemo(() => {
    const groupedChannels = categories.map((category) => ({
      category,
      text: channels.filter((channel) => channel.category_id === category.id && channel.type === 'text'),
      voice: channels.filter((channel) => channel.category_id === category.id && channel.type === 'voice'),
    }));
    const ungrouped = channels.filter((channel) => channel.category_id === null);
    return {
      grouped: groupedChannels,
      ungroupedText: ungrouped.filter((channel) => channel.type === 'text'),
      ungroupedVoice: ungrouped.filter((channel) => channel.type === 'voice'),
    };
  }, [categories, channels]);

  const renderChannel = (channel: Channel) => {
    const isActive = channel.id === selectedChannelId;
    return (
      <div
        key={channel.id}
        className={clsx('channel-item', { 'channel-item--active': isActive })}
        role="group"
      >
        <button
          type="button"
          className="channel-item__action"
          onClick={() => onSelectChannel(channel.id)}
          aria-current={isActive ? 'true' : undefined}
        >
          <span className="channel-item__icon" aria-hidden="true">
            {channel.type === 'voice' ? '🔊' : '#'}
          </span>
          <span className="channel-item__label">{channel.name}</span>
          <span className="channel-item__letter" aria-hidden="true">
            {channel.letter}
          </span>
        </button>
        {canManage && (
          <button
            type="button"
            className="channel-menu-button"
            aria-haspopup="menu"
            aria-expanded={channelMenuOpen === channel.id}
            aria-label={t('channels.manageChannel', { name: channel.name })}
            onClick={(event) => {
              event.stopPropagation();
              setChannelMenuOpen((prev) => (prev === channel.id ? null : channel.id));
            }}
          >
            ⋯
          </button>
        )}
        {canManage && channelMenuOpen === channel.id && (
          <div className="context-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={async (event) => {
                event.stopPropagation();
                if (!roomSlug) {
                  return;
                }
                try {
                  await deleteChannel(roomSlug, channel.letter);
                } catch (err) {
                  const message = err instanceof Error ? err.message : t('channels.deleteChannelFailed');
                  setError(message);
                } finally {
                  setChannelMenuOpen(null);
                }
              }}
            >
              {t('channels.deleteChannel')}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <nav className="channel-sidebar" aria-label={t('channels.title')}>
      <header className="channel-sidebar__header">
        <div>
          <h2 className="channel-sidebar__title">{roomTitle ?? t('channels.title')}</h2>
          {currentRole ? (
            <span className="channel-role">{currentRole.toUpperCase()}</span>
          ) : null}
        </div>
        {canManage && (
          <div className="channel-sidebar__actions">
            <button type="button" className="ghost" onClick={() => setInviteDialogOpen(true)}>
              {t('invites.manageAction')}
            </button>
            <button type="button" className="ghost" onClick={() => setRoleDialogOpen(true)}>
              {t('roles.manageAction')}
            </button>
            <button type="button" className="ghost" onClick={() => setCategoryDialogOpen(true)}>
              {t('channels.createCategory')}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setChannelDialog({ categoryId: null, type: 'text' });
              }}
            >
              {t('channels.quickCreate')}
            </button>
          </div>
        )}
      </header>
      <div className="channel-groups">
        {ungroupedText.length > 0 && (
          <section>
            <h3>{t('channels.text')}</h3>
            <div className="channel-list">{ungroupedText.map(renderChannel)}</div>
          </section>
        )}
        {ungroupedVoice.length > 0 && (
          <section>
            <h3>{t('channels.voice')}</h3>
            <div className="channel-list">{ungroupedVoice.map(renderChannel)}</div>
          </section>
        )}
        {grouped.map(({ category, text, voice }) => (
          <section key={category.id} className="channel-category">
            <div className="channel-category__header">
              <h3>{category.name}</h3>
              {canManage && (
                <button
                  type="button"
                  className="channel-menu-button"
                  aria-haspopup="menu"
                  aria-expanded={categoryMenuOpen === category.id}
                  aria-label={t('channels.manageCategory', { name: category.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCategoryMenuOpen((prev) => (prev === category.id ? null : category.id));
                  }}
                >
                  ⋯
                </button>
              )}
              {canManage && categoryMenuOpen === category.id && (
                <div className="context-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      setChannelDialog({ categoryId: category.id, type: 'text' });
                      setCategoryMenuOpen(null);
                    }}
                  >
                    {t('channels.createText')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      setChannelDialog({ categoryId: category.id, type: 'voice' });
                      setCategoryMenuOpen(null);
                    }}
                  >
                    {t('channels.createVoice')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async (event) => {
                      event.stopPropagation();
                      if (!roomSlug) {
                        return;
                      }
                      try {
                        await deleteCategory(roomSlug, category.id);
                      } catch (err) {
                        const message = err instanceof Error ? err.message : t('channels.deleteCategoryFailed');
                        setError(message);
                      } finally {
                        setCategoryMenuOpen(null);
                      }
                    }}
                  >
                    {t('channels.deleteCategory')}
                  </button>
                </div>
              )}
            </div>
            <div className="channel-list">
              {text.map(renderChannel)}
              {voice.map(renderChannel)}
            </div>
          </section>
        ))}
        {channels.length === 0 && (
          <p className="sidebar-empty">{t('channels.empty')}</p>
        )}
      </div>
      <CreateChannelDialog
        open={Boolean(channelDialog)}
        defaultType={channelDialog?.type ?? 'text'}
        onClose={() => setChannelDialog(null)}
        onCreate={async (name, type) => {
          if (!roomSlug || !channelDialog) {
            return;
          }
          const channel = await createChannel(roomSlug, {
            name,
            type,
            category_id: channelDialog.categoryId,
          });
          onSelectChannel(channel.id);
          setChannelDialog(null);
        }}
      />
      <CreateCategoryDialog
        open={categoryDialogOpen}
        onClose={() => setCategoryDialogOpen(false)}
        defaultPosition={categories.length}
        roomTitle={roomTitle}
        onCreate={async (name, position) => {
          if (!roomSlug) {
            return;
          }
          await createCategory(roomSlug, name, position);
          setCategoryDialogOpen(false);
        }}
      />
      <InviteManagerDialog
        open={inviteDialogOpen}
        roomSlug={roomSlug ?? null}
        invitations={invitations}
        onClose={() => setInviteDialogOpen(false)}
      />
      <RoleManagerDialog
        open={roleDialogOpen}
        roomSlug={roomSlug ?? null}
        hierarchy={roleHierarchy}
        onClose={() => setRoleDialogOpen(false)}
      />
    </nav>
  );
}
