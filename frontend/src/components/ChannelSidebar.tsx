import * as ContextMenu from './ui/ContextMenu';
import clsx from 'clsx';
import { useCallback, useMemo, useState } from 'react';
import { DragDropContext, Draggable, Droppable, type DropResult } from './ui/SimpleDnd';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../state/workspaceStore';
import {
  CHANNEL_TYPES,
  type Channel,
  type ChannelCategory,
  type ChannelType,
  type RoomInvitation,
  type RoomMemberSummary,
  type RoomRole,
  type RoomRoleLevel,
} from '../types';
import { CreateChannelDialog } from './dialogs/CreateChannelDialog';
import { CreateCategoryDialog } from './dialogs/CreateCategoryDialog';
import { InviteManagerDialog } from './dialogs/InviteManagerDialog';
import { InviteFriendDialog } from './dialogs/InviteFriendDialog';
import { RoleManagerDialog } from './dialogs/RoleManagerDialog';
import { CustomRoleManagerDialog } from './dialogs/CustomRoleManagerDialog';
import { ChannelSettingsDialog } from './dialogs/ChannelSettingsDialog';
import {
  CalendarIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  HashIcon,
  MegaphoneIcon,
  MessagesIcon,
  MicIcon,
  PlusIcon,
  ShieldIcon,
  StageIcon,
  TrashIcon,
  UserPlusIcon,
} from './icons/LucideIcons';
import type { IconComponent } from './icons/LucideIcons';

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
  members?: RoomMemberSummary[];
}

const CHANNEL_DROPPABLE_PREFIX = 'channel';
const CATEGORY_DRAGGABLE_PREFIX = 'category';

const CHANNEL_SECTION_ORDER: ChannelType[] = [
  'text',
  'announcements',
  'forums',
  'events',
  'voice',
  'stage',
];

const CHANNEL_SECTION_LABEL_KEYS: Record<ChannelType, string> = {
  text: 'channels.text',
  voice: 'channels.voice',
  stage: 'channels.stage',
  announcements: 'channels.announcements',
  forums: 'channels.forums',
  events: 'channels.events',
};

const CHANNEL_CREATION_LABEL_KEYS: Record<ChannelType, string> = {
  text: 'channels.createText',
  voice: 'channels.createVoice',
  stage: 'channels.createStage',
  announcements: 'channels.createAnnouncements',
  forums: 'channels.createForums',
  events: 'channels.createEvents',
};

