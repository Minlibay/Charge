import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PinnedMessage } from '../../types';
import { formatDateTime } from '../../utils/format';

interface PinnedPanelProps {
  pins: PinnedMessage[];
  onSelect?: (messageId: number) => void;
  onRefresh?: () => void;
  onUnpin?: (messageId: number) => void;
  loading?: boolean;
}

export function PinnedPanel({ pins, onSelect, onRefresh, onUnpin, loading = false }: PinnedPanelProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const sortedPins = useMemo(() => {
    return [...pins].sort((a, b) => new Date(b.pinned_at).getTime() - new Date(a.pinned_at).getTime());
  }, [pins]);

  const handleToggle = () => {
    setExpanded((prev) => !prev);
  };

  if (pins.length === 0 && !loading) {
    return (
      <div className="pinned-panel" aria-live="polite">
        <button type="button" className="pinned-panel__toggle" onClick={onRefresh} disabled={loading}>
          {t('chat.pinsEmpty', { defaultValue: 'Нет закрепленных сообщений' })}
        </button>
      </div>
    );
  }

  return (
    <section className="pinned-panel" aria-label={t('chat.pinsLabel', { defaultValue: 'Закрепленные сообщения' })}>
      <header className="pinned-panel__header">
        <button type="button" className="pinned-panel__toggle" onClick={handleToggle}>
          {expanded
            ? t('chat.hidePins', { defaultValue: 'Скрыть закрепы' })
            : t('chat.showPins', { count: pins.length, defaultValue: 'Закрепы ({{count}})' })}
        </button>
        <div className="pinned-panel__actions">
          <span className="pinned-panel__count">{pins.length}</span>
          <button type="button" className="ghost" onClick={onRefresh} disabled={loading}>
            {t('common.refresh', { defaultValue: 'Обновить' })}
          </button>
        </div>
      </header>
      {expanded && (
        <ul className="pinned-panel__list">
          {sortedPins.map((pin) => {
            const authorName =
              pin.message.author?.display_name || pin.message.author?.login || t('chat.unknownUser', { defaultValue: 'Участник' });
            const timestamp = formatDateTime(pin.pinned_at, i18n.language);
            const excerpt = pin.message.content.trim() || t('chat.attachmentMessage', { defaultValue: 'Вложение' });
            return (
              <li key={pin.id} className="pinned-panel__item">
                <button
                  type="button"
                  className="pinned-panel__item-body"
                  onClick={() => onSelect?.(pin.message_id)}
                >
                  <span className="pinned-panel__item-author">{authorName}</span>
                  <span className="pinned-panel__item-meta">{timestamp}</span>
                  <span className="pinned-panel__item-excerpt">{excerpt}</span>
                </button>
                {onUnpin && (
                  <button
                    type="button"
                    className="ghost pinned-panel__item-action"
                    onClick={() => onUnpin(pin.message_id)}
                  >
                    {t('chat.unpin', { defaultValue: 'Открепить' })}
                  </button>
                )}
              </li>
            );
          })}
          {sortedPins.length === 0 && !loading && (
            <li className="pinned-panel__empty">{t('chat.pinsEmpty', { defaultValue: 'Нет закрепленных сообщений' })}</li>
          )}
          {loading && (
            <li className="pinned-panel__empty">{t('common.loading')}</li>
          )}
        </ul>
      )}
    </section>
  );
}
