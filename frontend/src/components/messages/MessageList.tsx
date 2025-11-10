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

import type { Message, MessageAttachment, RoomMemberSummary, RoomRole, CustomRole, ChannelType } from '../../types';
import { RoleBadge } from '../ui/RoleBadge';
import { formatDateTime } from '../../utils/format';
import { COMMON_EMOJIS } from '../../utils/emojis';
import { useToast } from '../ui';
import { resolveApiUrl } from '../../services/api';
import { getAccessToken } from '../../services/session';
import { AnnouncementMessage } from './AnnouncementMessage';

interface MessageListProps {
  messages: Message[];
  members: RoomMemberSummary[];
  currentUserId: number | null;
  currentRole: RoomRole | null;
  channelType?: ChannelType | null;
  onReply: (message: Message) => void;
  onOpenThread?: (message: Message) => void;
  onEditMessage: (message: Message, content: string) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
  onModerateMessage: (message: Message, action: 'suppress' | 'restore', note?: string) => Promise<void>;
  onAddReaction: (message: Message, emoji: string) => Promise<void>;
  onRemoveReaction: (message: Message, emoji: string) => Promise<void>;
  onCrossPost?: (message: Message) => void;
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
  scrollToBottom: () => void;
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

function AuthenticatedImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const loadImage = async () => {
      try {
        const url = resolveApiUrl(src);
        const token = getAccessToken();
        
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url.toString(), {
          headers,
          credentials: 'include',
        });

        if (!response.ok) {
          throw new Error(`Failed to load image: ${response.status}`);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;
        setImageUrl(blobUrl);
        setError(false);
      } catch (err) {
        console.error('Failed to load authenticated image:', err);
        setError(true);
      }
    };

