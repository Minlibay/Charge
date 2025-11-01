import { useMemo, useState } from 'react';

import type { DirectConversation, DirectConversationCreatePayload, FriendUser, PresenceStatus } from '../../types';
import { PresenceIndicator } from '../notifications/PresenceIndicator';

interface DirectSidebarProps {
  conversations: DirectConversation[];
  friends: FriendUser[];
  currentUserId: number | null;
  activeConversationId: number | null;
  onSelectConversation: (conversationId: number) => void;
  onStartDirectConversation: (friendId: number) => Promise<void>;
  onCreateGroup: (payload: DirectConversationCreatePayload) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function statusLabel(status: PresenceStatus, t: DirectSidebarProps['t']): string {
  switch (status) {
    case 'idle':
      return t('presence.status.idle', { defaultValue: 'Отошел' });
    case 'dnd':
      return t('presence.status.dnd', { defaultValue: 'Не беспокоить' });
    case 'online':
    default:
      return t('presence.status.online', { defaultValue: 'В сети' });
  }
}

function conversationTitle(
  conversation: DirectConversation,
  currentUserId: number | null,
  fallback: string,
): string {
  if (conversation.title) {
    return conversation.title;
  }
  const others = conversation.participants.filter((participant) => participant.user.id !== currentUserId);
  if (others.length === 0) {
    return fallback;
  }
  return others
    .map((participant) => participant.user.display_name ?? participant.user.login)
    .join(', ');
}

export function DirectSidebar({
  conversations,
  friends,
  currentUserId,
  activeConversationId,
  onSelectConversation,
  onStartDirectConversation,
  onCreateGroup,
  t,
}: DirectSidebarProps): JSX.Element {
  const [selectedFriendIds, setSelectedFriendIds] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const friendLookup = useMemo(() => new Map(friends.map((friend) => [friend.id, friend])), [friends]);

  const handleStartConversation = async (friendId: number) => {
    setError(null);
    try {
      await onStartDirectConversation(friendId);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('profile.sendMessageError');
      setError(message);
    }
  };

  const handleSubmitGroup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedFriendIds.length === 0) {
      setError(t('direct.group.requireParticipants', { defaultValue: 'Выберите участников' }));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreateGroup({
        participant_ids: selectedFriendIds,
        title: title.trim() ? title.trim() : undefined,
      });
      setSelectedFriendIds([]);
      setTitle('');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('profile.sendMessageError');
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  const toggleFriendSelection = (friendId: number) => {
    setSelectedFriendIds((current) =>
      current.includes(friendId)
        ? current.filter((value) => value !== friendId)
        : [...current, friendId],
    );
  };

  return (
    <aside className="direct-sidebar">
      <div className="direct-sidebar-section">
        <h3>{t('direct.conversations', { defaultValue: 'Диалоги' })}</h3>
        <ul className="direct-conversation-list">
          {conversations.map((conversation) => {
            const key = conversation.id;
            const titleLabel = conversationTitle(
              conversation,
              currentUserId,
              t('direct.unknownConversation', { defaultValue: 'Без названия' }),
            );
            const unread = conversation.unread_count;
            return (
              <li
                key={key}
                className={key === activeConversationId ? 'active' : undefined}
              >
                <button type="button" onClick={() => onSelectConversation(key)}>
                  <span className="direct-conversation-title">{titleLabel}</span>
                  {unread > 0 ? <span className="badge">{unread}</span> : null}
                </button>
              </li>
            );
          })}
          {conversations.length === 0 ? (
            <li className="empty">{t('direct.noConversations', { defaultValue: 'Нет диалогов' })}</li>
          ) : null}
        </ul>
      </div>
      <div className="direct-sidebar-section">
        <h3>{t('direct.friends', { defaultValue: 'Друзья' })}</h3>
        <ul className="direct-friends-list">
          {friends.map((friend) => (
            <li key={friend.id}>
              <div className="presence-row">
                <PresenceIndicator status={friend.status} label={statusLabel(friend.status, t)} />
                <span className="presence-label">
                  {friend.display_name ?? friend.login} • {statusLabel(friend.status, t)}
                </span>
              </div>
              <button type="button" onClick={() => handleStartConversation(friend.id)}>
                {t('direct.startConversation', { defaultValue: 'Начать' })}
              </button>
            </li>
          ))}
          {friends.length === 0 ? (
            <li className="empty">{t('direct.noFriends', { defaultValue: 'Список друзей пуст' })}</li>
          ) : null}
        </ul>
      </div>
      <div className="direct-sidebar-section">
        <h3>{t('direct.group.create', { defaultValue: 'Новый групповой чат' })}</h3>
        <form onSubmit={handleSubmitGroup} className="direct-group-form">
          <label>
            {t('direct.group.title', { defaultValue: 'Название' })}
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('direct.group.titlePlaceholder', { defaultValue: 'Название чата (необязательно)' })}
            />
          </label>
          <fieldset>
            <legend>{t('direct.group.participants', { defaultValue: 'Выберите друзей' })}</legend>
            <div className="direct-group-participants">
              {friends.map((friend) => (
                <label key={`group-${friend.id}`}>
                  <input
                    type="checkbox"
                    checked={selectedFriendIds.includes(friend.id)}
                    onChange={() => toggleFriendSelection(friend.id)}
                  />
                  {friend.display_name ?? friend.login}
                </label>
              ))}
              {friends.length === 0 ? (
                <p className="empty">{t('direct.group.noFriends', { defaultValue: 'Добавьте друзей, чтобы создать чат' })}</p>
              ) : null}
            </div>
          </fieldset>
          <button type="submit" disabled={creating}>
            {creating
              ? t('direct.group.creating', { defaultValue: 'Создание…' })
              : t('direct.group.submit', { defaultValue: 'Создать чат' })}
          </button>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </form>
      </div>
      {friendLookup.size > 0 ? null : (
        <p className="hint">{t('direct.addFriendsHint', { defaultValue: 'Добавьте друзей, чтобы начать общение' })}</p>
      )}
    </aside>
  );
}
