import { useTranslation } from 'react-i18next';

import type { PresenceUser } from '../types';

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

export function PresenceList({ users }: PresenceListProps): JSX.Element {
  const { t } = useTranslation();

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
            return (
              <li key={user.id} className="presence-item">
                <div className="presence-avatar" aria-hidden="true">
                  {user.avatar_url ? (
                    <img src={user.avatar_url} alt="" />
                  ) : (
                    <span>{user.display_name.charAt(0).toUpperCase()}</span>
                  )}
                  <span
                    className={`presence-indicator presence-indicator--${user.status}`}
                    aria-label={label}
                  />
                </div>
                <div className="presence-meta">
                  <span className="presence-name">{user.display_name}</span>
                  <span className="presence-status-text">{label}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
