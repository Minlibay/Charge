import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { ForumPostDetail, Message, RoomMemberSummary, RoomRole } from '../../types';
import {
  getForumPost,
  updateForumPost,
  deleteForumPost,
  pinForumPost,
  unpinForumPost,
  archiveForumPost,
  unarchiveForumPost,
  lockForumPost,
  unlockForumPost,
} from '../../services/api';
import { MessageList } from '../messages/MessageList';
import { formatDateTime } from '../../utils/format';
import { useToast } from '../ui';

interface ForumPostViewProps {
  channelId: number;
  postId: number;
  members: RoomMemberSummary[];
  currentUserId: number | null;
  currentRole: RoomRole | null;
  onBack: () => void;
  onPostDeleted?: () => void;
  onPostUpdated?: (post: ForumPostDetail) => void;
  onEditMessage: (message: Message, content: string) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
  onModerateMessage: (message: Message, action: 'suppress' | 'restore', note?: string) => Promise<void>;
  onAddReaction: (message: Message, emoji: string) => Promise<void>;
  onRemoveReaction: (message: Message, emoji: string) => Promise<void>;
  selfReactions: Record<number, string[]>;
}

export function ForumPostView({
  channelId,
  postId,
  members,
  currentUserId,
  currentRole,
  onBack,
  onPostDeleted,
  onPostUpdated,
  onEditMessage,
  onDeleteMessage,
  onModerateMessage,
  onAddReaction,
  onRemoveReaction,
  selfReactions,
}: ForumPostViewProps): JSX.Element {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const [post, setPost] = useState<ForumPostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [editing, setEditing] = useState(false);

  const loadPost = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const postData = await getForumPost(channelId, postId);
      setPost(postData);
      // Load messages for the post (replies)
      // TODO: Load messages from channel with thread_root_id = post.message_id
      setMessages([postData.message]);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('forum.loadError', { defaultValue: 'Не удалось загрузить пост' });
      setError(errorMessage);
      pushToast({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  }, [channelId, postId, t, pushToast]);

  useEffect(() => {
    void loadPost();
  }, [loadPost]);

  const handlePin = async () => {
    if (!post) return;

    try {
      const updated = post.is_pinned
        ? await unpinForumPost(channelId, postId)
        : await pinForumPost(channelId, postId);
      setPost({ ...post, is_pinned: updated.is_pinned });
      onPostUpdated?.({ ...post, is_pinned: updated.is_pinned });
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('forum.pinError', { defaultValue: 'Ошибка при закреплении' }),
      });
    }
  };

  const handleArchive = async () => {
    if (!post) return;

    try {
      const updated = post.is_archived
        ? await unarchiveForumPost(channelId, postId)
        : await archiveForumPost(channelId, postId);
      setPost({ ...post, is_archived: updated.is_archived });
      onPostUpdated?.({ ...post, is_archived: updated.is_archived });
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('forum.archiveError', { defaultValue: 'Ошибка при архивировании' }),
      });
    }
  };

  const handleLock = async () => {
    if (!post) return;

    try {
      const updated = post.is_locked
        ? await unlockForumPost(channelId, postId)
        : await lockForumPost(channelId, postId);
      setPost({ ...post, is_locked: updated.is_locked });
      onPostUpdated?.({ ...post, is_locked: updated.is_locked });
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('forum.lockError', { defaultValue: 'Ошибка при блокировке' }),
      });
    }
  };

  const handleDelete = async () => {
    if (!post) return;

    const confirmed = window.confirm(
      t('forum.deleteConfirm', { defaultValue: 'Удалить этот пост?' })
    );
    if (!confirmed) return;

    try {
      await deleteForumPost(channelId, postId);
      pushToast({
        type: 'success',
        message: t('forum.deleted', { defaultValue: 'Пост удален' }),
      });
      onPostDeleted?.();
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('forum.deleteError', { defaultValue: 'Ошибка при удалении' }),
      });
    }
  };

  if (loading) {
    return (
      <div className="forum-post-view forum-post-view--loading">
        <div className="forum-post-view__loader">
          {t('common.loading', { defaultValue: 'Загрузка...' })}
        </div>
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="forum-post-view forum-post-view--error">
        <div className="forum-post-view__error">{error || t('forum.notFound', { defaultValue: 'Пост не найден' })}</div>
        <button type="button" className="forum-post-view__back" onClick={onBack}>
          {t('common.back', { defaultValue: 'Назад' })}
        </button>
      </div>
    );
  }

  const isAdmin = currentRole === 'owner' || currentRole === 'admin';
  const isAuthor = post.author_id === currentUserId;

  return (
    <div className="forum-post-view">
      <header className="forum-post-view__header">
        <button type="button" className="forum-post-view__back-button" onClick={onBack}>
          ← {t('common.back', { defaultValue: 'Назад' })}
        </button>
        <div className="forum-post-view__actions">
          {isAdmin && (
            <>
              <button
                type="button"
                className="forum-post-view__action"
                onClick={() => void handlePin()}
                title={post.is_pinned ? t('forum.unpin', { defaultValue: 'Открепить' }) : t('forum.pin', { defaultValue: 'Закрепить' })}
              >
                {post.is_pinned ? '📌' : '📌'}
              </button>
              <button
                type="button"
                className="forum-post-view__action"
                onClick={() => void handleArchive()}
                title={post.is_archived ? t('forum.unarchive', { defaultValue: 'Разархивировать' }) : t('forum.archive', { defaultValue: 'Архивировать' })}
              >
                {post.is_archived ? '📦' : '📦'}
              </button>
              <button
                type="button"
                className="forum-post-view__action"
                onClick={() => void handleLock()}
                title={post.is_locked ? t('forum.unlock', { defaultValue: 'Разблокировать' }) : t('forum.lock', { defaultValue: 'Заблокировать' })}
              >
                {post.is_locked ? '🔒' : '🔓'}
              </button>
            </>
          )}
          {(isAuthor || isAdmin) && (
            <button
              type="button"
              className="forum-post-view__action forum-post-view__action--danger"
              onClick={() => void handleDelete()}
              title={t('forum.delete', { defaultValue: 'Удалить' })}
            >
              🗑
            </button>
          )}
        </div>
      </header>

      <div className="forum-post-view__content">
        <div className="forum-post-view__post-header">
          <h1 className="forum-post-view__title">{post.title}</h1>
          <div className="forum-post-view__badges">
            {post.is_pinned && (
              <span className="forum-post-view__badge forum-post-view__badge--pin">
                {t('forum.pinned', { defaultValue: 'Закреплено' })}
              </span>
            )}
            {post.is_locked && (
              <span className="forum-post-view__badge forum-post-view__badge--lock">
                {t('forum.locked', { defaultValue: 'Заблокировано' })}
              </span>
            )}
            {post.is_archived && (
              <span className="forum-post-view__badge forum-post-view__badge--archive">
                {t('forum.archived', { defaultValue: 'Архивировано' })}
              </span>
            )}
          </div>
        </div>

        {post.tags.length > 0 && (
          <div className="forum-post-view__tags">
            {post.tags.map((tagName) => (
              <span key={tagName} className="forum-post-view__tag">
                {tagName}
              </span>
            ))}
          </div>
        )}

        <div className="forum-post-view__meta">
          <span className="forum-post-view__author">
            {post.author.display_name || post.author.login}
          </span>
          <time className="forum-post-view__date" dateTime={post.created_at}>
            {formatDateTime(post.created_at)}
          </time>
          {post.reply_count > 0 && (
            <span className="forum-post-view__replies">
              {t('forum.replies', { count: post.reply_count, defaultValue: '{{count}} ответов' })}
            </span>
          )}
        </div>

        <div className="forum-post-view__message">
          <MessageList
            messages={messages}
            members={members}
            currentUserId={currentUserId}
            currentRole={currentRole}
            channelType="forums"
            onReply={() => {}}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            onModerateMessage={onModerateMessage}
            onAddReaction={onAddReaction}
            onRemoveReaction={onRemoveReaction}
            selfReactions={selfReactions}
            context="thread"
          />
        </div>
      </div>
    </div>
  );
}

