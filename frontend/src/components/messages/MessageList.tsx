import clsx from 'clsx';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';

import type { Message, MessageAttachment, RoomMemberSummary, RoomRole } from '../../types';
import { formatDateTime } from '../../utils/format';
import { COMMON_EMOJIS } from '../../utils/emojis';
import { useToast } from '../ui';

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
  onAddReaction: (message: Message, emoji: string) => Promise<void>;
  onRemoveReaction: (message: Message, emoji: string) => Promise<void>;
  selfReactions: Record<number, string[]>;
  context?: 'channel' | 'thread';
  replyingToId?: number | null;
  activeThreadRootId?: number | null;
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
}

export interface MessageListHandle {
  scrollToMessage: (messageId: number) => void;
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
      <a
        href={attachment.download_url}
        target="_blank"
        rel="noreferrer"
        className="message__attachment message__attachment--preview"
      >
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

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  (
    {
      messages,
      members,
      currentUserId,
      currentRole,
      onReply,
      onOpenThread,
      onEditMessage,
      onDeleteMessage,
      onModerateMessage,
      onAddReaction,
      onRemoveReaction,
      selfReactions,
      context = 'channel',
      replyingToId,
      activeThreadRootId,
      hasMoreOlder = false,
      hasMoreNewer = false,
      loadingOlder = false,
      loadingNewer = false,
      onLoadOlder,
      onLoadNewer,
    }: MessageListProps,
    ref,
  ): JSX.Element => {
  const { t, i18n } = useTranslation();
  const { pushToast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [pendingMessageId, setPendingMessageId] = useState<number | null>(null);
  const [reactionPickerId, setReactionPickerId] = useState<number | null>(null);
  const [pendingReactions, setPendingReactions] = useState<Record<number, string[]>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const olderScrollHeightRef = useRef<number | null>(null);
  const newerScrollOffsetRef = useRef<number | null>(null);
  const prevLoadingOlderRef = useRef<boolean>(false);
  const prevLoadingNewerRef = useRef<boolean>(false);
  const pendingScrollToRef = useRef<number | null>(null);
  const messageElementsRef = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (parent instanceof HTMLElement) {
      scrollParentRef.current = parent as HTMLDivElement;
    }
  }, []);

  const mentionLookup = useMemo(() => buildMentionLookup(members), [members]);
  const messageMap = useMemo(() => {
    const map = new Map<number, Message>();
    messages.forEach((message) => {
      map.set(message.id, message);
    });
    return map;
  }, [messages]);

  const isAdmin = currentRole === 'owner' || currentRole === 'admin';

