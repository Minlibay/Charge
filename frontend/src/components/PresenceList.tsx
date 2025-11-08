import * as ContextMenu from './ui/ContextMenu';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresenceUser } from '../types';
import { logger } from '../services/logger';

interface PresenceListProps {
  users: PresenceUser[];
}

function statusLabel(status: PresenceUser['status'], t: (key: string, options?: Record<string, unknown>) => string): string {
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

export const PresenceList = memo(function PresenceList({ users }: PresenceListProps): JSX.Element {
  const { t } = useTranslation();

  const handleCopy = useCallback((value: string, fallbackMessage: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {
      logger.warn(fallbackMessage);
    });
  }, []);

  return (
    <section className="presence-panel" aria-labelledby="presence-title">
      <header className="panel-header">
        <h2 id="presence-title">{t('presence.title')}</h2>
        <span className="panel-count" aria-label="online count">
          {users.length}
        </span>
      </header>
      {users.length === 0 ? (
        <p className="panel-empty">{t('presence.empty')}</p>
      ) : (
        <ul className="presence-list">
          {users.map((user) => {
            const label = statusLabel(user.status, t);
            const displayName = user.display_name || user.id.toString();
            return (
              <ContextMenu.Root key={user.id}>
                <ContextMenu.Trigger asChild>
                  <li
                    id={`presence-user-${user.id}`}
                    className="presence-item"
                    tabIndex={-1}
                    aria-label={t('presence.focusUser', {
                      defaultValue: 'Пользователь {{name}}',
                      name: displayName,
                    })}
                  >
                    <div className="presence-avatar" aria-hidden="true">
                      {user.avatar_url ? (
                        <img src={user.avatar_url} alt="" />
                      ) : (
                        <span>{displayName.charAt(0).toUpperCase()}</span>
                      )}
                      <span
                        className={`presence-indicator presence-indicator--${user.status}`}
                        aria-label={label}
                      />
                    </div>
                    <div className="presence-meta">
                      <span className="presence-name">{displayName}</span>
                      <span className="presence-status-text">{label}</span>
                    </div>
                  </li>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className="context-menu" sideOffset={4} align="end">
                    <ContextMenu.Label className="context-menu__label">
                      {displayName}
                    </ContextMenu.Label>
                    <ContextMenu.Item
                      className="context-menu__item"
                      disabled={!navigator.clipboard}
                      onSelect={() => handleCopy(displayName, 'Failed to copy display name')}
                    >
                      {t('presence.copyName', { defaultValue: 'Скопировать имя' })}
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className="context-menu__item"
                      disabled={!navigator.clipboard}
                      onSelect={() => handleCopy(String(user.id), 'Failed to copy user id')}
                    >
                      {t('presence.copyId', { defaultValue: 'Скопировать ID' })}
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
        </ul>
      )}
    </section>
  );
});
