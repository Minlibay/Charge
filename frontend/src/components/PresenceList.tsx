import * as ContextMenu from './ui/ContextMenu';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresenceUser, CustomRole } from '../types';
import { logger } from '../services/logger';
import { RoleBadge } from './ui/RoleBadge';

interface PresenceListProps {
  users: PresenceUser[];
  members?: Array<{ user_id: number; custom_roles?: CustomRole[] }>;
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

export const PresenceList = memo(function PresenceList({ users, members }: PresenceListProps): JSX.Element {
  const { t } = useTranslation();

  // Create a map of user_id -> custom_roles from members
  const rolesByUserId = useMemo(() => {
    const map = new Map<number, CustomRole[]>();
    if (members) {
      members.forEach((member) => {
        if (member.custom_roles && member.custom_roles.length > 0) {
          map.set(member.user_id, member.custom_roles);
        }
      });
    }
    return map;
  }, [members]);

  // Enrich presence users with custom roles
  const enrichedUsers = useMemo(() => {
    return users.map((user) => {
      const customRoles = rolesByUserId.get(user.id);
      return customRoles ? { ...user, custom_roles: customRoles } : user;
    });
  }, [users, rolesByUserId]);

  const handleCopy = useCallback((value: string, fallbackMessage: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {
      logger.warn(fallbackMessage);
    });
  }, []);

  return (
    <section className="presence-panel" aria-labelledby="presence-title">
      <header className="presence-panel__header">
        <div className="presence-panel__header-top">
          <h2 id="presence-title" className="presence-panel__title">{t('presence.title', { defaultValue: 'Онлайн' })}</h2>
          {users.length > 0 && (
            <span className="presence-panel__count" aria-label="online count">
              {users.length}
            </span>
          )}
        </div>
      </header>
      {enrichedUsers.length === 0 ? (
        <div className="presence-panel__empty-state">
          <p className="presence-panel__empty">{t('presence.empty', { defaultValue: 'Нет пользователей онлайн' })}</p>
        </div>
      ) : (
        <ul className="presence-list">
          {enrichedUsers.map((user) => {
            const label = statusLabel(user.status, t);
            const displayName = user.display_name || user.id.toString();
            return (
              <ContextMenu.Root key={user.id}>
                <ContextMenu.Trigger asChild>
                  <li
                    id={`presence-user-${user.id}`}
                    className="presence-card"
                    tabIndex={-1}
                    aria-label={t('presence.focusUser', {
                      defaultValue: 'Пользователь {{name}}',
                      name: displayName,
                    })}
                  >
                    <div className="presence-card__avatar" aria-hidden="true">
                      {user.avatar_url ? (
                        <img src={user.avatar_url} alt="" />
                      ) : (
                        <span className="presence-card__avatar-initial">
                          {displayName.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span
                        className={`presence-card__indicator presence-card__indicator--${user.status}`}
                        aria-label={label}
                      />
                    </div>
                    <div className="presence-card__content">
                      <div className="presence-card__name-row">
                        <span className="presence-card__name">{displayName}</span>
                        {user.custom_roles && user.custom_roles.length > 0 && (
                          <div className="presence-card__roles">
                            {user.custom_roles
                              .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
                              .map((role) => (
                                <RoleBadge key={role.id} role={role} />
                              ))}
                          </div>
                        )}
                      </div>
                      <span className="presence-card__status">{label}</span>
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