  const messageIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    messages.forEach((message, index) => {
      map.set(message.id, index);
    });
    return map;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 160,
    overscan: 10,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [messages, editingId, reactionPickerId, virtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (messageId: number) => {
        const index = messageIndexMap.get(messageId);
        if (index == null) {
          return;
        }
        pendingScrollToRef.current = messageId;
        virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
      },
    }),
    [messageIndexMap, virtualizer],
  );

  useEffect(() => {
    const scrollElement = scrollParentRef.current;
    if (!scrollElement) {
      prevLoadingOlderRef.current = loadingOlder;
      return;
    }
    if (loadingOlder && !prevLoadingOlderRef.current) {
      olderScrollHeightRef.current = scrollElement.scrollHeight;
    } else if (!loadingOlder && prevLoadingOlderRef.current) {
      if (olderScrollHeightRef.current !== null) {
        const diff = scrollElement.scrollHeight - olderScrollHeightRef.current;
        scrollElement.scrollTop += diff;
        olderScrollHeightRef.current = null;
      }
    }
    prevLoadingOlderRef.current = loadingOlder;
  }, [loadingOlder, messages.length]);

  useEffect(() => {
    const scrollElement = scrollParentRef.current;
    if (!scrollElement) {
      prevLoadingNewerRef.current = loadingNewer;
      return;
    }
    if (loadingNewer && !prevLoadingNewerRef.current) {
      newerScrollOffsetRef.current = scrollElement.scrollHeight - scrollElement.scrollTop;
    } else if (!loadingNewer && prevLoadingNewerRef.current) {
      if (newerScrollOffsetRef.current !== null) {
        scrollElement.scrollTop = scrollElement.scrollHeight - newerScrollOffsetRef.current;
        newerScrollOffsetRef.current = null;
      }
    }
    prevLoadingNewerRef.current = loadingNewer;
  }, [loadingNewer, messages.length]);

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollParentRef.current;
    if (!root || !sentinel || !onLoadOlder || !hasMoreOlder) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !loadingOlder) {
            onLoadOlder();
          }
        });
      },
      { root, rootMargin: '160px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadOlder, hasMoreOlder, loadingOlder]);

  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    const root = scrollParentRef.current;
    if (!root || !sentinel || !onLoadNewer || !hasMoreNewer) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !loadingNewer) {
            onLoadNewer();
          }
        });
      },
      { root, rootMargin: '160px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadNewer, hasMoreNewer, loadingNewer]);

  const markPendingReaction = (messageId: number, emoji: string) => {
    setPendingReactions((prev) => {
      const existing = prev[messageId] ?? [];
      if (existing.includes(emoji)) {
        return prev;
      }
      return { ...prev, [messageId]: [...existing, emoji] };
    });
  };

  const clearPendingReaction = (messageId: number, emoji: string) => {
    setPendingReactions((prev) => {
      const existing = prev[messageId];
      if (!existing) {
        return prev;
      }
      const nextList = existing.filter((item) => item !== emoji);
      const nextState = { ...prev } as Record<number, string[]>;
      if (nextList.length > 0) {
        nextState[messageId] = nextList;
      } else {
        delete nextState[messageId];
      }
      return nextState;
    });
  };

  const handleReactionToggle = async (message: Message, emoji: string) => {
    const reactedEmojis = selfReactions[message.id] ?? [];
    const isRemoving = reactedEmojis.includes(emoji);
    markPendingReaction(message.id, emoji);
    try {
      if (isRemoving) {
        await onRemoveReaction(message, emoji);
        pushToast({
          type: 'success',
          title: t('chat.reactionNotificationTitle', { defaultValue: 'Реакция обновлена' }),
          description: t('chat.reactionRemoved', {
            defaultValue: 'Реакция снята {{emoji}}',
            emoji,
          }),
        });
      } else {
        await onAddReaction(message, emoji);
        pushToast({
          type: 'success',
          title: t('chat.reactionNotificationTitle', { defaultValue: 'Реакция обновлена' }),
          description: t('chat.reactionAdded', {
            defaultValue: 'Реакция добавлена {{emoji}}',
            emoji,
          }),
        });
      }
    } catch (error) {
      const fallback = t('chat.reactionError', {
        defaultValue: 'Не удалось обновить реакцию',
      });
      const detail = error instanceof Error ? error.message : fallback;
      pushToast({
        type: 'error',
        title: t('chat.reactionErrorTitle', { defaultValue: 'Ошибка реакции' }),
        description: detail || fallback,
      });
    } finally {
      clearPendingReaction(message.id, emoji);
    }
  };

  const handleToggleReactionPicker = (messageId: number) => {
    setReactionPickerId((current) => (current === messageId ? null : messageId));
  };

  const handleSelectEmoji = (message: Message, emoji: string) => {
    setReactionPickerId(null);
    void handleReactionToggle(message, emoji);
  };

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

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const innerHeight = totalSize > 0 ? totalSize : 1;

  return (
    <div
      className={clsx('message-list', { 'message-list--thread': context === 'thread' })}
      ref={containerRef}
    >
      <div ref={topSentinelRef} className="message-list__sentinel" aria-hidden="true" />
      {loadingOlder && hasMoreOlder && (
        <div className="message-list__loader">{t('common.loading')}</div>
      )}
      <div
        className="message-list__virtual"
        style={{ height: innerHeight, position: 'relative', width: '100%' }}
      >
        {virtualItems.map((virtualRow) => {
          const message = messages[virtualRow.index];
          if (!message) {
            return null;
          }

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
            <div
              key={message.id}
              data-index={virtualRow.index}
              ref={(node) => {
                if (node) {
                  virtualizer.measureElement(node);
                }
              }}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom:
                  virtualRow.index === messages.length - 1 ? 0 : 'var(--space-3)',
              }}
            >
              <article
                ref={(node) => {
                  if (node) {
                    messageElementsRef.current.set(message.id, node);
                    if (pendingScrollToRef.current === message.id) {
                      requestAnimationFrame(() => {
                        if (pendingScrollToRef.current === message.id) {
                          node.focus({ preventScroll: true });
                          pendingScrollToRef.current = null;
                        }
                      });
                    }
                  } else {
                    messageElementsRef.current.delete(message.id);
                  }
                }}
                id={`message-${message.id}`}
                tabIndex={-1}
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
                      {message.pinned_at && (
                        <span
                          className="message__badge message__badge--pin"
                          title={t('chat.pinned', { defaultValue: 'закреплено' })}
                        >
                          📌
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
                          {t('chat.edit', { defaultValue: 'Изменить' })}
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
                            : t('chat.moderate', { defaultValue: 'Скрыть' })}
                        </button>
                      )}
                    </div>
                  </header>
                  {message.parent_id && parent && (
                    <button
                      type="button"
                      className="message__parent"
                      onClick={() => onOpenThread?.(parent)}
                      aria-label={t('chat.viewParent', { defaultValue: 'Посмотреть родительское сообщение' })}
                    >
                      <span className="message__parent-author">{getDisplayName(parent)}</span>
                      <span className="message__parent-excerpt">{formatParentExcerpt(parent)}</span>
                    </button>
                  )}
                  {isEditing ? (
                    <form
                      className="message__edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleSaveEdit(message);
                      }}
                    >
                      <textarea
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        disabled={editLoading}
                        aria-label={t('chat.editMessage', { defaultValue: 'Изменить сообщение' })}
                      />
                      <div className="message__edit-actions">
                        <button type="submit" className="primary" disabled={editLoading}>
                          {t('common.save', { defaultValue: 'Сохранить' })}
                        </button>
                        <button type="button" className="ghost" onClick={handleCancelEdit} disabled={editLoading}>
                          {t('common.cancel', { defaultValue: 'Отмена' })}
                        </button>
                      </div>
                    </form>
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
                  {!message.deleted_at && (
                    <div className="message__reaction-toolbar">
                      <ul
                        className="message__reactions"
                        aria-label={t('chat.reactionsLabel', { defaultValue: 'Реакции' })}
                      >
                        {message.reactions.map((reaction) => {
                          const reactedEmojis = selfReactions[message.id] ?? [];
                          const isReacted = reactedEmojis.includes(reaction.emoji);
                          const isPending = (pendingReactions[message.id] ?? []).includes(
                            reaction.emoji,
                          );
                          return (
                            <li
                              key={reaction.emoji}
                              className={clsx('message__reaction', {
                                'message__reaction--reacted': isReacted,
                                'message__reaction--pending': isPending,
                              })}
                            >
                              <button
                                type="button"
                                className="message__reaction-button"
                                onClick={() => void handleReactionToggle(message, reaction.emoji)}
                                disabled={isPending}
                                aria-label={t('chat.toggleReaction', {
                                  defaultValue: 'Переключить реакцию {{emoji}}',
                                  emoji: reaction.emoji,
                                })}
                              >
                                <span aria-hidden="true">{reaction.emoji}</span>
                                <span className="message__reaction-count">{reaction.count}</span>
                              </button>
                            </li>
                          );
                        })}
                        <li className="message__reaction message__reaction--add">
                          <button
                            type="button"
                            className="message__reaction-button message__reaction-button--add"
                            onClick={() => handleToggleReactionPicker(message.id)}
                            aria-expanded={reactionPickerId === message.id}
                            aria-label={t('chat.addReaction', { defaultValue: 'Добавить реакцию' })}
                          >
                            <span aria-hidden="true">➕</span>
                            <span className="sr-only">
                              {t('chat.addReaction', { defaultValue: 'Добавить реакцию' })}
                            </span>
                          </button>
                        </li>
                      </ul>
                      {reactionPickerId === message.id && (
                        <div
                          className="message__reaction-picker"
                          role="dialog"
                          aria-label={t('chat.addReaction', { defaultValue: 'Добавить реакцию' })}
                        >
                          <div className="message__reaction-grid">
                            {COMMON_EMOJIS.map((emoji) => (
                              <button
                                type="button"
                                key={emoji}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => handleSelectEmoji(message, emoji)}
                                aria-label={t('chat.addReactionWithEmoji', {
                                  defaultValue: 'Добавить реакцию {{emoji}}',
                                  emoji,
                                })}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            </div>
          );
        })}
        <div
          ref={bottomSentinelRef}
          className="message-list__sentinel"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: Math.max(innerHeight - 1, 0),
            width: '100%',
            height: 1,
          }}
        />
      </div>
      {loadingNewer && hasMoreNewer && (
        <div className="message-list__loader">{t('common.loading')}</div>
      )}
    </div>
  );
});
