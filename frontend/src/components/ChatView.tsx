import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SVGProps } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  Channel,
  Message,
  PinnedMessage,
  RoomMemberSummary,
  RoomRole,
  TypingUser,
} from '../types';
import { fetchThreadMessages } from '../services/api';
import { MessageInput } from './MessageInput';
import { MessageList, type MessageListHandle } from './messages/MessageList';
import { PinnedPanel } from './messages/PinnedPanel';
import type { ChannelSocketStatus } from '../hooks/useChannelSocket';
import { Skeleton } from './ui';
import { MessagesIcon } from './icons/LucideIcons';

export interface MessageComposerPayload {
  content?: string;
  files?: File[];
  parentId?: number | null;
}

interface ChatViewProps {
  channel: Channel | undefined;
  messages: Message[];
  typingUsers: TypingUser[];
  status: ChannelSocketStatus;
  onSendMessage: (payload: MessageComposerPayload) => Promise<void>;
  onTyping: (isTyping: boolean) => void;
  error?: string;
  loading?: boolean;
  members: RoomMemberSummary[];
  currentUserId: number | null;
  currentRole: RoomRole | null;
  onEditMessage: (message: Message, content: string) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
  onModerateMessage: (
    message: Message,
    action: 'suppress' | 'restore',
    note?: string,
  ) => Promise<void>;
  onAddReaction: (message: Message, emoji: string) => Promise<void>;
  onRemoveReaction: (message: Message, emoji: string) => Promise<void>;
  selfReactions: Record<number, string[]>;
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  pinnedMessages?: PinnedMessage[];
  pinnedLoading?: boolean;
  onRefreshPins?: () => void;
  onUnpinPinnedMessage?: (messageId: number) => Promise<void>;
}

function PinIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        fill="currentColor"
        d="M16.3 3.3a1 1 0 0 0-1.4 0l-2 2a1 1 0 0 0-.28.56l-.37 2.63-4.86 4.86a1 1 0 0 0 .7 1.71H9v1.41a1 1 0 0 0 1.7.7l4.86-4.86 2.63-.37a1 1 0 0 0 .56-.28l2-2a1 1 0 0 0 0-1.41ZM7 18a1 1 0 0 0-1 1v2h2v-2a1 1 0 0 0-1-1Z"
      />
    </svg>
  );
}

function UsersIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        fill="currentColor"
        d="M7 8a4 4 0 1 1 7.45 2.2 5.52 5.52 0 0 1 2 .41A6 6 0 1 0 5 10a4 4 0 0 1 2-2Z"
      />
      <path
        fill="currentColor"
        d="M7 12a5 5 0 0 0-5 5v1a1 1 0 0 0 1 1h8.06a5.45 5.45 0 0 1-.06-.75 6.47 6.47 0 0 1 .64-2.76A5 5 0 0 0 7 12Zm10 1a4 4 0 1 0 4 4 4 4 0 0 0-4-4Zm0 2a2 2 0 0 1 1 3.73V20a1 1 0 0 1-2 0v-1.27A2 2 0 0 1 17 15Z"
      />
    </svg>
  );
}

interface HeaderStatProps {
  icon: JSX.Element;
  label: string;
  value: number | string;
}

function HeaderStat({ icon, label, value }: HeaderStatProps): JSX.Element {
  return (
    <span className="chat-view__stat" title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>
      <span className="chat-view__stat-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{label}</span>
      <span className="chat-view__stat-value">{value}</span>
    </span>
  );
}

