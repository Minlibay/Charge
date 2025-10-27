import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/api';
import { useFriendsStore } from '../../state/friendsStore';
import type { DirectConversation, DirectMessage, FriendRequest, FriendUser, PresenceStatus } from '../../types';

interface ProfilePageProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_OPTIONS: PresenceStatus[] = ['online', 'idle', 'dnd'];

function statusLabel(status: PresenceStatus, t: (key: string, options?: Record<string, unknown>) => string): string {
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

export function ProfilePage({ open, onClose }: ProfilePageProps): JSX.Element | null {
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
  const updateProfile = useFriendsStore((state) => state.updateProfile);
  const uploadAvatar = useFriendsStore((state) => state.uploadAvatar);
  const loading = useFriendsStore((state) => state.loading);
  const storeError = useFriendsStore((state) => state.error);

  const [displayName, setDisplayName] = useState<string>('');
  const [status, setStatus] = useState<PresenceStatus>('online');
  const [requestLogin, setRequestLogin] = useState<string>('');
  const [selectedFriendId, setSelectedFriendId] = useState<number | null>(null);
  const [messageDraft, setMessageDraft] = useState<string>('');
  const [actionError, setActionError] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<string | undefined>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    void initialize().catch((error) => {
      console.warn('Failed to initialize friends store', error);
    });
  }, [initialize, open]);

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name ?? '');
      setStatus(profile.status);
    }
  }, [profile]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (selectedFriendId !== null) {
      return;
    }
    if (friends.length > 0) {
      setSelectedFriendId(friends[0].id);
    } else if (conversations.length > 0) {
      setSelectedFriendId(conversations[0].participant.id);
    }
  }, [conversations, friends, open, selectedFriendId]);

  const conversationByUser = useMemo(() => conversationMap(conversations), [conversations]);

  const selectedFriend: FriendUser | null = useMemo(() => {
    if (selectedFriendId === null) {
      return null;
    }
    const direct = friends.find((friend) => friend.id === selectedFriendId);
    if (direct) {
      return direct;
    }
    return conversationByUser.get(selectedFriendId)?.participant ?? null;
  }, [conversationByUser, friends, selectedFriendId]);

  const messages: DirectMessage[] = selectedFriendId ? messagesByUser[selectedFriendId] ?? [] : [];

  if (!open) {
    return null;
  }

  const closeLabel = t('common.close', { defaultValue: 'Закрыть' });
  const profileTitle = t('profile.title', { defaultValue: 'Профиль и друзья' });

  const handleProfileSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile) {
      return;
    }
    setSavingProfile(true);
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await updateProfile({ display_name: displayName.trim() || null, status });
      setFeedback(t('profile.saved', { defaultValue: 'Профиль обновлен' }));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('profile.saveError', { defaultValue: 'Не удалось обновить профиль' });
      setActionError(message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setAvatarUploading(true);
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await uploadAvatar(file);
      setFeedback(t('profile.avatarUpdated', { defaultValue: 'Аватар обновлен' }));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('profile.avatarError', { defaultValue: 'Не удалось обновить аватар' });
      setActionError(message);
    } finally {
      setAvatarUploading(false);
      event.target.value = '';
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
      const message = error instanceof ApiError ? error.message : t('profile.requestError', { defaultValue: 'Не удалось отправить запрос' });
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
      const message = error instanceof ApiError ? error.message : t('profile.requestAcceptError', { defaultValue: 'Не удалось принять запрос' });
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
      const message = error instanceof ApiError ? error.message : t('profile.requestDeclineError', { defaultValue: 'Не удалось отклонить запрос' });
      setActionError(message);
    }
  };

  const handleSelectFriend = (friendId: number) => {
    setSelectedFriendId(friendId);
    if (!messagesByUser[friendId]) {
      void fetchMessages(friendId).catch((error) => {
        const message = error instanceof ApiError ? error.message : t('profile.messagesError', { defaultValue: 'Не удалось загрузить сообщения' });
        setActionError(message);
      });
    }
  };

  const handleSendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedFriendId || !messageDraft.trim()) {
      return;
    }
    setSendingMessage(true);
    setActionError(undefined);
    setFeedback(undefined);
    try {
      await sendMessage(selectedFriendId, messageDraft.trim());
      setMessageDraft('');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('profile.sendMessageError', { defaultValue: 'Не удалось отправить сообщение' });
      setActionError(message);
    } finally {
      setSendingMessage(false);
    }
  };

  return (
    <div className="profile-page profile-page--open">
      <div className="profile-backdrop" role="presentation" onClick={onClose} />
      <div className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <header className="profile-header">
          <div>
            <h2 id="profile-title">{profileTitle}</h2>
            {feedback && <p className="profile-success">{feedback}</p>}
            {(actionError || storeError) && <p className="profile-error">{actionError ?? storeError}</p>}
          </div>
          <button type="button" className="profile-close-button" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="profile-content">
          <section className="profile-section">
            <form className="profile-form" onSubmit={handleProfileSubmit}>
              <div className="profile-row">
                <label htmlFor="profile-display-name">{t('profile.displayName', { defaultValue: 'Отображаемое имя' })}</label>
                <input
                  id="profile-display-name"
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={profile?.login ?? ''}
                />
              </div>
              <div className="profile-row">
                <label htmlFor="profile-status">{t('profile.status', { defaultValue: 'Статус' })}</label>
                <select
                  id="profile-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as PresenceStatus)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {statusLabel(option, t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="profile-actions">
                <button type="submit" className="primary" disabled={savingProfile}>
                  {savingProfile ? t('common.saving', { defaultValue: 'Сохранение…' }) : t('common.save', { defaultValue: 'Сохранить' })}
                </button>
              </div>
            </form>
          </section>

          <section className="profile-section">
            <div className="profile-avatar-preview">
              {profile?.avatar_url ? (
                <img src={profile.avatar_url} alt={t('profile.avatarAlt', { defaultValue: 'Аватар пользователя' })} />
              ) : (
                <div className="presence-avatar" aria-hidden="true">
                  <span>{(profile?.display_name || profile?.login || '?').charAt(0).toUpperCase()}</span>
                </div>
              )}
              <div className="profile-row">
                <label htmlFor="profile-avatar">{t('profile.avatar', { defaultValue: 'Аватар' })}</label>
                <input
                  id="profile-avatar"
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarChange}
                  disabled={avatarUploading}
                />
                {avatarUploading && <span className="profile-info">{t('profile.avatarUploading', { defaultValue: 'Загрузка…' })}</span>}
              </div>
            </div>
          </section>

          <section className="profile-grid">
            <div className="profile-card">
              <h3>{t('profile.friends', { defaultValue: 'Друзья' })}</h3>
              {friends.length === 0 ? (
                <p className="profile-empty">{t('profile.friendsEmpty', { defaultValue: 'У вас пока нет друзей' })}</p>
              ) : (
                <ul className="profile-friends-list">
                  {friends.map((friend) => {
                    const conversation = conversationByUser.get(friend.id);
                    const unread = conversation?.unread_count ?? 0;
                    return (
                      <li
                        key={friend.id}
                        className={friend.id === selectedFriendId ? 'profile-friend profile-friend--active' : 'profile-friend'}
                      >
                        <div className="profile-friend__meta">
                          <div className="profile-friend__title">{friend.display_name ?? friend.login}</div>
                          <div className="profile-friend__status">{statusLabel(friend.status, t)}</div>
                        </div>
                        {unread > 0 && <span className="profile-friend__badge">{unread}</span>}
                        <button type="button" className="ghost" onClick={() => handleSelectFriend(friend.id)}>
                          {t('profile.openChat', { defaultValue: 'Чат' })}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <form className="profile-row" onSubmit={handleFriendRequest}>
                <label htmlFor="profile-request">{t('profile.addFriend', { defaultValue: 'Добавить друга по логину' })}</label>
                <div className="profile-actions">
                  <input
                    id="profile-request"
                    type="text"
                    value={requestLogin}
                    onChange={(event) => setRequestLogin(event.target.value)}
                    placeholder={t('profile.loginPlaceholder', { defaultValue: 'Логин пользователя' })}
                  />
                  <button type="submit" className="primary" disabled={requestPending}>
                    {requestPending ? t('common.sending', { defaultValue: 'Отправка…' }) : t('profile.sendRequest', { defaultValue: 'Отправить' })}
                  </button>
                </div>
              </form>
            </div>

            <div className="profile-card">
              <h3>{t('profile.requests', { defaultValue: 'Запросы' })}</h3>
              <div className="profile-requests">
                <div>
                  <h4>{t('profile.incoming', { defaultValue: 'Входящие' })}</h4>
                  {incomingRequests.length === 0 ? (
                    <p className="profile-empty">{t('profile.incomingEmpty', { defaultValue: 'Нет входящих запросов' })}</p>
                  ) : (
                    <ul className="profile-request-list">
                      {incomingRequests.map((request) => (
                        <li key={request.id} className="profile-request-item">
                          <div className="profile-request-text">
                            <strong>{request.requester.display_name ?? request.requester.login}</strong>
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
                    <p className="profile-empty">{t('profile.outgoingEmpty', { defaultValue: 'Нет исходящих запросов' })}</p>
                  ) : (
                    <ul className="profile-request-list">
                      {outgoingRequests.map((request) => (
                        <li key={request.id} className="profile-request-item">
                          <div className="profile-request-text">
                            <strong>{request.addressee.display_name ?? request.addressee.login}</strong>
                            <span>{statusLabel(request.addressee.status, t)}</span>
                          </div>
                          <span className="profile-request-note">{t('profile.pending', { defaultValue: 'Ожидает подтверждения' })}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            <div className="profile-card profile-chat">
              <h3>{t('profile.messages', { defaultValue: 'Сообщения' })}</h3>
              {selectedFriend ? (
                <>
                  <div className="profile-chat-header">
                    <div className="profile-friend__title">{selectedFriend.display_name ?? selectedFriend.login}</div>
                    <div className="profile-friend__status">{statusLabel(selectedFriend.status, t)}</div>
                  </div>
                  <div className="profile-chat-messages" aria-live="polite">
                    {messages.length === 0 ? (
                      <p className="profile-empty">{t('profile.messagesEmpty', { defaultValue: 'Пока нет сообщений' })}</p>
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
                  <form className="profile-chat-form" onSubmit={handleSendMessage}>
                    <textarea
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      placeholder={t('profile.messagePlaceholder', { defaultValue: 'Напишите сообщение…' })}
                    />
                    <button type="submit" className="primary" disabled={sendingMessage}>
                      {sendingMessage ? t('common.sending', { defaultValue: 'Отправка…' }) : t('profile.send', { defaultValue: 'Отправить' })}
                    </button>
                  </form>
                </>
              ) : (
                <p className="profile-empty">{t('profile.selectFriend', { defaultValue: 'Выберите друга, чтобы начать переписку' })}</p>
              )}
            </div>
          </section>
        </div>
        {loading && <div className="profile-loading-overlay">{t('common.loading')}</div>}
      </div>
    </div>
  );
}
