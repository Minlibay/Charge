import { useMemo } from 'react';

import { useDirectStore } from '../../stores/directStore';

interface DirectNotificationBellProps {
  onOpen: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function DirectNotificationBell({ onOpen, t }: DirectNotificationBellProps): JSX.Element {
  const conversations = useDirectStore((state) => state.conversations);
  const unreadTotal = useMemo(
    () => conversations.reduce((sum, conversation) => sum + conversation.unread_count, 0),
    [conversations],
  );

  return (
    <button type="button" className="direct-notification-bell" onClick={onOpen}>
      <span>{t('direct.notifications', { defaultValue: 'Сообщения' })}</span>
      {unreadTotal > 0 ? <span className="badge">{unreadTotal}</span> : null}
    </button>
  );
}
