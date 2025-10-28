import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  Channel,
  Message,
  RoomMemberSummary,
  RoomRole,
  TypingUser,
} from '../types';
import { fetchThreadMessages } from '../services/api';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import type { ChannelSocketStatus } from '../hooks/useChannelSocket';

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
}: ChatViewProps): JSX.Element {
  const { t } = useTranslation();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadSeed, setThreadSeed] = useState<Message[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

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
        <div>
          <h2 id="chat-title">{channel ? `# ${channel.name}` : t('chat.title')}</h2>
          {statusLabel && <span className={`connection-badge connection-badge--${status}`}>{statusLabel}</span>}
        </div>
        {error && <p className="chat-error">{error}</p>}
      </header>
      <div className="chat-view__main">
        <div className="chat-view__scroll" role="log" aria-live="polite">
          {loading && <p className="chat-loading">{t('common.loading')}</p>}
          {!loading && messages.length === 0 && <p className="chat-empty">{t('chat.empty')}</p>}
          {!loading && messages.length > 0 && (
            <MessageList
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
            {threadLoading && <p className="chat-loading">{t('common.loading')}</p>}
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
