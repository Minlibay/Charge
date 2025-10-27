import * as ContextMenu from './ui/ContextMenu';
import clsx from 'clsx';
import { useCallback, useMemo, useState } from 'react';
import { DragDropContext, Draggable, Droppable, type DropResult } from './ui/SimpleDnd';
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

const CHANNEL_DROPPABLE_PREFIX = 'channel';
const CATEGORY_DRAGGABLE_PREFIX = 'category';

function makeChannelDroppableId(categoryId: number | null, type: Channel['type']): string {
  return `${CHANNEL_DROPPABLE_PREFIX}:${categoryId ?? 'none'}:${type}`;
}

function parseChannelDroppableId(
  droppableId: string,
): { categoryId: number | null; type: Channel['type'] } | null {
  if (!droppableId.startsWith(`${CHANNEL_DROPPABLE_PREFIX}:`)) {
    return null;
  }
  const [, categoryToken, type] = droppableId.split(':');
  if (type !== 'text' && type !== 'voice') {
    return null;
  }
  const categoryId = categoryToken === 'none' ? null : Number(categoryToken);
  if (categoryId !== null && Number.isNaN(categoryId)) {
    return null;
  }
  return { categoryId, type };
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
  const reorderCategories = useWorkspaceStore((state) => state.reorderCategories);
  const reorderChannels = useWorkspaceStore((state) => state.reorderChannels);
  const setError = useWorkspaceStore((state) => state.setError);
  const unreadCountByChannel = useWorkspaceStore((state) => state.unreadCountByChannel);
  const mentionCountByChannel = useWorkspaceStore((state) => state.mentionCountByChannel);
  const [channelDialog, setChannelDialog] = useState<
    { categoryId: number | null; type: Channel['type'] } | null
  >(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const canManage = currentRole === 'owner' || currentRole === 'admin';

  const channelsById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);

  const channelLists = useMemo(() => {
    const lists = new Map<string, Channel[]>();
    const ensure = (categoryId: number | null, type: Channel['type']) => {
      const id = makeChannelDroppableId(categoryId, type);
      if (!lists.has(id)) {
        lists.set(id, []);
      }
      return id;
    };

    ensure(null, 'text');
    ensure(null, 'voice');

    categories.forEach((category) => {
      ensure(category.id, 'text');
      ensure(category.id, 'voice');
    });

    channels.forEach((channel) => {
      const id = makeChannelDroppableId(channel.category_id, channel.type);
      if (!lists.has(id)) {
        lists.set(id, []);
      }
      lists.get(id)?.push(channel);
    });

    return lists;
  }, [categories, channels]);

  const formatBadgeCount = (value: number): string => {
    if (value > 99) {
      return '99+';
    }
    return String(value);
  };

  const handleDragEnd = useCallback(
    async (result: DropResult) => {
      if (!roomSlug || !result.destination || !canManage) {
        return;
      }

      if (result.type === 'CATEGORY') {
        const nextCategories = [...categories];
        const [moved] = nextCategories.splice(result.source.index, 1);
        nextCategories.splice(result.destination.index, 0, moved);
        const ordering = nextCategories.map((category, index) => ({
          id: category.id,
          position: index,
        }));
        await reorderCategories(roomSlug, ordering);
        return;
      }

      if (result.type === 'CHANNEL') {
        const sourceInfo = parseChannelDroppableId(result.source.droppableId);
        const destinationInfo = parseChannelDroppableId(result.destination.droppableId);
        if (!sourceInfo || !destinationInfo) {
          return;
        }
        const channelId = Number(result.draggableId.replace('channel-', ''));
        const channel = channelsById.get(channelId);
        if (!channel || channel.type !== destinationInfo.type) {
          return;
        }

        const working = new Map<string, Channel[]>(
          Array.from(channelLists.entries()).map(([key, list]) => [key, list.map((item) => ({ ...item }))]),
        );
        const sourceList = working.get(result.source.droppableId) ?? [];
        const [removed] = sourceList.splice(result.source.index, 1);
        working.set(result.source.droppableId, sourceList);

        const destinationList =
          result.source.droppableId === result.destination.droppableId
            ? sourceList
            : [...(working.get(result.destination.droppableId) ?? [])];
        destinationList.splice(result.destination.index, 0, {
          ...removed,
          category_id: destinationInfo.categoryId,
        });
        working.set(result.destination.droppableId, destinationList);

        const ordering: { id: number; category_id: number | null; position: number }[] = [];
        working.forEach((list, key) => {
          const info = parseChannelDroppableId(key);
          if (!info) {
            return;
          }
          list.forEach((item, index) => {
            ordering.push({ id: item.id, category_id: info.categoryId, position: index });
          });
        });

        await reorderChannels(roomSlug, ordering);
      }
    },
    [canManage, categories, channelLists, channelsById, reorderCategories, reorderChannels, roomSlug],
  );

  const renderChannel = useCallback(
    (channel: Channel, index: number) => {
      const isActive = channel.id === selectedChannelId;
      const unreadCount = unreadCountByChannel[channel.id] ?? 0;
      const mentionCount = mentionCountByChannel[channel.id] ?? 0;
      const hasBadge = !isActive && (mentionCount > 0 || unreadCount > 0);
      const badgeValue = mentionCount > 0 ? mentionCount : unreadCount;

      return (
        <Draggable
          key={channel.id}
          draggableId={`channel-${channel.id}`}
          index={index}
          isDragDisabled={!canManage}
        >
          {(provided, snapshot) => (
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <div
                  ref={provided.innerRef}
                  {...provided.draggableProps}
                  className={clsx('channel-item', {
                    'channel-item--active': isActive,
                    'channel-item--unread': hasBadge && unreadCount > 0,
                    'channel-item--mention': hasBadge && mentionCount > 0,
                    'channel-item--dragging': snapshot.isDragging,
                  })}
                  role="group"
                >
                  <button
                    type="button"
                    className="channel-item__action"
                    onClick={() => onSelectChannel(channel.id)}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <span
                      className="channel-item__drag-handle"
                      aria-hidden="true"
                      {...(canManage ? provided.dragHandleProps : {})}
                    >
                      ⋮⋮
                    </span>
                    <span className="channel-item__icon" aria-hidden="true">
                      {channel.type === 'voice' ? '🔊' : '#'}
                    </span>
                    <span className="channel-item__label">{channel.name}</span>
                    {hasBadge ? (
                      <span className="channel-item__badge-wrapper" aria-hidden="true">
                        <span
                          className={clsx('channel-item__badge', {
                            'channel-item__badge--mention': mentionCount > 0,
                          })}
                        >
                          {formatBadgeCount(badgeValue)}
                        </span>
                      </span>
                    ) : null}
                    <span className="channel-item__letter" aria-hidden="true">
                      {channel.letter}
                    </span>
                  </button>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="context-menu" sideOffset={4} align="end">
                  <ContextMenu.Label className="context-menu__label">{channel.name}</ContextMenu.Label>
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => onSelectChannel(channel.id)}
                  >
                    {t('channels.openChannel', { defaultValue: 'Открыть канал' })}
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className="context-menu__item"
                    disabled={!navigator.clipboard}
                    onSelect={() => {
                      void navigator.clipboard?.writeText(channel.letter).catch(() => {
                        setError(t('channels.copyLetterFailed', { defaultValue: 'Не удалось скопировать' }));
                      });
                    }}
                  >
                    {t('channels.copyLetter', { defaultValue: 'Скопировать букву' })}
                  </ContextMenu.Item>
                  {canManage ? <ContextMenu.Separator className="context-menu__separator" /> : null}
                  {canManage ? (
                    <ContextMenu.Item
                      className="context-menu__item context-menu__item--danger"
                      onSelect={async () => {
                        if (!roomSlug) {
                          return;
                        }
                        try {
                          await deleteChannel(roomSlug, channel.letter);
                        } catch (error) {
                          const message =
                            error instanceof Error
                              ? error.message
                              : t('channels.deleteChannelFailed');
                          setError(message);
                        }
                      }}
                    >
                      {t('channels.deleteChannel')}
                    </ContextMenu.Item>
                  ) : null}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          )}
        </Draggable>
      );
    },
    [
      canManage,
      deleteChannel,
      mentionCountByChannel,
      onSelectChannel,
      roomSlug,
      selectedChannelId,
      setError,
      t,
      unreadCountByChannel,
    ],
  );

  const renderChannelSection = (
    droppableId: string,
    title: string,
    emptyLabel: string,
    withHeading = true,
  ) => {
    const list = channelLists.get(droppableId) ?? [];
    const showEmptyLabel = withHeading && list.length === 0;
    return (
      <section key={droppableId} className="channel-section">
        {withHeading ? <h3>{title}</h3> : null}
        <Droppable droppableId={droppableId} type="CHANNEL">
          {(provided, snapshot) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={clsx('channel-list', {
                'channel-list--empty': list.length === 0,
                'channel-list--dragging-over': snapshot.isDraggingOver,
              })}
              aria-label={title}
            >
              {showEmptyLabel ? (
                <p className="channel-list__empty">{emptyLabel}</p>
              ) : (
                list.map((channel, index) => renderChannel(channel, index))
              )}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </section>
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
        {canManage ? (
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
        ) : null}
      </header>
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="channel-groups">
          {renderChannelSection(
            makeChannelDroppableId(null, 'text'),
            t('channels.text'),
            t('channels.empty'),
          )}
          {renderChannelSection(
            makeChannelDroppableId(null, 'voice'),
            t('channels.voice'),
            t('channels.empty'),
          )}
          <Droppable droppableId="categories" type="CATEGORY">
            {(provided) => (
              <div ref={provided.innerRef} {...provided.droppableProps} className="channel-category-list">
                {categories.map((category, index) => (
                  <Draggable
                    key={category.id}
                    draggableId={`${CATEGORY_DRAGGABLE_PREFIX}-${category.id}`}
                    index={index}
                    isDragDisabled={!canManage}
                  >
                    {(catProvided) => (
                      <section
                        ref={catProvided.innerRef}
                        {...catProvided.draggableProps}
                        className="channel-category"
                      >
                        <ContextMenu.Root>
                          <ContextMenu.Trigger asChild>
                            <div
                              className="channel-category__header"
                              tabIndex={0}
                              aria-label={t('channels.manageCategory', { name: category.name })}
                              {...(canManage ? catProvided.dragHandleProps : {})}
                            >
                              <span>{category.name}</span>
                              {canManage ? (
                                <span className="channel-category__handle" aria-hidden="true">
                                  ⋮
                                </span>
                              ) : null}
                            </div>
                          </ContextMenu.Trigger>
                          <ContextMenu.Portal>
                            <ContextMenu.Content className="context-menu" sideOffset={4} align="end">
                              <ContextMenu.Label className="context-menu__label">
                                {category.name}
                              </ContextMenu.Label>
                              <ContextMenu.Item
                                className="context-menu__item"
                                onSelect={() => setChannelDialog({ categoryId: category.id, type: 'text' })}
                              >
                                {t('channels.createText')}
                              </ContextMenu.Item>
                              <ContextMenu.Item
                                className="context-menu__item"
                                onSelect={() => setChannelDialog({ categoryId: category.id, type: 'voice' })}
                              >
                                {t('channels.createVoice')}
                              </ContextMenu.Item>
                              <ContextMenu.Separator className="context-menu__separator" />
                              <ContextMenu.Item
                                className="context-menu__item context-menu__item--danger"
                                onSelect={async () => {
                                  if (!roomSlug) {
                                    return;
                                  }
                                  try {
                                    await deleteCategory(roomSlug, category.id);
                                  } catch (error) {
                                    const message =
                                      error instanceof Error
                                        ? error.message
                                        : t('channels.deleteCategoryFailed');
                                    setError(message);
                                  }
                                }}
                              >
                                {t('channels.deleteCategory')}
                              </ContextMenu.Item>
                            </ContextMenu.Content>
                          </ContextMenu.Portal>
                        </ContextMenu.Root>
                        {renderChannelSection(
                          makeChannelDroppableId(category.id, 'text'),
                          t('channels.text'),
                          t('channels.empty'),
                          false,
                        )}
                        {renderChannelSection(
                          makeChannelDroppableId(category.id, 'voice'),
                          t('channels.voice'),
                          t('channels.empty'),
                          false,
                        )}
                      </section>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
          {channels.length === 0 ? (
            <p className="sidebar-empty">{t('channels.empty')}</p>
          ) : null}
        </div>
      </DragDropContext>
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
