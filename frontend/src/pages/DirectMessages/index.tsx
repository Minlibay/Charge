import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DirectConversationPanel } from '../../components/direct/DirectConversationPanel';
import { DirectSidebar } from '../../components/direct/DirectSidebar';
import { ApiError } from '../../services/api';
import { useDirectStore } from '../../stores/directStore';
import type { DirectConversationCreatePayload, FriendRequest } from '../../types';

interface DirectMessagesPageProps {
  open: boolean;
  selectedConversationId: number | null;
  onSelectConversation: (conversationId: number | null) => void;
  onClose: () => void;
}

export function DirectMessagesPage({
  open,
  selectedConversationId,
  onSelectConversation,
  onClose,
}: DirectMessagesPageProps): JSX.Element | null {
  const { t } = useTranslation();
  const profile = useDirectStore((state) => state.profile);
  const friends = useDirectStore((state) => state.friends);
  const incomingRequests = useDirectStore((state) => state.incomingRequests);
  const outgoingRequests = useDirectStore((state) => state.outgoingRequests);
  const conversations = useDirectStore((state) => state.conversations);
  const messagesByConversation = useDirectStore((state) => state.messagesByConversation);
  const initialize = useDirectStore((state) => state.initialize);
  const refreshRequests = useDirectStore((state) => state.refreshRequests);
  const createConversation = useDirectStore((state) => state.createConversation);
  const fetchMessages = useDirectStore((state) => state.fetchMessages);
  const sendMessage = useDirectStore((state) => state.sendMessage);
  const updateNote = useDirectStore((state) => state.updateNote);
  const sendFriendRequest = useDirectStore((state) => state.sendFriendRequest);
  const acceptRequest = useDirectStore((state) => state.acceptRequest);
  const rejectRequest = useDirectStore((state) => state.rejectRequest);
  const loading = useDirectStore((state) => state.loading);
  const storeError = useDirectStore((state) => state.error);

  const [requestLogin, setRequestLogin] = useState('');
  const [requestPending, setRequestPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    void initialize().catch((error) => {
      console.warn('Failed to initialize direct store', error);
    });
  }, [initialize, open]);

  const conversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] ?? [] : [];

  useEffect(() => {
    if (!open) {
      return;
    }
    if (selectedConversationId === null && conversations.length > 0) {
      onSelectConversation(conversations[0].id);
    }
  }, [conversations, onSelectConversation, open, selectedConversationId]);

  useEffect(() => {
    if (!open || selectedConversationId === null) {
      return;
    }
    if (messagesByConversation[selectedConversationId]) {
      return;
    }
    void fetchMessages(selectedConversationId).catch((error) => {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.messagesError', { defaultValue: 'Не удалось загрузить сообщения' });
      setActionError(message);
    });
  }, [fetchMessages, messagesByConversation, open, selectedConversationId, t]);

  useEffect(() => {
    if (!open) {
      setRequestLogin('');
      setActionError(null);
      setFeedback(null);
      setRequestPending(false);
      setSendingMessage(false);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const handleSendMessage = async (content: string) => {
    if (!selectedConversationId) {
      return;
    }
    setSendingMessage(true);
    setActionError(null);
    try {
      await sendMessage(selectedConversationId, content);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.messageError', { defaultValue: 'Не удалось отправить сообщение' });
      setActionError(message);
    } finally {
      setSendingMessage(false);
    }
  };

  const handleUpdateNote = async (note: string | null) => {
    if (!selectedConversationId) {
      return;
    }
    try {
      await updateNote(selectedConversationId, note);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.note.error', { defaultValue: 'Не удалось сохранить заметку' });
      setActionError(message);
    }
  };

  const handleStartDirectConversation = async (friendId: number) => {
    try {
      const conversation = await createConversation({ participant_ids: [friendId] });
      onSelectConversation(conversation.id);
      void fetchMessages(conversation.id);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.createConversationError', { defaultValue: 'Не удалось открыть диалог' });
      setActionError(message);
    }
  };

  const handleCreateGroup = async (payload: DirectConversationCreatePayload) => {
    try {
      const conversation = await createConversation(payload);
      onSelectConversation(conversation.id);
      void fetchMessages(conversation.id);
      setFeedback(t('direct.group.created', { defaultValue: 'Групповой чат создан' }));
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.createConversationError', { defaultValue: 'Не удалось создать чат' });
      setActionError(message);
    }
  };

  const handleFriendRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!requestLogin.trim()) {
      return;
    }
    setRequestPending(true);
    setActionError(null);
    setFeedback(null);
    try {
      await sendFriendRequest(requestLogin.trim());
      setRequestLogin('');
      setFeedback(t('direct.requestSent', { defaultValue: 'Запрос отправлен' }));
      void refreshRequests();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.requestError', { defaultValue: 'Не удалось отправить запрос' });
      setActionError(message);
    } finally {
      setRequestPending(false);
    }
  };

  const handleAcceptRequest = async (request: FriendRequest) => {
    setActionError(null);
    try {
      await acceptRequest(request.id);
      setFeedback(
        t('direct.requestAccepted', {
          defaultValue: 'Запрос от {{login}} принят',
          login: request.requester.display_name ?? request.requester.login,
        }),
      );
      void refreshRequests();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.requestAcceptError', { defaultValue: 'Не удалось принять запрос' });
      setActionError(message);
    }
  };

  const handleRejectRequest = async (request: FriendRequest) => {
    setActionError(null);
    try {
      await rejectRequest(request.id);
      setFeedback(
        t('direct.requestRejected', {
          defaultValue: 'Запрос от {{login}} отклонен',
          login: request.requester.display_name ?? request.requester.login,
        }),
      );
      void refreshRequests();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('direct.requestRejectError', { defaultValue: 'Не удалось отклонить запрос' });
      setActionError(message);
    }
  };

  const handleClose = () => {
    onSelectConversation(null);
    onClose();
  };

  const pageClassName = clsx('direct-messages-page', { 'direct-messages-page--open': open });

  return (
    <div className={pageClassName} role="presentation">
      <div className="direct-messages-backdrop" aria-hidden="true" onClick={handleClose} />
      <div
        className="direct-messages-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="direct-messages-title"
      >
        <header className="direct-messages-header">
          <h1 id="direct-messages-title">{t('direct.title', { defaultValue: 'Прямые сообщения' })}</h1>
          <button type="button" className="ghost" onClick={handleClose}>
            {t('common.close', { defaultValue: 'Закрыть' })}
          </button>
        </header>
        <div className="direct-messages-content">
          <div className="direct-messages-sidebar">
            <DirectSidebar
              conversations={conversations}
              friends={friends}
              currentUserId={profile?.id ?? null}
              activeConversationId={selectedConversationId}
              onSelectConversation={(conversationId) => onSelectConversation(conversationId)}
              onStartDirectConversation={handleStartDirectConversation}
              onCreateGroup={handleCreateGroup}
              t={t}
            />
          </div>
          <main className="direct-messages-thread-container">
            {loading && !conversation ? (
              <p className="hint">{t('direct.loading', { defaultValue: 'Загрузка…' })}</p>
            ) : null}
            {storeError ? <p className="error">{storeError}</p> : null}
            {actionError ? <p className="error">{actionError}</p> : null}
            {feedback ? <p className="feedback">{feedback}</p> : null}
            <DirectConversationPanel
              conversation={conversation}
              messages={messages}
              currentUserId={profile?.id ?? null}
              sending={sendingMessage}
              onSendMessage={handleSendMessage}
              onUpdateNote={handleUpdateNote}
              t={t}
            />
          </main>
          <aside className="direct-messages-meta">
            <section className="direct-messages-meta__section">
              <h2>{t('direct.requests.title', { defaultValue: 'Заявки в друзья' })}</h2>
              <form onSubmit={handleFriendRequest} className="direct-request-form">
                <label htmlFor="direct-request-login">
                  {t('direct.requests.login', { defaultValue: 'Логин пользователя' })}
                </label>
                <input
                  id="direct-request-login"
                  type="text"
                  value={requestLogin}
                  onChange={(event) => setRequestLogin(event.target.value)}
                  placeholder={t('direct.requests.placeholder', { defaultValue: 'Введите логин' })}
                />
                <button type="submit" disabled={requestPending}>
                  {requestPending
                    ? t('direct.requests.sending', { defaultValue: 'Отправка…' })
                    : t('direct.requests.submit', { defaultValue: 'Отправить запрос' })}
                </button>
              </form>
            </section>
            <section className="direct-messages-meta__section">
              <h3>{t('direct.requests.incoming', { defaultValue: 'Входящие' })}</h3>
              <ul className="direct-requests-list">
                {incomingRequests.map((request) => (
                  <li key={request.id}>
                    <span>{request.requester.display_name ?? request.requester.login}</span>
                    <div className="actions">
                      <button type="button" onClick={() => handleAcceptRequest(request)}>
                        {t('direct.requests.accept', { defaultValue: 'Принять' })}
                      </button>
                      <button type="button" onClick={() => handleRejectRequest(request)}>
                        {t('direct.requests.reject', { defaultValue: 'Отклонить' })}
                      </button>
                    </div>
                  </li>
                ))}
                {incomingRequests.length === 0 ? (
                  <li className="empty">{t('direct.requests.none', { defaultValue: 'Нет входящих заявок' })}</li>
                ) : null}
              </ul>
            </section>
            <section className="direct-messages-meta__section">
              <h3>{t('direct.requests.outgoing', { defaultValue: 'Исходящие' })}</h3>
              <ul className="direct-requests-list">
                {outgoingRequests.map((request) => (
                  <li key={request.id}>
                    <span>{request.addressee.display_name ?? request.addressee.login}</span>
                  </li>
                ))}
                {outgoingRequests.length === 0 ? (
                  <li className="empty">{t('direct.requests.noneOutgoing', { defaultValue: 'Нет исходящих заявок' })}</li>
                ) : null}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
