import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ServerList } from './ServerList';
import type { RoomSummary } from '../types';

interface ServerSidebarProps {
  rooms: RoomSummary[];
  selectedRoomSlug: string | null;
  onSelect: (slug: string) => void;
}

export const ServerSidebar = memo(function ServerSidebar({ rooms, selectedRoomSlug, onSelect }: ServerSidebarProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <aside className="server-sidebar" aria-label={t('servers.title')}>
      <ServerList rooms={rooms} selectedRoomSlug={selectedRoomSlug} onSelect={onSelect} />
    </aside>
  );
});