export function ChatView({
  channel,
  messages,
  typingUsers,
  status,
  onSendMessage,
  onTyping,
  error,
  loading,
  members,
  currentUserId,
  currentRole,
  onEditMessage,
  onDeleteMessage,
  onModerateMessage,
  onAddReaction,
  onRemoveReaction,
  selfReactions,
  hasMoreOlder = false,
  hasMoreNewer = false,
  loadingOlder = false,
  loadingNewer = false,
  onLoadOlder,
  onLoadNewer,
  pinnedMessages = [],
  pinnedLoading = false,
  onRefreshPins,
  onUnpinPinnedMessage,
}: ChatViewProps): JSX.Element {
  const { t } = useTranslation();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadSeed, setThreadSeed] = useState<Message[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const messageListRef = useRef<MessageListHandle | null>(null);

  const skeletonPlaceholders = useMemo(() => Array.from({ length: 6 }, (_, index) => index), []);

  const pinsLabel = t('chat.pinsLabel', { defaultValue: 'Закрепленные сообщения' });
  const participantsLabel = t('voice.participants', { defaultValue: 'Участники' });

  const typingLabel = useMemo(() => {
    if (typingUsers.length === 0) {
      return '';
    }
    if (typingUsers.length === 1) {
      return t('chat.typing', { users: typingUsers[0].display_name });
    }
    return t('chat.typingMany', { count: typingUsers.length });
  }, [t, typingUsers]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'connected':
        return t('chat.connection.connected');
      case 'connecting':
        return t('chat.connection.connecting');
      case 'error':
        return t('chat.connection.error');
      default:
        return '';
    }
  }, [status, t]);

  const disableInput = status !== 'connected';

  const handleReply = useCallback((message: Message) => {
    setReplyTo(message);
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const handleJumpToMessage = useCallback(
    (messageId: number) => {
      if (messageListRef.current) {
        messageListRef.current.scrollToMessage(messageId);
        return;
      }
      const target = document.getElementById(`message-${messageId}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
      }
    },
    [],
  );

  const handleOpenThread = useCallback(
    async (message: Message) => {
      setThreadRoot(message);
      setThreadLoading(true);
      setThreadError(null);
      try {
        const data = await fetchThreadMessages(message.channel_id, message.id);
        setThreadSeed(data);
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : t('chat.threadError', 'Не удалось загрузить тред');
        setThreadError(messageText);
      } finally {
        setThreadLoading(false);
      }
    },
    [t],
  );

  const handleCloseThread = useCallback(() => {
    setThreadRoot(null);
    setThreadSeed([]);
    setThreadError(null);
  }, []);

  const threadMessages = useMemo(() => {
    if (!threadRoot) {
      return [];
    }
    const map = new Map<number, Message>();
    threadSeed.forEach((item) => {
      map.set(item.id, item);
    });
    messages.forEach((item) => {
      if (item.id === threadRoot.id || item.thread_root_id === threadRoot.id || item.parent_id === threadRoot.id) {
        map.set(item.id, item);
      }
    });
    const merged = Array.from(map.values());
    merged.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return merged;
  }, [messages, threadRoot, threadSeed]);

  useEffect(() => {
    if (!threadRoot) {
      return;
    }
    const latestRoot = messages.find((message) => message.id === threadRoot.id);
    if (latestRoot) {
      setThreadRoot(latestRoot);
    }
  }, [messages, threadRoot]);

  const handleSend = useCallback(
    async (payload: MessageComposerPayload) => {
      await onSendMessage(payload);
      setReplyTo(null);
    },
    [onSendMessage],
  );

  return (
    <section className="chat-view" aria-labelledby="chat-title">
      <header className="chat-view__header">
        <div className="chat-view__header-left">
          <div className="chat-view__title-group">
            <h2 id="chat-title">{channel ? `# ${channel.name}` : t('chat.title')}</h2>
            {statusLabel && (
              <span className={`connection-badge connection-badge--${status}`}>{statusLabel}</span>
            )}
          </div>
          {error && <p className="chat-error">{error}</p>}
        </div>
        <div
          className="chat-view__header-actions"
          aria-label={`${pinsLabel}: ${pinnedMessages.length}, ${participantsLabel}: ${members.length}`}
        >
          <HeaderStat icon={<PinIcon />} label={pinsLabel} value={pinnedMessages.length} />
          <HeaderStat icon={<UsersIcon />} label={participantsLabel} value={members.length} />
        </div>
      </header>
      <div className="chat-view__main">
        <div className="chat-view__scroll" role="log" aria-live="polite">
          <PinnedPanel
            pins={pinnedMessages}
            loading={pinnedLoading}
            onRefresh={onRefreshPins}
            onSelect={handleJumpToMessage}
            onUnpin={
              onUnpinPinnedMessage
                ? (id) => {
                    void onUnpinPinnedMessage(id);
                  }
                : undefined
            }
          />
          {loading && (
            <div className="message-skeleton-list" role="status" aria-live="polite" aria-busy="true">
              <span className="sr-only">{t('common.loading')}</span>
              {skeletonPlaceholders.map((item) => (
                <div key={item} className="message-skeleton">
                  <Skeleton
                    className="message-skeleton__avatar"
                    shape="circle"
                    width={40}
                    height={40}
                    ariaLabel={item === 0 ? t('common.loading') : undefined}
                  />
                  <div className="message-skeleton__content">
                    <div className="message-skeleton__header">
                      <Skeleton width="35%" height="0.85rem" />
                      <Skeleton width="20%" height="0.75rem" />
                    </div>
                    <Skeleton width="80%" height="0.75rem" />
                    <Skeleton width="65%" height="0.75rem" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && messages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty__icon" aria-hidden="true">
                <MessagesIcon size={48} strokeWidth={1.5} />
              </div>
              <h3 className="chat-empty__title">{t('chat.emptyTitle', { defaultValue: 'Нет сообщений' })}</h3>
              <p className="chat-empty__description">
                {channel
                  ? t('chat.emptyDescription', {
                      defaultValue: 'Начните общение в канале {{name}}',
                      name: channel.name,
                    })
                  : t('chat.emptyDescriptionDefault', { defaultValue: 'Начните общение, отправив первое сообщение' })}
              </p>
            </div>
          )}
          {!loading && messages.length > 0 && (
            <MessageList
              ref={messageListRef}
              messages={messages}
              members={members}
              currentUserId={currentUserId}
              currentRole={currentRole}
              onReply={handleReply}
              onOpenThread={handleOpenThread}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
              onModerateMessage={onModerateMessage}
              replyingToId={replyTo?.id ?? null}
              activeThreadRootId={threadRoot?.id ?? null}
              context="channel"
              onAddReaction={onAddReaction}
              onRemoveReaction={onRemoveReaction}
              selfReactions={selfReactions}
              hasMoreOlder={hasMoreOlder}
              hasMoreNewer={hasMoreNewer}
              loadingOlder={loadingOlder}
              loadingNewer={loadingNewer}
              onLoadOlder={onLoadOlder}
              onLoadNewer={onLoadNewer}
            />
          )}
        </div>
        {threadRoot && (
          <aside className="thread-panel" aria-live="polite">
            <header className="thread-panel__header">
              <div>
                <h3>{t('chat.threadTitle', { user: threadRoot.author?.display_name ?? threadRoot.author?.login ?? '—' })}</h3>
                {threadError && <p className="chat-error">{threadError}</p>}
              </div>
              <button type="button" className="ghost" onClick={handleCloseThread}>
                {t('common.close')}
              </button>
            </header>
            {threadLoading && (
              <div className="message-skeleton-list message-skeleton-list--compact" role="status" aria-live="polite">
                <span className="sr-only">{t('common.loading')}</span>
                {skeletonPlaceholders.slice(0, 3).map((item) => (
                  <div key={item} className="message-skeleton">
                    <Skeleton className="message-skeleton__avatar" shape="circle" width={32} height={32} />
                    <div className="message-skeleton__content">
                      <div className="message-skeleton__header">
                        <Skeleton width="45%" height="0.8rem" />
                        <Skeleton width="30%" height="0.7rem" />
                      </div>
                      <Skeleton width="90%" height="0.7rem" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!threadLoading && (
              <MessageList
                messages={threadMessages}
                members={members}
                currentUserId={currentUserId}
                currentRole={currentRole}
                onReply={handleReply}
                onOpenThread={() => undefined}
                onEditMessage={onEditMessage}
                onDeleteMessage={onDeleteMessage}
                onModerateMessage={onModerateMessage}
                replyingToId={replyTo?.id ?? null}
                activeThreadRootId={threadRoot.id}
                context="thread"
                onAddReaction={onAddReaction}
                onRemoveReaction={onRemoveReaction}
                selfReactions={selfReactions}
              />
            )}
          </aside>
        )}
      </div>
      {typingLabel && <div className="chat-typing" aria-live="assertive">{typingLabel}</div>}
      <MessageInput
        channelName={channel?.name}
        onSend={handleSend}
        onTyping={onTyping}
        disabled={disableInput}
        members={members}
        replyingTo={replyTo}
        onCancelReply={handleCancelReply}
      />
    </section>
  );
}
