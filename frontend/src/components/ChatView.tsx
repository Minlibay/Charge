import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, Message, TypingUser } from '../types';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import type { ChannelSocketStatus } from '../hooks/useChannelSocket';

interface ChatViewProps {
  channel: Channel | undefined;
  messages: Message[];
  typingUsers: TypingUser[];
  status: ChannelSocketStatus;
  onSendMessage: (content: string) => void;
  onTyping: (isTyping: boolean) => void;
  error?: string;
  loading?: boolean;
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
}: ChatViewProps): JSX.Element {
  const { t } = useTranslation();

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

  return (
    <section className="chat-view" aria-labelledby="chat-title">
      <header className="chat-view__header">
        <div>
          <h2 id="chat-title">{channel ? `# ${channel.name}` : t('chat.title')}</h2>
          {statusLabel && <span className={`connection-badge connection-badge--${status}`}>{statusLabel}</span>}
        </div>
        {error && <p className="chat-error">{error}</p>}
      </header>
      <div className="chat-view__scroll" role="log" aria-live="polite">
        {loading && <p className="chat-loading">{t('common.loading')}</p>}
        {!loading && messages.length === 0 && <p className="chat-empty">{t('chat.empty')}</p>}
        {!loading && messages.length > 0 && <MessageList messages={messages} />}
      </div>
      {typingLabel && <div className="chat-typing" aria-live="assertive">{typingLabel}</div>}
      <MessageInput
        channelName={channel?.name}
        onSend={onSendMessage}
        onTyping={onTyping}
        disabled={disableInput}
      />
    </section>
  );
}
