import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import type { Channel, Message, CrossPostRead } from '../../types';
import { crossPostAnnouncement, getCrossPosts } from '../../services/api';
import { XIcon } from '../icons/LucideIcons';
import { useToast } from '../ui';

interface CrossPostDialogProps {
  open: boolean;
  channel: Channel | undefined;
  message: Message | null;
  availableChannels: Channel[];
  existingCrossPosts?: CrossPostRead[];
  onClose: () => void;
  onSuccess?: () => void;
}

export function CrossPostDialog({
  open,
  channel,
  message,
  availableChannels,
  existingCrossPosts = [],
  onClose,
  onSuccess,
}: CrossPostDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crossPosts, setCrossPosts] = useState<CrossPostRead[]>(existingCrossPosts);

  // Filter out the current channel and channels that already have cross-posts
  const selectableChannels = useMemo(() => {
    const existingChannelIds = new Set(crossPosts.map((cp) => cp.target_channel_id));
    return availableChannels.filter(
      (ch) => ch.id !== channel?.id && !existingChannelIds.has(ch.id) && ch.type === 'text',
    );
  }, [availableChannels, channel?.id, crossPosts]);

  useEffect(() => {
    if (open && message && channel) {
      // Load existing cross-posts
      getCrossPosts(channel.id, message.id)
        .then(setCrossPosts)
        .catch((err) => {
          console.error('Failed to load cross-posts:', err);
        });
      setSelectedChannels(new Set());
      setError(null);
    }
  }, [open, message, channel]);

  const handleToggleChannel = (channelId: number) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channel || !message || selectedChannels.size === 0) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await crossPostAnnouncement(channel.id, message.id, {
        target_channel_ids: Array.from(selectedChannels),
      });
      setCrossPosts((prev) => [...prev, ...result]);
      setSelectedChannels(new Set());
      pushToast({
        type: 'success',
        message: t('channels.crossPostSuccess', {
          defaultValue: 'Объявление успешно опубликовано в выбранных каналах',
        }),
      });
      onSuccess?.();
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : t('channels.crossPostError', { defaultValue: 'Не удалось опубликовать объявление' });
      setError(errorMessage);
      pushToast({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  };

  if (!open || !channel || !message || typeof document === 'undefined') {
    return null;
  }

  const existingChannelIds = new Set(crossPosts.map((cp) => cp.target_channel_id));
  const existingChannels = availableChannels.filter((ch) => existingChannelIds.has(ch.id));

  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__header">
          <h2 className="dialog__title">
            {t('channels.crossPostTitle', { defaultValue: 'Опубликовать объявление' })}
          </h2>
          <button
            type="button"
            className="dialog__close"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Закрыть' })}
          >
            <XIcon />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="dialog__body">
          {error && (
            <div className="dialog__error" role="alert">
              {error}
            </div>
          )}

          {existingChannels.length > 0 && (
            <div className="cross-post-dialog__existing">
              <h3 className="cross-post-dialog__section-title">
                {t('channels.alreadyCrossPosted', { defaultValue: 'Уже опубликовано в' })}
              </h3>
              <ul className="cross-post-dialog__existing-list">
                {existingChannels.map((ch) => (
                  <li key={ch.id} className="cross-post-dialog__existing-item">
                    <span className="cross-post-dialog__channel-name">#{ch.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {selectableChannels.length > 0 ? (
            <div className="cross-post-dialog__channels">
              <h3 className="cross-post-dialog__section-title">
                {t('channels.selectChannels', { defaultValue: 'Выберите каналы для публикации' })}
              </h3>
              <div className="cross-post-dialog__channel-list">
                {selectableChannels.map((ch) => (
                  <label
                    key={ch.id}
                    className={clsx('cross-post-dialog__channel-item', {
                      'cross-post-dialog__channel-item--selected': selectedChannels.has(ch.id),
                    })}
                  >
                    <input
                      type="checkbox"
                      checked={selectedChannels.has(ch.id)}
                      onChange={() => handleToggleChannel(ch.id)}
                      className="cross-post-dialog__checkbox"
                    />
                    <span className="cross-post-dialog__channel-name">#{ch.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <p className="cross-post-dialog__empty">
              {t('channels.noChannelsAvailable', {
                defaultValue: 'Нет доступных каналов для публикации',
              })}
            </p>
          )}

          <div className="dialog__actions">
            <button
              type="button"
              className="dialog__button dialog__button--secondary"
              onClick={onClose}
              disabled={loading}
            >
              {t('common.cancel', { defaultValue: 'Отмена' })}
            </button>
            <button
              type="submit"
              className="dialog__button dialog__button--primary"
              disabled={loading || selectedChannels.size === 0}
            >
              {loading
                ? t('common.loading', { defaultValue: 'Загрузка...' })
                : t('channels.publish', { defaultValue: 'Опубликовать' })}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