    loadImage();

    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [src]);

  if (error || !imageUrl) {
    return (
      <div className="message__attachment-image-error" style={{ 
        width: '160px', 
        height: '120px', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'var(--color-surface-hover)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--color-text-secondary)',
        fontSize: '0.875rem'
      }}>
        {error ? 'Ошибка загрузки' : 'Загрузка...'}
      </div>
    );
  }

  return <img src={imageUrl} alt={alt} />;
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
        <AuthenticatedImage src={attachment.preview_url} alt={attachment.file_name} />
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
      channelType,
      onReply,
      onOpenThread,
      onEditMessage,
      onDeleteMessage,
      onModerateMessage,
      onAddReaction,
      onRemoveReaction,
      onCrossPost,
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
  const isInitialLoadRef = useRef<boolean>(true);
  const prevMessagesLengthRef = useRef<number>(0);
  const shouldAutoScrollRef = useRef<boolean>(true);
  const prevChannelIdRef = useRef<number | null>(null);

  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (parent instanceof HTMLElement) {
      scrollParentRef.current = parent as HTMLDivElement;
    }
  }, []);

  const mentionLookup = useMemo(() => buildMentionLookup(members), [members]);
  
  // Create a map of user_id -> custom_roles from members
  const rolesByUserId = useMemo(() => {
    const map = new Map<number, CustomRole[]>();
    members.forEach((member) => {
      if (member.custom_roles && member.custom_roles.length > 0) {
        map.set(member.user_id, member.custom_roles);
      }
    });
    return map;
  }, [members]);
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

  // Определяем, сменился ли канал (по первому сообщению)
  const currentChannelId = messages.length > 0 ? messages[0]?.channel_id : null;
  
  useEffect(() => {
    // Если сменился канал, сбрасываем флаги
    if (currentChannelId !== prevChannelIdRef.current && currentChannelId !== null) {
      isInitialLoadRef.current = true;
      shouldAutoScrollRef.current = true;
      prevMessagesLengthRef.current = 0;
      prevChannelIdRef.current = currentChannelId;
    }
  }, [currentChannelId]);

  // Автоматический скролл к последнему сообщению
  useEffect(() => {
    const scrollElement = scrollParentRef.current;
    if (!scrollElement || messages.length === 0) {
      return;
    }

    const scrollToBottom = () => {
      // Используем двойной requestAnimationFrame для гарантии, что DOM обновлен
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollElement) {
            // Используем scrollTo для более надежного скролла
            scrollElement.scrollTo({
              top: scrollElement.scrollHeight,
              behavior: 'auto', // Используем 'auto' для мгновенного скролла
            });
          }
        });
      });
    };

    // При первой загрузке всегда скроллим вниз
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      // Даем время виртуализатору обновиться
      setTimeout(() => {
        scrollToBottom();
      }, 150);
      prevMessagesLengthRef.current = messages.length;
      return;
    }

    // При добавлении новых сообщений проверяем, нужно ли скроллить
    const messagesAdded = messages.length > prevMessagesLengthRef.current;
    if (messagesAdded) {
      const isNearBottom =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 200;
      
      if (shouldAutoScrollRef.current || isNearBottom) {
        scrollToBottom();
      }
    }

    prevMessagesLengthRef.current = messages.length;
  }, [messages.length]);

  // Отслеживание скролла пользователя для определения, нужно ли автоскроллить
  useEffect(() => {
    const scrollElement = scrollParentRef.current;
    if (!scrollElement) {
      return;
    }

    const handleScroll = () => {
      const isAtBottom =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 50;
      shouldAutoScrollRef.current = isAtBottom;
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (messageId: number) => {
        const index = messageIndexMap.get(messageId);
        if (index == null) {
          return;
        }
        pendingScrollToRef.current = messageId;
        shouldAutoScrollRef.current = false; // Отключаем автоскролл при ручном скролле
        virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
      },
      scrollToBottom: () => {
        const scrollElement = scrollParentRef.current;
        if (scrollElement && messages.length > 0) {
          shouldAutoScrollRef.current = true;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (scrollElement) {
                scrollElement.scrollTo({
                  top: scrollElement.scrollHeight,
                  behavior: 'smooth',
                });
              }
            });
          });
        }
      },
    }),
    [messageIndexMap, virtualizer, messages.length],
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
          const isThreadReply = Boolean(
            (message.thread_root_id != null && message.thread_root_id !== message.id) || message.parent_id,
          );
          const avatarBg = avatarColor(message.author_id ?? null);
          const previousMessage = virtualRow.index > 0 ? messages[virtualRow.index - 1] : undefined;
          const nextMessage =
            virtualRow.index < messages.length - 1 ? messages[virtualRow.index + 1] : undefined;

          const isGroupableWith = (other?: Message) => {
            if (!other) {
              return false;
            }
            if (other.deleted_at || message.deleted_at) {
              return false;
            }
            if (other.author_id !== message.author_id) {
              return false;
            }
            const otherRootId = other.thread_root_id ?? other.id;
            if (otherRootId !== rootId) {
              return false;
            }
            const otherParentId = other.parent_id ?? null;
            const parentId = message.parent_id ?? null;
            if (otherParentId !== parentId) {
              return false;
            }
            return true;
          };

          const groupedWithPrevious = isGroupableWith(previousMessage);
          const groupedWithNext = isGroupableWith(nextMessage);
          const isGroupStart = !groupedWithPrevious;
          const isGroupEnd = !groupedWithNext;
          const isGroupMiddle = groupedWithPrevious && groupedWithNext;
          const isGroupSingle = isGroupStart && isGroupEnd;
          const isGrouped = groupedWithPrevious || groupedWithNext;
          const isSelf = message.author_id === currentUserId;
          const isAnnouncement = channelType === 'announcements';

          const messageContent = (
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
                'message--thread-reply': isThreadReply,
                'message--grouped': isGrouped,
                'message--group-start': isGroupStart,
                'message--group-middle': isGroupMiddle,
                'message--group-end': isGroupEnd,
                'message--group-single': isGroupSingle,
                'message--self': isSelf,
              })}
              aria-label={name}
            >
                {!isSelf && (
                  <div
                    className="message__avatar"
                    style={{ backgroundColor: avatarBg }}
                    aria-hidden="true"
                  >
                    {getAvatarLetter(message)}
                  </div>
                )}
                <div className="message__column">
                  <div
                    className={clsx('message__bubble-row', {
                      'message__bubble-row--thread': isThreadReply,
                    })}
                  >
                    {isThreadReply && <span className="message__thread-line" aria-hidden="true" />}
                    <div className="message__bubble">
                      <header className="message__header">
                        <div className="message__header-left">
                          <div className="message__author-row">
                            <span className="message__author">{name}</span>
                            {message.author_id != null && (() => {
                              const authorRoles = rolesByUserId.get(message.author_id);
                              return authorRoles && authorRoles.length > 0 ? (
                                <div className="message__roles">
                                  {authorRoles
                                    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
                                    .map((role) => (
                                      <RoleBadge key={role.id} role={role} />
                                    ))}
                                </div>
                              ) : null;
                            })()}
                          </div>
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
                        <div className="message__actions" role="group">
                          {!message.deleted_at && (
                            <button
                              type="button"
                              className="message__action-button"
                              onClick={() => onReply(message)}
                              title={t('chat.reply', { defaultValue: 'Ответить' })}
                            >
                              <span className="message__action-icon" aria-hidden="true">
                                ↩︎
                              </span>
                              <span className="sr-only">
                                {t('chat.reply', { defaultValue: 'Ответить' })}
                              </span>
                            </button>
                          )}
                          {context === 'channel' && rootMessage && (
                            <button
                              type="button"
                              className="message__action-button"
                              onClick={() => onOpenThread?.(rootMessage)}
                              title={t('chat.viewThread', { defaultValue: 'Открыть тред' })}
                            >
                              <span className="message__action-icon" aria-hidden="true">
                                🧵
                              </span>
                              {message.thread_reply_count > 0 && (
                                <span className="message__action-count" aria-hidden="true">
                                  {message.thread_reply_count}
                                </span>
                              )}
                              <span className="sr-only">
                                {t('chat.viewThread', { defaultValue: 'Открыть тред' })}
                              </span>
                            </button>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              className="message__action-button"
                              onClick={() => handleStartEdit(message)}
                              disabled={isEditing || isPending}
                              title={t('chat.edit', { defaultValue: 'Изменить' })}
                            >
                              <span className="message__action-icon" aria-hidden="true">
                                ✎
                              </span>
                              <span className="sr-only">
                                {t('chat.edit', { defaultValue: 'Изменить' })}
                              </span>
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              className="message__action-button"
                              onClick={() => void handleDelete(message)}
                              disabled={isPending}
                              title={t('chat.delete', { defaultValue: 'Удалить' })}
                            >
                              <span className="message__action-icon" aria-hidden="true">
                                🗑
                              </span>
                              <span className="sr-only">
                                {t('chat.delete', { defaultValue: 'Удалить' })}
                              </span>
                            </button>
                          )}
                          {canModerate && (
                            <button
                              type="button"
                              className="message__action-button"
                              onClick={() => void handleModerate(message)}
                              disabled={isPending}
                              title={
                                message.moderated_at
                                  ? t('chat.restore', { defaultValue: 'Восстановить' })
                                  : t('chat.moderate', { defaultValue: 'Скрыть' })
                              }
                            >
                              <span className="message__action-icon" aria-hidden="true">
                                {message.moderated_at ? '↺' : '🚫'}
                              </span>
                              <span className="sr-only">
                                {message.moderated_at
                                  ? t('chat.restore', { defaultValue: 'Восстановить' })
                                  : t('chat.moderate', { defaultValue: 'Скрыть' })}
                              </span>
                            </button>
                          )}
                          {isAnnouncement && onCrossPost && !message.deleted_at && (
                            <button
                              type="button"
                              className="message__action-button"
                              onClick={() => onCrossPost(message)}
                              disabled={isPending}
                              title={t('channels.crossPost', { defaultValue: 'Опубликовать в другие каналы' })}
                            >
                              <span className="message__action-icon" aria-hidden="true">
                                📢
                              </span>
                              <span className="sr-only">
                                {t('channels.crossPost', { defaultValue: 'Опубликовать в другие каналы' })}
                              </span>
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
                      <div className="message__bubble-content">
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
                      </div>
                    </div>
                  </div>
                  {!message.deleted_at && (
                    <div
                      className={clsx('message__footer', {
                        'message__footer--thread': isThreadReply,
                      })}
                    >
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
                                <span className="message__reaction-emoji" aria-hidden="true">
                                  {reaction.emoji}
                                </span>
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
                            title={t('chat.addReaction', { defaultValue: 'Добавить реакцию' })}
                          >
                            <span className="message__reaction-emoji" aria-hidden="true">
                              ➕
                            </span>
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
                    </div>
                  )}
                </div>
                {isSelf && (
                  <div
                    className="message__avatar"
                    style={{ backgroundColor: avatarBg }}
                    aria-hidden="true"
                  >
                    {getAvatarLetter(message)}
                  </div>
                )}
              </article>
          );

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
                  virtualRow.index === messages.length - 1 ? 0 : 'var(--space-2)',
              }}
            >
              {isAnnouncement ? (
                <AnnouncementMessage message={message}>
                  {messageContent}
                </AnnouncementMessage>
              ) : (
                messageContent
              )}
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
