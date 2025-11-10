import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { Message } from '../../types';

interface AnnouncementMessageProps {
  message: Message;
  children: React.ReactNode;
  isCrossPost?: boolean;
  sourceChannelName?: string;
}

export function AnnouncementMessage({
  message,
  children,
  isCrossPost = false,
  sourceChannelName,
}: AnnouncementMessageProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="announcement-message">
      <div className="announcement-message__banner">
        <span className="announcement-message__badge">
          {t('channels.announcement', { defaultValue: 'ОБЪЯВЛЕНИЕ' })}
        </span>
        {isCrossPost && sourceChannelName && (
          <span className="announcement-message__source">
            {t('channels.crossPostedFrom', { defaultValue: 'Опубликовано из' })} #{sourceChannelName}
          </span>
        )}
      </div>
      <div className={clsx('announcement-message__content', { 'announcement-message__content--cross-post': isCrossPost })}>
        {children}
      </div>
    </div>
  );
}

