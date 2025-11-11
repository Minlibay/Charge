import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { RoomDetail } from '../types';
import { CheckCircleIcon } from './icons/LucideIcons';

interface InviteSuccessDialogProps {
  open: boolean;
  room: RoomDetail | null;
  onClose: () => void;
  onGoToChannels: () => void;
}

export function InviteSuccessDialog({
  open,
  room,
  onClose,
  onGoToChannels,
}: InviteSuccessDialogProps): JSX.Element | null {
  const { t } = useTranslation();

  if (!open || !room || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="modal-dialog invite-success-modal" role="dialog" aria-modal="true" aria-labelledby="invite-success-title">
        <header className="modal-header">
          <div className="modal-header__content">
            <h2 id="invite-success-title" className="modal-title">
              {t('invites.success.title', { defaultValue: 'Поздравляем, вы присоединились к комнате!' })}
            </h2>
            <p className="modal-description">
              {t('invites.success.subtitle', {
                defaultValue: 'Вы успешно присоединились к комнате "{{roomName}}"',
                roomName: room.title,
              })}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <svg className="modal-close__icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M5 5L15 15M15 5L5 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>
        <div className="modal-content">
          <div className="invite-success-content">
            <div className="invite-success-icon">
              <CheckCircleIcon size={64} strokeWidth={2} />
            </div>
            <div className="invite-success-info">
              <h3 className="invite-success-room-name">{room.title}</h3>
              <p className="invite-success-description">
                {t('invites.success.description', {
                  defaultValue: 'Теперь вы можете общаться с участниками этой комнаты',
                })}
              </p>
            </div>
            <div className="invite-success-actions">
              <button type="button" className="auth-button auth-button--primary" onClick={onGoToChannels}>
                {t('invites.success.goToChannels', { defaultValue: 'Перейти в каналы' })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

