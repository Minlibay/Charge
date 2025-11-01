import { useEffect, useState } from 'react';

import type { DirectConversation, DirectMessage, PresenceStatus } from '../../types';
import { PresenceIndicator } from '../notifications/PresenceIndicator';

interface DirectConversationPanelProps {
  conversation: DirectConversation | null;
  messages: DirectMessage[];
  currentUserId: number | null;
  sending: boolean;
  onSendMessage: (content: string) => Promise<void>;
  onUpdateNote: (note: string | null) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function statusLabel(status: PresenceStatus, t: DirectConversationPanelProps['t']): string {
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
    }).format(new Date(value));
  } catch (error) {
    return value;
  }
}

export function DirectConversationPanel({
  conversation,
  messages,
  currentUserId,
  sending,
  onSendMessage,
  onUpdateNote,
  t,
}: DirectConversationPanelProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const locale = typeof window !== 'undefined' ? window.navigator.language : 'ru-RU';

  if (!conversation) {
    return (
      <section className="direct-panel empty">
        <p>{t('direct.noConversationSelected', { defaultValue: 'Выберите беседу, чтобы просмотреть сообщения' })}</p>
      </section>
    );
  }

  const membership = conversation.participants.find((participant) => participant.user.id === currentUserId) ?? null;
  useEffect(() => {
    setNoteDraft(membership?.note ?? '');
  }, [membership?.note, conversation.id]);
  const conversationTitle = conversation.title
    ? conversation.title
    : conversation.participants
        .filter((participant) => participant.user.id !== currentUserId)
        .map((participant) => participant.user.display_name ?? participant.user.login)
        .join(', ');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }
    await onSendMessage(trimmed);
    setDraft('');
  };

  const handleSubmitNote = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNoteSaving(true);
    try {
      await onUpdateNote(noteDraft.trim() ? noteDraft.trim() : null);
    } finally {
      setNoteSaving(false);
    }
  };

  const participants = conversation.participants.filter((participant) => participant.user.id !== currentUserId);

  return (
    <section className="direct-panel">
      <header className="direct-panel-header">
        <h2>{conversationTitle || t('direct.unknownConversation', { defaultValue: 'Без названия' })}</h2>
        <div className="direct-panel-participants">
          {participants.map((participant) => (
            <div key={participant.user.id} className="presence-row">
              <PresenceIndicator
                status={participant.user.status}
                label={statusLabel(participant.user.status, t)}
              />
              <span className="presence-label">
                {participant.user.display_name ?? participant.user.login} •{' '}
                {statusLabel(participant.user.status, t)}
              </span>
            </div>
          ))}
          {participants.length === 0 ? (
            <p className="hint">{t('direct.onlyYou', { defaultValue: 'В беседе пока только вы' })}</p>
          ) : null}
        </div>
        <form onSubmit={handleSubmitNote} className="direct-note-form">
          <label>
            {t('direct.note.label', { defaultValue: 'Личная заметка' })}
            <textarea
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder={t('direct.note.placeholder', { defaultValue: 'Добавьте заметку, видимую только вам' })}
            />
          </label>
          <button type="submit" disabled={noteSaving}>
            {noteSaving
              ? t('direct.note.saving', { defaultValue: 'Сохранение…' })
              : t('direct.note.save', { defaultValue: 'Сохранить' })}
          </button>
        </form>
      </header>
      <div className="direct-messages">
        <ul>
          {messages.map((message) => (
            <li key={message.id} className={message.sender_id === currentUserId ? 'self' : undefined}>
              <div className="author">{message.sender.display_name ?? message.sender.login}</div>
              <div className="content">{message.content}</div>
              <time dateTime={message.created_at}>{formatTime(message.created_at, locale)}</time>
            </li>
          ))}
          {messages.length === 0 ? (
            <li className="empty">{t('direct.noMessages', { defaultValue: 'Сообщений еще нет' })}</li>
          ) : null}
        </ul>
      </div>
      <form className="direct-composer" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('direct.message.placeholder', { defaultValue: 'Напишите сообщение…' })}
          disabled={sending}
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          {sending
            ? t('direct.message.sending', { defaultValue: 'Отправка…' })
            : t('direct.message.send', { defaultValue: 'Отправить' })}
        </button>
      </form>
      <footer className="direct-panel-footer">
        <small>
          {t('direct.participantCount', {
            defaultValue: '{{count}} участников',
            count: conversation.participants.length,
          })}
        </small>
      </footer>
    </section>
  );
}
