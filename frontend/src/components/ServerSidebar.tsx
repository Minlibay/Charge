import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import type { RoomSummary } from '../types';

interface ServerSidebarProps {
  rooms: RoomSummary[];
  selectedRoomSlug: string | null;
  onSelect: (slug: string) => void;
}

export function ServerSidebar({ rooms, selectedRoomSlug, onSelect }: ServerSidebarProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <aside className="server-sidebar" aria-label={t('servers.title')}>
      <header className="sidebar-header">
        <h2>{t('servers.title')}</h2>
        <button type="button" className="ghost" disabled>
          {t('servers.create')}
        </button>
      </header>
      {rooms.length === 0 ? (
        <p className="sidebar-empty" role="status">
          {t('servers.empty')}
        </p>
      ) : (
        <ul className="server-list">
          {rooms.map((room) => {
            const isActive = room.slug === selectedRoomSlug;
            return (
              <li key={room.id}>
                <button
                  type="button"
                  className={clsx('server-pill', { 'server-pill--active': isActive })}
                  onClick={() => onSelect(room.slug)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="server-pill__initials" aria-hidden="true">
                    {room.title
                      .split(/\s+/)
                      .map((chunk) => chunk.charAt(0).toUpperCase())
                      .slice(0, 2)
                      .join('') || '#'}
                  </span>
                  <span className="server-pill__label">{room.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
