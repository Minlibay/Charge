import { useTranslation } from 'react-i18next';

import type { PresenceUser } from '../types';

interface PresenceListProps {
  users: PresenceUser[];
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
          {users.map((user) => (
            <li key={user.id}>
              <span className="presence-avatar" aria-hidden="true">
                {user.display_name.charAt(0).toUpperCase()}
              </span>
              <span className="presence-name">{user.display_name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
