import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/api';
import { useDirectStore } from '../../stores/directStore';
import type { PresenceStatus } from '../../types';
import { logger } from '../../services/logger';

interface ProfilePageProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_OPTIONS: PresenceStatus[] = ['online', 'idle', 'dnd'];

function statusLabel(
  status: PresenceStatus,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
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

function formatTimestamp(value: string | null | undefined, locale: string, fallback: string): string {
  if (!value) {
    return fallback;
  }
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch (error) {
    return value;
  }
}

interface ProfileEditDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

function ProfileEditDialog({ open, onClose, onSuccess, onError }: ProfileEditDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const profile = useDirectStore((state) => state.profile);
  const updateProfile = useDirectStore((state) => state.updateProfile);
  const uploadAvatar = useDirectStore((state) => state.uploadAvatar);

  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<PresenceStatus>('online');
  const [savingProfile, setSavingProfile] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();
  const [localFeedback, setLocalFeedback] = useState<string | undefined>();

  useEffect(() => {
    if (!open || !profile) {
      return;
    }
    setDisplayName(profile.display_name ?? '');
    setStatus(profile.status);
    setLocalError(undefined);
    setLocalFeedback(undefined);
  }, [open, profile]);

  if (!open) {
    return null;
  }

  const handleProfileSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile) {
      return;
    }
    setSavingProfile(true);
    setLocalError(undefined);
    try {
      await updateProfile({ display_name: displayName.trim() || null, status });
      const message = t('profile.saved', { defaultValue: 'Профиль обновлен' });
      setLocalFeedback(message);
      onSuccess(message);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.saveError', { defaultValue: 'Не удалось обновить профиль' });
      setLocalError(message);
      onError(message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setAvatarUploading(true);
    setLocalError(undefined);
    try {
      await uploadAvatar(file);
      const message = t('profile.avatarUpdated', { defaultValue: 'Аватар обновлен' });
      setLocalFeedback(message);
      onSuccess(message);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : t('profile.avatarError', { defaultValue: 'Не удалось обновить аватар' });
      setLocalError(message);
      onError(message);
    } finally {
      setAvatarUploading(false);
      event.target.value = '';
    }
  };

  const closeLabel = t('common.close', { defaultValue: 'Закрыть' });

  return (
    <div className="profile-edit-modal">
      <div className="profile-edit-backdrop" role="presentation" onClick={onClose} />
      <div className="profile-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-edit-title">
        <header className="profile-edit-header">
          <h3 id="profile-edit-title">{t('profile.editTitle', { defaultValue: 'Редактирование профиля' })}</h3>
          <button type="button" className="profile-close-button" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="profile-edit-content">
          <form className="profile-form" onSubmit={handleProfileSubmit}>
            <div className="profile-row">
              <label htmlFor="profile-display-name">{t('profile.displayName', { defaultValue: 'Отображаемое имя' })}</label>
              <input
                id="profile-display-name"
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={profile?.login ?? ''}
              />
            </div>
            <div className="profile-row">
              <label htmlFor="profile-status">{t('profile.status', { defaultValue: 'Статус' })}</label>
              <select
                id="profile-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as PresenceStatus)}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {statusLabel(option, t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="profile-actions">
              <button type="submit" className="primary" disabled={savingProfile}>
                {savingProfile
                  ? t('common.saving', { defaultValue: 'Сохранение…' })
                  : t('common.save', { defaultValue: 'Сохранить' })}
              </button>
            </div>
          </form>
          <div className="profile-avatar-upload">
            <div className="profile-avatar-preview">
              {profile?.avatar_url ? (
                <img src={profile.avatar_url} alt={t('profile.avatarAlt', { defaultValue: 'Аватар пользователя' })} />
              ) : (
                <div className="presence-avatar" aria-hidden="true">
                  <span>{(profile?.display_name || profile?.login || '?').charAt(0).toUpperCase()}</span>
                </div>
              )}
            </div>
            <div className="profile-row">
              <label htmlFor="profile-avatar">{t('profile.avatar', { defaultValue: 'Аватар' })}</label>
              <input
                id="profile-avatar"
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                disabled={avatarUploading}
              />
              {avatarUploading && <span className="profile-info">{t('profile.avatarUploading', { defaultValue: 'Загрузка…' })}</span>}
            </div>
          </div>
          {localFeedback && <p className="profile-success">{localFeedback}</p>}
          {localError && <p className="profile-error">{localError}</p>}
        </div>
      </div>
    </div>
  );
}

export function ProfilePage({ open, onClose }: ProfilePageProps): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const profile = useDirectStore((state) => state.profile);
  const initialize = useDirectStore((state) => state.initialize);
  const loading = useDirectStore((state) => state.loading);
  const storeError = useDirectStore((state) => state.error);

  const [editOpen, setEditOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) {
      setEditOpen(false);
      setFeedback(undefined);
      setActionError(undefined);
      return;
    }
    void initialize().catch((error) => {
      logger.warn('Failed to initialize friends store', undefined, error instanceof Error ? error : new Error(String(error)));
    });
  }, [initialize, open]);

  const statusText = useMemo(() => {
    if (!profile) {
      return t('profile.statusUnknown', { defaultValue: 'Неизвестно' });
    }
    return statusLabel(profile.status, t);
  }, [profile, t]);

  const createdAtText = useMemo(
    () => formatTimestamp(profile?.created_at, i18n.language, t('profile.notSet', { defaultValue: 'Не указано' })),
    [i18n.language, profile?.created_at, t],
  );

  const updatedAtText = useMemo(
    () => formatTimestamp(profile?.updated_at, i18n.language, t('profile.notSet', { defaultValue: 'Не указано' })),
    [i18n.language, profile?.updated_at, t],
  );

  if (!open) {
    return null;
  }

  const closeLabel = t('common.close', { defaultValue: 'Закрыть' });
  const title = t('profile.settingsTitle', { defaultValue: 'Настройки пользователя' });

  return (
    <div className="profile-page profile-page--open">
      <div className="profile-backdrop" role="presentation" onClick={onClose} />
      <div className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <header className="profile-header">
          <div>
            <h2 id="profile-title">{title}</h2>
            {feedback && <p className="profile-success">{feedback}</p>}
            {(actionError || storeError) && <p className="profile-error">{actionError ?? storeError}</p>}
          </div>
          <button type="button" className="profile-close-button" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="profile-content profile-content--settings">
          <section className="profile-section profile-section--summary">
            <div className="profile-summary">
              <div className="profile-avatar-preview">
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt={t('profile.avatarAlt', { defaultValue: 'Аватар пользователя' })} />
                ) : (
                  <div className="presence-avatar" aria-hidden="true">
                    <span>{(profile?.display_name || profile?.login || '?').charAt(0).toUpperCase()}</span>
                  </div>
                )}
              </div>
              <dl className="profile-summary-list">
                <div className="profile-summary-item">
                  <dt>{t('profile.displayName', { defaultValue: 'Отображаемое имя' })}</dt>
                  <dd>{profile?.display_name || t('profile.notSet', { defaultValue: 'Не указано' })}</dd>
                </div>
                <div className="profile-summary-item">
                  <dt>{t('profile.login', { defaultValue: 'Логин' })}</dt>
                  <dd>{profile?.login ?? '—'}</dd>
                </div>
                <div className="profile-summary-item">
                  <dt>{t('profile.status', { defaultValue: 'Статус' })}</dt>
                  <dd>{statusText}</dd>
                </div>
              </dl>
            </div>
            <div className="profile-summary-actions">
              <button
                type="button"
                className="primary"
                onClick={() => setEditOpen(true)}
                disabled={!profile}
              >
                {t('profile.editAction', { defaultValue: 'Редактировать профиль' })}
              </button>
            </div>
          </section>
          <section className="profile-section profile-section--settings">
            <h3>{t('profile.preferences', { defaultValue: 'Информация об аккаунте' })}</h3>
            <dl className="profile-settings-list">
              <div className="profile-settings-item">
                <dt>{t('profile.userId', { defaultValue: 'ID пользователя' })}</dt>
                <dd>{profile ? profile.id : '—'}</dd>
              </div>
              <div className="profile-settings-item">
                <dt>{t('profile.createdAt', { defaultValue: 'Дата регистрации' })}</dt>
                <dd>{createdAtText}</dd>
              </div>
              <div className="profile-settings-item">
                <dt>{t('profile.updatedAt', { defaultValue: 'Последнее изменение' })}</dt>
                <dd>{updatedAtText}</dd>
              </div>
            </dl>
          </section>
        </div>
        {loading && <div className="profile-loading-overlay">{t('common.loading', { defaultValue: 'Загрузка…' })}</div>}
      </div>
      <ProfileEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSuccess={(message) => {
          setFeedback(message);
          setActionError(undefined);
        }}
        onError={(message) => {
          setActionError(message);
          setFeedback(undefined);
        }}
      />
    </div>
  );
}
