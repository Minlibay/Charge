import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  Message,
  MessageAttachment,
  MessageReactionSummary,
  RoomMemberSummary,
  RoomRole,
} from '../types';
import { formatDateTime } from '../utils/format';

interface MessageListProps {
  messages: Message[];
  members: RoomMemberSummary[];
  currentUserId: number | null;
  currentRole: RoomRole | null;
  onReply: (message: Message) => void;
  onOpenThread?: (message: Message) => void;
  onEditMessage: (message: Message, content: string) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
  onModerateMessage: (message: Message, action: 'suppress' | 'restore', note?: string) => Promise<void>;
  context?: 'channel' | 'thread';
  replyingToId?: number | null;
  activeThreadRootId?: number | null;
}

const FALLBACK_AVATARS = ['#F97316', '#8B5CF6', '#3B82F6', '#EC4899', '#22C55E', '#F59E0B'];

function getDisplayName(message: Message): string {
  if (message.author?.display_name) {
    return message.author.display_name;
  }
  if (message.author?.login) {
    return message.author.login;
  }
  if (message.author_id != null) {
    return `User #${message.author_id}`;
  }
  return 'System';
}

function getAvatarLetter(message: Message): string {
  const name = getDisplayName(message);
  return name.charAt(0).toUpperCase();
}

function avatarColor(authorId: number | null): string {
  if (authorId == null) {
    return FALLBACK_AVATARS[0];
  }
  const index = Math.abs(authorId) % FALLBACK_AVATARS.length;
  return FALLBACK_AVATARS[index];
}

