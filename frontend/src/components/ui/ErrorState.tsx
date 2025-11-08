import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { AlertCircleIcon, RefreshCwIcon, XIcon } from '../icons/LucideIcons';

export type ErrorStateVariant = 'error' | 'warning' | 'info' | 'empty';

interface ErrorStateProps {
  variant?: ErrorStateVariant;
  title?: string;
  message?: string;
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
}

export function ErrorState({
  variant = 'error',
  title,
  message,
  icon,
  actionLabel,
  onAction,
  dismissible = false,
  onDismiss,
  className,
}: ErrorStateProps): JSX.Element {
  const { t } = useTranslation();

  const defaultTitle =
    title ??
    (variant === 'error'
      ? t('errors.title', { defaultValue: 'Произошла ошибка' })
      : variant === 'warning'
        ? t('errors.warningTitle', { defaultValue: 'Предупреждение' })
        : variant === 'info'
          ? t('errors.infoTitle', { defaultValue: 'Информация' })
          : t('errors.emptyTitle', { defaultValue: 'Пусто' }));

  const defaultMessage =
    message ??
    (variant === 'error'
      ? t('errors.message', { defaultValue: 'Что-то пошло не так. Попробуйте обновить страницу.' })
      : variant === 'warning'
        ? t('errors.warningMessage', { defaultValue: 'Обратите внимание на это предупреждение.' })
        : variant === 'info'
          ? t('errors.infoMessage', { defaultValue: 'Информационное сообщение.' })
          : t('errors.emptyMessage', { defaultValue: 'Здесь пока ничего нет.' }));

  const defaultIcon =
    icon ??
    (variant === 'error' ? (
      <AlertCircleIcon size={48} strokeWidth={1.5} />
    ) : variant === 'warning' ? (
      <AlertCircleIcon size={48} strokeWidth={1.5} />
    ) : variant === 'info' ? (
      <AlertCircleIcon size={48} strokeWidth={1.5} />
    ) : null);

  const defaultActionLabel =
    actionLabel ??
    (variant === 'error'
      ? t('errors.retry', { defaultValue: 'Повторить' })
      : variant === 'warning'
        ? t('errors.dismiss', { defaultValue: 'Понятно' })
        : undefined);

  return (
    <div className={clsx('error-state', `error-state--${variant}`, className)} role="alert">
      {dismissible && onDismiss && (
        <button
          type="button"
          className="error-state__dismiss ghost"
          onClick={onDismiss}
          aria-label={t('common.close', { defaultValue: 'Закрыть' })}
        >
          <XIcon size={16} strokeWidth={2} />
        </button>
      )}
      <div className="error-state__content">
        {defaultIcon && <div className="error-state__icon" aria-hidden="true">{defaultIcon}</div>}
        <h3 className="error-state__title">{defaultTitle}</h3>
        <p className="error-state__message">{defaultMessage}</p>
        {onAction && defaultActionLabel && (
          <button type="button" className="error-state__action" onClick={onAction}>
            {variant === 'error' && <RefreshCwIcon size={16} strokeWidth={2} />}
            {defaultActionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

