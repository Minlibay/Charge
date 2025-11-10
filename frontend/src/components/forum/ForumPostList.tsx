import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { ForumPost, ForumChannelTag, Channel } from '../../types';
import { listForumPosts, listForumChannelTags } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { useToast } from '../ui';

interface ForumPostListProps {
  channel: Channel;
  currentUserId: number | null;
  onSelectPost: (post: ForumPost) => void;
  onCreatePost?: () => void;
}

export function ForumPostList({
  channel,
  currentUserId,
  onSelectPost,
  onCreatePost,
}: ForumPostListProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const { pushToast } = useToast();
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [tags, setTags] = useState<ForumChannelTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sortBy, setSortBy] = useState<'created' | 'last_reply' | 'replies'>('last_reply');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);

  const loadPosts = useCallback(async () => {
    if (!channel) return;

    setLoading(true);
    setError(null);

    try {
      const result = await listForumPosts(channel.id, {
        page,
        page_size: 20,
        sort_by: sortBy,
        tags: selectedTags.size > 0 ? Array.from(selectedTags).join(',') : undefined,
        pinned_only: pinnedOnly,
        archived: showArchived,
      });

      setPosts(result.items);
      setTotal(result.total);
      setHasMore(result.has_more);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('forum.loadError', { defaultValue: 'Не удалось загрузить посты' });
      setError(errorMessage);
      pushToast({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  }, [channel, page, sortBy, selectedTags, pinnedOnly, showArchived, t, pushToast]);

  const loadTags = useCallback(async () => {
    if (!channel) return;

    try {
      const channelTags = await listForumChannelTags(channel.id);
      setTags(channelTags);
    } catch (err) {
      console.error('Failed to load channel tags:', err);
    }
  }, [channel]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  // Listen for forum post events from WebSocket
  useEffect(() => {
    const handleForumPostEvent = (event: CustomEvent) => {
      const { type, channel_id, post, post_id } = event.detail;
      // Only handle events for this channel
      if (channel_id !== channel.id) return;

      if (type === 'forum_post_created' || type === 'forum_post_updated') {
        // Refresh the post list to show the new/updated post
        void loadPosts();
      } else if (type === 'forum_post_deleted') {
        // Remove the deleted post from the list
        setPosts((prev) => prev.filter((p) => p.id !== post_id));
        setTotal((prev) => Math.max(0, prev - 1));
      }
    };

    window.addEventListener('forum_post_event', handleForumPostEvent as EventListener);
    return () => {
      window.removeEventListener('forum_post_event', handleForumPostEvent as EventListener);
    };
  }, [channel.id, loadPosts]);

  const handleTagToggle = (tagName: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagName)) {
        next.delete(tagName);
      } else {
        next.add(tagName);
      }
      return next;
    });
    setPage(1);
  };

  const handleSortChange = (newSort: 'created' | 'last_reply' | 'replies') => {
    setSortBy(newSort);
    setPage(1);
  };

  if (loading && posts.length === 0) {
    return (
      <div className="forum-post-list forum-post-list--loading">
        <div className="forum-post-list__loader">
          {t('common.loading', { defaultValue: 'Загрузка...' })}
        </div>
      </div>
    );
  }

  if (error && posts.length === 0) {
    return (
      <div className="forum-post-list forum-post-list--error">
        <div className="forum-post-list__error">{error}</div>
        <button
          type="button"
          className="forum-post-list__retry"
          onClick={() => void loadPosts()}
        >
          {t('common.retry', { defaultValue: 'Повторить' })}
        </button>
      </div>
    );
  }

  return (
    <div className="forum-post-list">
      <div className="forum-post-list__header">
        <div className="forum-post-list__controls">
          <div className="forum-post-list__filters">
            <select
              className="forum-post-list__sort"
              value={sortBy}
              onChange={(e) =>
                handleSortChange(e.target.value as 'created' | 'last_reply' | 'replies')
              }
            >
              <option value="last_reply">
                {t('forum.sort.lastReply', { defaultValue: 'Последний ответ' })}
              </option>
              <option value="created">
                {t('forum.sort.created', { defaultValue: 'Дата создания' })}
              </option>
              <option value="replies">
                {t('forum.sort.replies', { defaultValue: 'Количество ответов' })}
              </option>
            </select>

            <label className="forum-post-list__filter-checkbox">
              <input
                type="checkbox"
                checked={pinnedOnly}
                onChange={(e) => {
                  setPinnedOnly(e.target.checked);
                  setPage(1);
                }}
              />
              <span>{t('forum.pinnedOnly', { defaultValue: 'Только закрепленные' })}</span>
            </label>

            <label className="forum-post-list__filter-checkbox">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => {
                  setShowArchived(e.target.checked);
                  setPage(1);
                }}
              />
              <span>{t('forum.showArchived', { defaultValue: 'Показать архивированные' })}</span>
            </label>
          </div>

          {onCreatePost && (
            <button
              type="button"
              className="forum-post-list__create-button"
              onClick={onCreatePost}
            >
              {t('forum.createPost', { defaultValue: 'Создать пост' })}
            </button>
          )}
        </div>

        {tags.length > 0 && (
          <div className="forum-post-list__tags">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={clsx('forum-post-list__tag', {
                  'forum-post-list__tag--selected': selectedTags.has(tag.name),
                })}
                style={{ '--tag-color': tag.color } as React.CSSProperties}
                onClick={() => handleTagToggle(tag.name)}
              >
                {tag.emoji && <span className="forum-post-list__tag-emoji">{tag.emoji}</span>}
                <span className="forum-post-list__tag-name">{tag.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="forum-post-list__content">
        {posts.length === 0 ? (
          <div className="forum-post-list__empty">
            {t('forum.noPosts', { defaultValue: 'Нет постов' })}
          </div>
        ) : (
          <>
            <div className="forum-post-list__posts">
              {posts.map((post) => (
                <ForumPostCard
                  key={post.id}
                  post={post}
                  tags={tags}
                  currentUserId={currentUserId}
                  onClick={() => onSelectPost(post)}
                />
              ))}
            </div>

            {hasMore && (
              <button
                type="button"
                className="forum-post-list__load-more"
                onClick={() => setPage((p) => p + 1)}
                disabled={loading}
              >
                {loading
                  ? t('common.loading', { defaultValue: 'Загрузка...' })
                  : t('common.loadMore', { defaultValue: 'Загрузить еще' })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ForumPostCardProps {
  post: ForumPost;
  tags: ForumChannelTag[];
  currentUserId: number | null;
  onClick: () => void;
}

function ForumPostCard({ post, tags, currentUserId, onClick }: ForumPostCardProps): JSX.Element {
  const { t } = useTranslation();
  const tagMap = new Map(tags.map((tag) => [tag.name, tag]));

  const lastReplyDate = post.last_reply_at
    ? formatDateTime(post.last_reply_at)
    : formatDateTime(post.created_at);

  return (
    <article
      className={clsx('forum-post-card', {
        'forum-post-card--pinned': post.is_pinned,
        'forum-post-card--archived': post.is_archived,
        'forum-post-card--locked': post.is_locked,
      })}
      onClick={onClick}
    >
      <div className="forum-post-card__header">
        <h3 className="forum-post-card__title">{post.title}</h3>
        <div className="forum-post-card__badges">
          {post.is_pinned && (
            <span className="forum-post-card__badge forum-post-card__badge--pin" title={t('forum.pinned', { defaultValue: 'Закреплено' })}>
              📌
            </span>
          )}
          {post.is_locked && (
            <span className="forum-post-card__badge forum-post-card__badge--lock" title={t('forum.locked', { defaultValue: 'Заблокировано' })}>
              🔒
            </span>
          )}
          {post.is_archived && (
            <span className="forum-post-card__badge forum-post-card__badge--archive" title={t('forum.archived', { defaultValue: 'Архивировано' })}>
              📦
            </span>
          )}
        </div>
      </div>

      {post.tags.length > 0 && (
        <div className="forum-post-card__tags">
          {post.tags.map((tagName) => {
            const tag = tagMap.get(tagName);
            return (
              <span
                key={tagName}
                className="forum-post-card__tag"
                style={{ '--tag-color': tag?.color ?? '#99AAB5' } as React.CSSProperties}
              >
                {tag?.emoji && <span className="forum-post-card__tag-emoji">{tag.emoji}</span>}
                <span className="forum-post-card__tag-name">{tagName}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="forum-post-card__meta">
        <div className="forum-post-card__stats">
          <span className="forum-post-card__stat">
            {t('forum.replies', { count: post.reply_count, defaultValue: '{{count}} ответов' })}
          </span>
          <span className="forum-post-card__stat">
            {t('forum.lastReply', { date: lastReplyDate, defaultValue: 'Последний ответ: {{date}}' })}
          </span>
        </div>
        <time className="forum-post-card__date" dateTime={post.created_at}>
          {formatDateTime(post.created_at)}
        </time>
      </div>
    </article>
  );
}