const CHANNEL_TYPE_ICONS: Record<ChannelType, IconComponent> = {
  text: HashIcon,
  voice: MicIcon,
  stage: StageIcon,
  announcements: MegaphoneIcon,
  forums: MessagesIcon,
  events: CalendarIcon,
};

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
  const channelType = type as ChannelType;
  if (!CHANNEL_TYPES.includes(channelType)) {
    return null;
  }
  const categoryId = categoryToken === 'none' ? null : Number(categoryToken);
  if (categoryId !== null && Number.isNaN(categoryId)) {
    return null;
  }
  return { categoryId, type: channelType };
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
  members = [],
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
  const [inviteFriendDialogOpen, setInviteFriendDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [customRoleDialogOpen, setCustomRoleDialogOpen] = useState(false);
  const [settingsChannelId, setSettingsChannelId] = useState<number | null>(null);
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

    CHANNEL_TYPES.forEach((type) => {
      ensure(null, type);
    });

    categories.forEach((category) => {
      CHANNEL_TYPES.forEach((type) => {
        ensure(category.id, type);
      });
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

  const channelCreationOptions = useMemo<
    Array<{ type: ChannelType; label: string; Icon: IconComponent }>
  >(
    () =>
      CHANNEL_SECTION_ORDER.map((type) => ({
        type,
        label: t(CHANNEL_CREATION_LABEL_KEYS[type]),
        Icon: CHANNEL_TYPE_ICONS[type] ?? HashIcon,
      })),
    [t],
  );

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
      const ChannelTypeIcon = CHANNEL_TYPE_ICONS[channel.type] ?? HashIcon;

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
                      <GripVerticalIcon size={14} strokeWidth={2} />
                    </span>
                    <span className="channel-item__icon" aria-hidden="true">
                      <ChannelTypeIcon size={18} strokeWidth={1.8} />
                    </span>
                    <span className="channel-item__label">{channel.name}</span>
                    {channel.is_nsfw && (
                      <span className="channel-item__indicator" title={t('channels.nsfw', { defaultValue: 'NSFW Channel' })} aria-label={t('channels.nsfw', { defaultValue: 'NSFW Channel' })}>
                        18+
                      </span>
                    )}
                    {channel.is_private && (
                      <span className="channel-item__indicator channel-item__indicator--lock" title={t('channels.private', { defaultValue: 'Private Channel' })} aria-label={t('channels.private', { defaultValue: 'Private Channel' })}>
                        🔒
                      </span>
                    )}
                    {channel.is_archived && (
                      <span className="channel-item__indicator channel-item__indicator--archive" title={t('channels.archived', { defaultValue: 'Archived Channel' })} aria-label={t('channels.archived', { defaultValue: 'Archived Channel' })}>
                        📦
                      </span>
                    )}
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
                    <ExternalLinkIcon size={16} strokeWidth={1.8} />
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
                    <CopyIcon size={16} strokeWidth={1.8} />
                    {t('channels.copyLetter', { defaultValue: 'Скопировать букву' })}
                  </ContextMenu.Item>
                  {canManage ? <ContextMenu.Separator className="context-menu__separator" /> : null}
                  {canManage ? (
                    <ContextMenu.Item
                      className="context-menu__item"
                      onSelect={() => setSettingsChannelId(channel.id)}
                    >
                      <ShieldIcon size={16} strokeWidth={1.8} />
                      {t('channels.managePermissions', { defaultValue: 'Права доступа' })}
                    </ContextMenu.Item>
                  ) : null}
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
                      <TrashIcon size={16} strokeWidth={1.8} />
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
    titleKey: string,
    emptyKey: string,
    withHeading = true,
  ) => {
    const list = channelLists.get(droppableId) ?? [];
    const showEmptyLabel = withHeading && list.length === 0;
    const heading = t(titleKey);
    const emptyLabel = t(emptyKey);
    return (
      <section key={droppableId} className="channel-section">
        {withHeading ? <h3>{heading}</h3> : null}
        <Droppable droppableId={droppableId} type="CHANNEL">
          {(provided, snapshot) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={clsx('channel-list', {
                'channel-list--empty': list.length === 0,
                'channel-list--dragging-over': snapshot.isDraggingOver,
              })}
              aria-label={heading}
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

  const settingsChannel = settingsChannelId ? channelsById.get(settingsChannelId) ?? null : null;

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
            <button type="button" className="ghost" onClick={() => setCustomRoleDialogOpen(true)}>
              {t('roles.customRoles', { defaultValue: 'Кастомные роли' })}
            </button>
            <button type="button" className="ghost button-with-icon" onClick={() => setCategoryDialogOpen(true)}>
              <FolderPlusIcon size={16} strokeWidth={1.8} />
              {t('channels.createCategory')}
            </button>
            <button
              type="button"
              className="ghost button-with-icon"
              onClick={() => {
                setChannelDialog({ categoryId: null, type: 'text' });
              }}
            >
              <PlusIcon size={16} strokeWidth={1.8} />
              {t('channels.quickCreate')}
            </button>
          </div>
        ) : null}
      </header>
      <div className="channel-sidebar__quick-actions">
        <button
          type="button"
          className="primary button-with-icon"
          onClick={() => setInviteFriendDialogOpen(true)}
        >
          <UserPlusIcon size={16} strokeWidth={1.8} />
          {t('invites.inviteFriend', { defaultValue: 'Пригласить друга' })}
        </button>
      </div>
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="channel-groups">
          {CHANNEL_SECTION_ORDER.map((type) =>
            renderChannelSection(
              makeChannelDroppableId(null, type),
              CHANNEL_SECTION_LABEL_KEYS[type],
              'channels.empty',
            ),
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
                                  <GripVerticalIcon size={16} strokeWidth={2} />
                                </span>
                              ) : null}
                            </div>
                          </ContextMenu.Trigger>
                          <ContextMenu.Portal>
                            <ContextMenu.Content className="context-menu" sideOffset={4} align="end">
                              <ContextMenu.Label className="context-menu__label">
                                {category.name}
                              </ContextMenu.Label>
                              {channelCreationOptions.map((option) => (
                                <ContextMenu.Item
                                  key={option.type}
                                  className="context-menu__item"
                                  onSelect={() =>
                                    setChannelDialog({ categoryId: category.id, type: option.type })
                                  }
                                >
                                  <option.Icon size={16} strokeWidth={1.8} />
                                  {option.label}
                                </ContextMenu.Item>
                              ))}
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
                                <TrashIcon size={16} strokeWidth={1.8} />
                                {t('channels.deleteCategory')}
                              </ContextMenu.Item>
                            </ContextMenu.Content>
                          </ContextMenu.Portal>
                        </ContextMenu.Root>
                        {CHANNEL_SECTION_ORDER.map((type) =>
                          renderChannelSection(
                            makeChannelDroppableId(category.id, type),
                            CHANNEL_SECTION_LABEL_KEYS[type],
                            'channels.empty',
                            false,
                          ),
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
      <InviteFriendDialog
        open={inviteFriendDialogOpen}
        roomSlug={roomSlug ?? null}
        roomTitle={roomTitle}
        onClose={() => setInviteFriendDialogOpen(false)}
      />
      <RoleManagerDialog
        open={roleDialogOpen}
        roomSlug={roomSlug ?? null}
        hierarchy={roleHierarchy}
        onClose={() => setRoleDialogOpen(false)}
      />
      <CustomRoleManagerDialog
        open={customRoleDialogOpen}
        roomSlug={roomSlug ?? null}
        onClose={() => setCustomRoleDialogOpen(false)}
      />
      <ChannelSettingsDialog
        open={settingsChannelId !== null}
        channel={settingsChannel}
        roleHierarchy={roleHierarchy}
        members={members}
        onClose={() => setSettingsChannelId(null)}
      />
    </nav>
  );
}

