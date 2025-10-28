import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/api';
import { useFriendsStore } from '../../state/friendsStore';
import type {
  DirectConversation,
  DirectMessage,
  FriendRequest,
  FriendUser,
  PresenceStatus,
} from '../../types';

interface DirectMessagesPageProps {
  open: boolean;
  selectedUserId: number | null;
  onSelectUser: (userId: number | null) => void;
  onClose: () => void;
}

function statusLabel(
  status: PresenceStatus,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
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

function formatTime(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: undefined,
    }).format(new Date(value));
  } catch (error) {
    return value;
  }
}

function conversationMap(conversations: DirectConversation[]): Map<number, DirectConversation> {
  return conversations.reduce<Map<number, DirectConversation>>((acc, conversation) => {
    acc.set(conversation.participant.id, conversation);
    return acc;
  }, new Map());
}

export function DirectMessagesPage({
  open,
  selectedUserId,
  onSelectUser,
  onClose,
}: DirectMessagesPageProps): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const profile = useFriendsStore((state) => state.profile);
  const friends = useFriendsStore((state) => state.friends);
  const incomingRequests = useFriendsStore((state) => state.incomingRequests);
  const outgoingRequests = useFriendsStore((state) => state.outgoingRequests);
  const conversations = useFriendsStore((state) => state.conversations);
  const messagesByUser = useFriendsStore((state) => state.messagesByUser);
  const initialize = useFriendsStore((state) => state.initialize);
  const sendFriendRequest = useFriendsStore((state) => state.sendFriendRequest);
  const acceptRequest = useFriendsStore((state) => state.acceptRequest);
  const rejectRequest = useFriendsStore((state) => state.rejectRequest);
  const sendMessage = useFriendsStore((state) => state.sendMessage);
  const fetchMessages = useFriendsStore((state) => state.fetchMessages);
  const loading = useFriendsStore((state) => state.loading);
  const storeError = useFriendsStore((state) => state.error);

  const [messageDraft, setMessageDraft] = useState<string>('');
  const [requestLogin, setRequestLogin] = useState<string>('');
  const [actionError, setActionError] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<string | undefined>();
  const [requestPending, setRequestPending] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    void initialize().catch((error) => {
      console.warn('Failed to initialize friends store', error);
    });
  }, [initialize, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (selectedUserId !== null) {
      return;
    }
    if (friends.length > 0) {
      onSelectUser(friends[0].id);
    } else if (conversations.length > 0) {
      onSelectUser(conversations[0].participant.id);
    }
  }, [conversations, friends, onSelectUser, open, selectedUserId]);

  useEffect(() => {
    if (!open) {
      setMessageDraft('');
      setFeedback(undefined);
      setActionError(undefined);
      setRequestLogin('');
      setRequestPending(false);
      setSendingMessage(false);
      return;
    }
    setMessageDraft('');
  }, [open, selectedUserId]);

  useEffect(() => {
    if (!open || selectedUserId === null) {
      return;
    }
    if (messagesByUser[selectedUserId]) {
      return;
    }
    void fetchMessages(selectedUserId).catch((error) => {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.messagesError', { defaultValue: 'Не удалось загрузить сообщения' });
      setActionError(message);
    });
  }, [fetchMessages, messagesByUser, open, selectedUserId, t]);

  const conversationByUser = useMemo(() => conversationMap(conversations), [conversations]);

  const selectedFriend: FriendUser | null = useMemo(() => {
    if (selectedUserId === null) {
      return null;
    }
    const direct = friends.find((friend) => friend.id === selectedUserId);
    if (direct) {
      return direct;
    }
    return conversationByUser.get(selectedUserId)?.participant ?? null;
  }, [conversationByUser, friends, selectedUserId]);

  const messages: DirectMessage[] = selectedUserId ? messagesByUser[selectedUserId] ?? [] : [];

  const recentConversations = useMemo(
    () =>
      conversations.filter(
        (conversation) => !friends.some((friend) => friend.id === conversation.participant.id),
      ),
    [conversations, friends],
  );

  if (!open) {
    return null;
  }

  const handleSelectFriend = (friendId: number) => {
    setActionError(undefined);
    setFeedback(undefined);
    onSelectUser(friendId);
  };

  const handleSendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedUserId || !messageDraft.trim()) {
      return;
    }
    setSendingMessage(true);
    setActionError(undefined);
    try {
      await sendMessage(selectedUserId, messageDraft.trim());
      setMessageDraft('');
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.sendMessageError', { defaultValue: 'Не удалось отправить сообщение' });
      setActionError(message);
    } finally {
      setSendingMessage(false);
    }
  };

  const handleFriendRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!requestLogin.trim()) {
      return;
    }
    setRequestPending(true);
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await sendFriendRequest(requestLogin.trim());
      setRequestLogin('');
      setFeedback(t('profile.requestSent', { defaultValue: 'Запрос отправлен' }));
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.requestError', { defaultValue: 'Не удалось отправить запрос' });
      setActionError(message);
    } finally {
      setRequestPending(false);
    }
  };

  const handleAcceptRequest = async (request: FriendRequest) => {
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await acceptRequest(request.id);
      setFeedback(t('profile.requestAccepted', { defaultValue: 'Запрос принят' }));
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.requestAcceptError', { defaultValue: 'Не удалось принять запрос' });
      setActionError(message);
    }
  };

  const handleRejectRequest = async (request: FriendRequest) => {
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await rejectRequest(request.id);
      setFeedback(t('profile.requestDeclined', { defaultValue: 'Запрос отклонен' }));
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.requestDeclineError', { defaultValue: 'Не удалось отклонить запрос' });
      setActionError(message);
    }
  };

  const closeLabel = t('common.close', { defaultValue: 'Закрыть' });
  const title = t('directMessages.title', { defaultValue: 'Личные сообщения' });

  return (
    <div className="direct-messages-page direct-messages-page--open">
      <div className="direct-messages-backdrop" role="presentation" onClick={onClose} />
      <div className="direct-messages-dialog" role="dialog" aria-modal="true" aria-labelledby="direct-messages-title">
        <header className="direct-messages-header">
          <div>
            <h2 id="direct-messages-title">{title}</h2>
            {feedback && <p className="profile-success">{feedback}</p>}
            {(actionError || storeError) && <p className="profile-error">{actionError ?? storeError}</p>}
          </div>
          <button type="button" className="profile-close-button" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="direct-messages-content">
          <nav className="direct-messages-sidebar" aria-label={t('directMessages.sidebar', { defaultValue: 'Список диалогов' })}>
            <div className="direct-messages-sidebar-group">
              <h3>{t('profile.friends', { defaultValue: 'Друзья' })}</h3>
              {friends.length === 0 ? (
                <p className="profile-empty">{t('profile.friendsEmpty', { defaultValue: 'У вас пока нет друзей' })}</p>
              ) : (
                <ul className="direct-messages-list">
                  {friends.map((friend) => {
                    const conversation = conversationByUser.get(friend.id);
                    const unread = conversation?.unread_count ?? 0;
                    const isActive = friend.id === selectedUserId;
                    return (
                      <li
                        key={friend.id}
                        className={
                          isActive
                            ? 'direct-messages-item direct-messages-item--active'
                            : 'direct-messages-item'
                        }
                      >
                        <button type="button" onClick={() => handleSelectFriend(friend.id)}>
                          <span className="direct-messages-item__title">
                            {friend.display_name ?? friend.login}
                          </span>
                          <span className="direct-messages-item__status">
                            {statusLabel(friend.status, t)}
                          </span>
                          {unread > 0 && (
                            <span className="direct-messages-item__badge" aria-label={t('profile.messages', { defaultValue: 'Сообщения' })}>
                              {unread}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="direct-messages-sidebar-group">
              <h3>{t('directMessages.recent', { defaultValue: 'Последние' })}</h3>
              {recentConversations.length === 0 ? (
                <p className="profile-empty">{t('directMessages.noRecent', { defaultValue: 'Нет недавних диалогов' })}</p>
              ) : (
                <ul className="direct-messages-list">
                  {recentConversations.map((conversation) => {
                    const participant = conversation.participant;
                    const unread = conversation.unread_count;
                    const isActive = participant.id === selectedUserId;
                    return (
                      <li
                        key={conversation.id}
                        className={
                          isActive
                            ? 'direct-messages-item direct-messages-item--active'
                            : 'direct-messages-item'
                        }
                      >
                        <button type="button" onClick={() => handleSelectFriend(participant.id)}>
                          <span className="direct-messages-item__title">
                            {participant.display_name ?? participant.login}
                          </span>
                          <span className="direct-messages-item__status">
                            {statusLabel(participant.status, t)}
                          </span>
                          {conversation.last_message && (
                            <span className="direct-messages-item__preview">
                              {conversation.last_message.content}
                            </span>
                          )}
                          {unread > 0 && (
                            <span className="direct-messages-item__badge" aria-label={t('profile.messages', { defaultValue: 'Сообщения' })}>
                              {unread}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <form className="direct-messages-request" onSubmit={handleFriendRequest}>
              <label htmlFor="direct-messages-request-input">
                {t('profile.addFriend', { defaultValue: 'Добавить друга по логину' })}
              </label>
              <div className="profile-actions">
                <input
                  id="direct-messages-request-input"
                  type="text"
                  value={requestLogin}
                  onChange={(event) => setRequestLogin(event.target.value)}
                  placeholder={t('profile.loginPlaceholder', { defaultValue: 'Логин пользователя' })}
                />
                <button type="submit" className="primary" disabled={requestPending}>
                  {requestPending
                    ? t('common.sending', { defaultValue: 'Отправка…' })
                    : t('profile.sendRequest', { defaultValue: 'Отправить' })}
                </button>
              </div>
            </form>
          </nav>
          <section className="direct-messages-thread">
            {selectedFriend ? (
              <>
                <div className="direct-messages-thread__header">
                  <div className="direct-messages-thread__user">
                    <div className="presence-avatar" aria-hidden="true">
                      <span>
                        {(selectedFriend.display_name || selectedFriend.login || '?')
                          .charAt(0)
                          .toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <div className="direct-messages-thread__title">
                        {selectedFriend.display_name ?? selectedFriend.login}
                      </div>
                      <div className="direct-messages-thread__status">
                        {statusLabel(selectedFriend.status, t)}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="direct-messages-thread__messages" aria-live="polite">
                  {messages.length === 0 ? (
                    <p className="profile-empty">
                      {t('profile.messagesEmpty', { defaultValue: 'Пока нет сообщений' })}
                    </p>
                  ) : (
                    messages.map((message) => (
                      <div
                        key={message.id}
                        className={
                          message.sender_id === profile?.id
                            ? 'profile-chat-message profile-chat-message--outgoing'
                            : 'profile-chat-message'
                        }
                      >
                        <div className="profile-chat-message__meta">
                          <span>{message.sender.display_name ?? message.sender.login}</span>
                          <span>• {formatTime(message.created_at, i18n.language)}</span>
                        </div>
                        <div className="profile-chat-message__body">{message.content}</div>
                      </div>
                    ))
                  )}
                </div>
                <form className="direct-messages-composer" onSubmit={handleSendMessage}>
                  <textarea
                    value={messageDraft}
                    onChange={(event) => setMessageDraft(event.target.value)}
                    placeholder={t('profile.messagePlaceholder', {
                      defaultValue: 'Напишите сообщение…',
                    })}
                  />
                  <button type="submit" className="primary" disabled={sendingMessage}>
                    {sendingMessage
                      ? t('common.sending', { defaultValue: 'Отправка…' })
                      : t('profile.send', { defaultValue: 'Отправить' })}
                  </button>
                </form>
              </>
            ) : (
              <div className="direct-messages-thread__empty">
                <p>{t('profile.selectFriend', { defaultValue: 'Выберите друга, чтобы начать переписку' })}</p>
              </div>
            )}
          </section>
          <aside className="direct-messages-meta">
            <div className="direct-messages-meta__section">
              <h3>{t('profile.requests', { defaultValue: 'Запросы' })}</h3>
              <div className="profile-requests">
                <div>
                  <h4>{t('profile.incoming', { defaultValue: 'Входящие' })}</h4>
                  {incomingRequests.length === 0 ? (
                    <p className="profile-empty">
                      {t('profile.incomingEmpty', { defaultValue: 'Нет входящих запросов' })}
                    </p>
                  ) : (
                    <ul className="profile-request-list">
                      {incomingRequests.map((request) => (
                        <li key={request.id} className="profile-request-item">
                          <div className="profile-request-text">
                            <strong>
                              {request.requester.display_name ?? request.requester.login}
                            </strong>
                            <span>{statusLabel(request.requester.status, t)}</span>
                          </div>
                          <div className="profile-request-actions">
                            <button type="button" className="primary" onClick={() => handleAcceptRequest(request)}>
                              {t('profile.accept', { defaultValue: 'Принять' })}
                            </button>
                            <button type="button" className="ghost" onClick={() => handleRejectRequest(request)}>
                              {t('profile.decline', { defaultValue: 'Отклонить' })}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h4>{t('profile.outgoing', { defaultValue: 'Исходящие' })}</h4>
                  {outgoingRequests.length === 0 ? (
                    <p className="profile-empty">
                      {t('profile.outgoingEmpty', { defaultValue: 'Нет исходящих запросов' })}
                    </p>
                  ) : (
                    <ul className="profile-request-list">
                      {outgoingRequests.map((request) => (
                        <li key={request.id} className="profile-request-item">
                          <div className="profile-request-text">
                            <strong>
                              {request.addressee.display_name ?? request.addressee.login}
                            </strong>
                            <span>{statusLabel(request.addressee.status, t)}</span>
                          </div>
                          <span className="profile-request-note">
                            {t('profile.pending', { defaultValue: 'Ожидает подтверждения' })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
        {loading && (
          <div className="profile-loading-overlay">{t('common.loading', { defaultValue: 'Загрузка…' })}</div>
        )}
      </div>
    </div>
  );
}
