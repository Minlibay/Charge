import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { Channel, ForumChannelTag, ForumPostDetail } from '../../types';
import { createForumPost, listForumChannelTags } from '../../services/api';
import { XIcon } from '../icons/LucideIcons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
  Input,
  useToast,
} from '../ui';

interface CreateForumPostDialogProps {
  open: boolean;
  channel: Channel | null;
  onClose: () => void;
  onSuccess?: (post: ForumPostDetail) => void;
}

export function CreateForumPostDialog({
  open,
  channel,
  onClose,
  onSuccess,
}: CreateForumPostDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [availableTags, setAvailableTags] = useState<ForumChannelTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && channel) {
      setTitle('');
      setContent('');
      setSelectedTags(new Set());
      setError(null);
      void loadTags();
    }
  }, [open, channel]);

  const loadTags = async () => {
    if (!channel) return;

    try {
      const tags = await listForumChannelTags(channel.id);
      setAvailableTags(tags);
    } catch (err) {
      console.error('Failed to load channel tags:', err);
    }
  };

  const handleToggleTag = (tagName: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagName)) {
        next.delete(tagName);
      } else if (next.size < 5) {
        next.add(tagName);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!channel) return;

    if (!title.trim()) {
      setError(t('forum.titleRequired', { defaultValue: 'Заголовок обязателен' }));
      return;
    }

    if (!content.trim()) {
      setError(t('forum.contentRequired', { defaultValue: 'Содержимое обязательно' }));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const post = await createForumPost(channel.id, {
        title: title.trim(),
        content: content.trim(),
        tag_names: Array.from(selectedTags),
      });

      pushToast({
        title: t('forum.postCreated', { defaultValue: 'Пост создан' }),
        variant: 'success',
      });

      onSuccess?.(post);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('forum.createError', { defaultValue: 'Не удалось создать пост' })
      );
    } finally {
      setLoading(false);
    }
  };

  if (!open || !channel || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>
          {t('forum.createPost', { defaultValue: 'Создать пост' })}
        </DialogTitle>
        <Button variant="ghost" size="icon" className="dialog-close-button" onClick={onClose}>
          <XIcon />
        </Button>
      </DialogHeader>
      <DialogContent>
        {error && <p className="text-danger">{error}</p>}

        <div className="create-forum-post-dialog__form">
          <div className="create-forum-post-dialog__field">
            <Label htmlFor="forum-post-title">
              {t('forum.title', { defaultValue: 'Заголовок' })}
            </Label>
            <Input
              id="forum-post-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('forum.titlePlaceholder', { defaultValue: 'Введите заголовок поста' })}
              maxLength={256}
              disabled={loading}
            />
          </div>

          <div className="create-forum-post-dialog__field">
            <Label htmlFor="forum-post-content">
              {t('forum.content', { defaultValue: 'Содержимое' })}
            </Label>
            <Textarea
              id="forum-post-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('forum.contentPlaceholder', { defaultValue: 'Введите содержимое поста' })}
              rows={8}
              disabled={loading}
            />
          </div>

          {availableTags.length > 0 && (
            <div className="create-forum-post-dialog__field">
              <Label>
                {t('forum.tags', { defaultValue: 'Теги' })} ({selectedTags.size}/5)
              </Label>
              <div className="create-forum-post-dialog__tags">
                {availableTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={clsx('create-forum-post-dialog__tag', {
                      'create-forum-post-dialog__tag--selected': selectedTags.has(tag.name),
                      'create-forum-post-dialog__tag--disabled':
                        !selectedTags.has(tag.name) && selectedTags.size >= 5,
                    })}
                    style={{ '--tag-color': tag.color } as React.CSSProperties}
                    onClick={() => handleToggleTag(tag.name)}
                    disabled={!selectedTags.has(tag.name) && selectedTags.size >= 5}
                  >
                    {tag.emoji && (
                      <span className="create-forum-post-dialog__tag-emoji">{tag.emoji}</span>
                    )}
                    <span className="create-forum-post-dialog__tag-name">{tag.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={loading}>
          {t('common.cancel', { defaultValue: 'Отмена' })}
        </Button>
        <Button onClick={handleSubmit} disabled={loading || !title.trim() || !content.trim()}>
          {loading
            ? t('common.loading', { defaultValue: 'Загрузка...' })
            : t('forum.create', { defaultValue: 'Создать' })}
        </Button>
      </DialogFooter>
    </Dialog>,
    document.body,
  );
}