function buildMentionLookup(members: RoomMemberSummary[]): Map<string, RoomMemberSummary> {
  const map = new Map<string, RoomMemberSummary>();
  members.forEach((member) => {
    map.set(member.login.toLowerCase(), member);
  });
  return map;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkify(text: string): string {
  return text.replace(/(^|[\s(])(https?:\/\/[^\s<]+)(?=$|[\s).,!?])/g, (_match, prefix: string, url: string) => {
    return `${prefix}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;
  });
}

function applyFormatting(text: string): string {
  let formatted = text;
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');
  formatted = formatted.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  formatted = formatted.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');
  formatted = formatted.replace(/`(.+?)`/g, '<code>$1</code>');
  formatted = formatted.replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return formatted;
}

function formatMentions(
  text: string,
  lookup: Map<string, RoomMemberSummary>,
  currentUserId: number | null,
): string {
  return text.replace(/(^|[\s>])@([a-zA-Z0-9_.-]+)/g, (match, prefix: string, slug: string) => {
    const entry = lookup.get(slug.toLowerCase());
    if (!entry) {
      return match;
    }
    const isSelf = currentUserId != null && currentUserId === entry.user_id;
    const className = isSelf ? 'message__mention message__mention--self' : 'message__mention';
    return `${prefix}<span class="${className}" data-user-id="${entry.user_id}">@${slug}</span>`;
  });
}

function renderFormattedContent(
  content: string,
  lookup: Map<string, RoomMemberSummary>,
  currentUserId: number | null,
): string {
  const escaped = escapeHtml(content).replace(/\r\n/g, '\n');
  const withFormatting = applyFormatting(escaped);
  const withLinks = linkify(withFormatting);
  const withMentions = formatMentions(withLinks, lookup, currentUserId);
  return withMentions.replace(/\n/g, '<br />');
}

function formatParentExcerpt(parent: Message | undefined): string {
  if (!parent) {
    return '';
  }
  const content = parent.content.trim();
  if (!content) {
    return '…';
  }
  return content.length > 80 ? `${content.slice(0, 77)}…` : content;
}

function AttachmentPreview({ attachment }: { attachment: MessageAttachment }): JSX.Element {
  if (attachment.preview_url) {
    return (
      <a href={attachment.download_url} target="_blank" rel="noreferrer" className="message__attachment message__attachment--preview">
        <img src={attachment.preview_url} alt={attachment.file_name} />
        <span>{attachment.file_name}</span>
      </a>
    );
  }
  return (
    <a href={attachment.download_url} target="_blank" rel="noreferrer" className="message__attachment">
      <span className="message__attachment-icon" aria-hidden="true">📎</span>
      <span>{attachment.file_name}</span>
    </a>
  );
}

function Reactions({ reactions }: { reactions: MessageReactionSummary[] }): JSX.Element | null {
  if (reactions.length === 0) {
    return null;
  }
  return (
    <ul className="message__reactions" aria-label="Reactions">
      {reactions.map((reaction) => (
        <li key={reaction.emoji} className={clsx('message__reaction', { 'message__reaction--reacted': reaction.reacted })}>
          <span>{reaction.emoji}</span>
          <span className="message__reaction-count">{reaction.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function MessageList({
  messages,
  members,
  currentUserId,
  currentRole,
  onReply,
  onOpenThread,
  onEditMessage,
  onDeleteMessage,
  onModerateMessage,
  context = 'channel',
  replyingToId,
  activeThreadRootId,
}: MessageListProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [pendingMessageId, setPendingMessageId] = useState<number | null>(null);

  const mentionLookup = useMemo(() => buildMentionLookup(members), [members]);
  const messageMap = useMemo(() => {
    const map = new Map<number, Message>();
    messages.forEach((message) => {
      map.set(message.id, message);
    });
    return map;
  }, [messages]);

  const isAdmin = currentRole === 'owner' || currentRole === 'admin';

  const handleStartEdit = (message: Message) => {
    if (message.deleted_at) {
      return;
    }
    setEditingId(message.id);
    setEditValue(message.content);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  const handleSaveEdit = async (message: Message) => {
    if (!editValue.trim()) {
      return;
    }
    setEditLoading(true);
    try {
      await onEditMessage(message, editValue.trimEnd());
      setEditingId(null);
      setEditValue('');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async (message: Message) => {
    const confirmed = window.confirm(t('chat.deleteConfirm', { defaultValue: 'Удалить сообщение?' }));
    if (!confirmed) {
      return;
    }
    setPendingMessageId(message.id);
    try {
      await onDeleteMessage(message);
    } finally {
      setPendingMessageId(null);
    }
  };

  const handleModerate = async (message: Message) => {
    setPendingMessageId(message.id);
    try {
      if (message.moderated_at) {
        await onModerateMessage(message, 'restore');
      } else {
        const note = window.prompt(t('chat.moderatePrompt', { defaultValue: 'Причина модерации (необязательно)' }), message.moderation_note ?? '') ?? undefined;
        await onModerateMessage(message, 'suppress', note);
      }
    } finally {
      setPendingMessageId(null);
    }
  };

  const renderContent = (message: Message) => {
    if (message.deleted_at) {
      return <p className="message__deleted">{t('chat.messageDeleted', { defaultValue: 'Сообщение удалено' })}</p>;
    }
    const formatted = renderFormattedContent(message.content, mentionLookup, currentUserId);
    return <div className="message__content" dangerouslySetInnerHTML={{ __html: formatted }} />;
  };

  return (
    <div className={clsx('message-list', { 'message-list--thread': context === 'thread' })}>
      {messages.map((message) => {
        const name = getDisplayName(message);
        const timestamp = formatDateTime(message.created_at, i18n.language);
        const parent = message.parent_id ? messageMap.get(message.parent_id) : undefined;
        const rootId = message.thread_root_id ?? message.id;
        const rootMessage = messageMap.get(rootId) ?? message;
        const canEdit = message.author_id === currentUserId && !message.deleted_at;
        const canDelete = !message.deleted_at && (message.author_id === currentUserId || isAdmin);
        const canModerate = isAdmin && !message.deleted_at;
        const isEditing = editingId === message.id;
        const isPending = pendingMessageId === message.id;
        const isReplyHighlight = replyingToId != null && replyingToId === message.id;
        const isThreadRoot = activeThreadRootId != null && activeThreadRootId === message.id;
        const avatarBg = avatarColor(message.author_id ?? null);

        return (
          <article
            key={message.id}
            className={clsx('message', {
              'message--deleted': Boolean(message.deleted_at),
              'message--reply-target': isReplyHighlight,
              'message--thread-root': isThreadRoot,
            })}
            aria-label={name}
          >
            <div className="message__avatar" style={{ backgroundColor: avatarBg }} aria-hidden="true">
              {getAvatarLetter(message)}
            </div>
            <div className="message__body">
              <header className="message__header">
                <div className="message__header-left">
                  <span className="message__author">{name}</span>
                  <time dateTime={message.created_at} className="message__timestamp">
                    {timestamp}
                  </time>
                  {message.edited_at && !message.deleted_at && (
                    <span className="message__badge">{t('chat.edited', { defaultValue: 'изменено' })}</span>
                  )}
                  {message.moderated_at && (
                    <span className="message__badge message__badge--warning">
                      {t('chat.moderated', { defaultValue: 'модерация' })}
                    </span>
                  )}
                </div>
                <div className="message__actions">
                  {!message.deleted_at && (
                    <button type="button" className="ghost" onClick={() => onReply(message)}>
                      {t('chat.reply', { defaultValue: 'Ответить' })}
                    </button>
                  )}
                  {context === 'channel' && rootMessage && (
                    <button type="button" className="ghost" onClick={() => onOpenThread?.(rootMessage)}>
                      {t('chat.viewThread', { defaultValue: 'Открыть тред' })}
                      {message.thread_reply_count > 0 && ` (${message.thread_reply_count})`}
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="ghost" onClick={() => handleStartEdit(message)} disabled={isEditing || isPending}>
                      {t('chat.edit', { defaultValue: 'Редактировать' })}
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="ghost" onClick={() => void handleDelete(message)} disabled={isPending}>
                      {t('chat.delete', { defaultValue: 'Удалить' })}
                    </button>
                  )}
                  {canModerate && (
                    <button type="button" className="ghost" onClick={() => void handleModerate(message)} disabled={isPending}>
                      {message.moderated_at
                        ? t('chat.restore', { defaultValue: 'Восстановить' })
                        : t('chat.moderate', { defaultValue: 'Модерировать' })}
                    </button>
                  )}
                </div>
              </header>
              {parent && !message.deleted_at && (
                <button
                  type="button"
                  className="message__parent"
                  onClick={() => onOpenThread?.(parent.thread_root_id ? messageMap.get(parent.thread_root_id) ?? parent : parent)}
                >
                  <span className="message__parent-author">{getDisplayName(parent)}</span>
                  <span className="message__parent-content">{formatParentExcerpt(parent)}</span>
                </button>
              )}
              {isEditing ? (
                <div className="message__edit">
                  <textarea
                    value={editValue}
                    onChange={(event) => setEditValue(event.target.value)}
                    disabled={editLoading}
                  />
                  <div className="message__edit-actions">
                    <button type="button" className="primary" onClick={() => void handleSaveEdit(message)} disabled={editLoading}>
                      {editLoading ? t('common.loading') : t('chat.save', { defaultValue: 'Сохранить' })}
                    </button>
                    <button type="button" className="ghost" onClick={handleCancelEdit} disabled={editLoading}>
                      {t('chat.cancel', { defaultValue: 'Отмена' })}
                    </button>
                  </div>
                </div>
              ) : (
                renderContent(message)
              )}
              {!message.deleted_at && message.attachments.length > 0 && (
                <div className="message__attachments">
                  {message.attachments.map((attachment) => (
                    <AttachmentPreview key={attachment.id} attachment={attachment} />
                  ))}
                </div>
              )}
              {!message.deleted_at && message.moderated_at && message.moderation_note && (
                <p className="message__moderation-note">
                  {t('chat.moderationNote', { defaultValue: 'Причина: {{note}}', note: message.moderation_note })}
                </p>
              )}
              {message.deleted_at && message.moderation_note && (
                <p className="message__moderation-note">
                  {t('chat.moderationNote', { defaultValue: 'Причина: {{note}}', note: message.moderation_note })}
                </p>
              )}
              <Reactions reactions={message.reactions} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
