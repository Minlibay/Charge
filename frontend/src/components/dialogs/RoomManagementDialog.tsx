import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import { useWorkspaceStore } from '../../state/workspaceStore';
import type { RoomInvitation, RoomMemberSummary, RoomRole } from '../../types';
import { CopyIcon, ExternalLinkIcon, UserIcon, SettingsIcon, MailIcon } from '../icons/LucideIcons';

interface RoomManagementDialogProps {
  open: boolean;
  roomSlug: string | null;
  onClose: () => void;
}

type Tab = 'overview' | 'members' | 'invitations';

export function RoomManagementDialog({
  open,
  roomSlug,
  onClose,
}: RoomManagementDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const roomDetail = useWorkspaceStore((state) =>
    roomSlug ? state.roomDetails[roomSlug] : null,
  );
  const updateRoom = useWorkspaceStore((state) => state.updateRoom);
  const updateMemberRole = useWorkspaceStore((state) => state.updateMemberRole);
  const refreshInvitations = useWorkspaceStore((state) => state.refreshInvitations);
  const createInvitation = useWorkspaceStore((state) => state.createInvitation);
  const deleteInvitation = useWorkspaceStore((state) => state.deleteInvitation);
  const loadRoom = useWorkspaceStore((state) => state.loadRoom);

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [roomTitle, setRoomTitle] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Invitation form state
  const [inviteRole, setInviteRole] = useState<RoomRole>('member');
  const [inviteExpiresAt, setInviteExpiresAt] = useState('');

  useEffect(() => {
    if (open && roomSlug) {
      setError(null);
      if (roomDetail) {
        setRoomTitle(roomDetail.title);
      } else {
        void loadRoom(roomSlug);
      }
      void refreshInvitations(roomSlug).catch((err) => {
        setError(err instanceof Error ? err.message : t('invites.unexpectedError'));
      });
    }
  }, [open, roomSlug, roomDetail, loadRoom, refreshInvitations, t]);

  useEffect(() => {
    if (roomDetail) {
      setRoomTitle(roomDetail.title);
    }
  }, [roomDetail]);

  useEffect(() => {
    if (!open) {
      setActiveTab('overview');
      setError(null);
      setCopiedLink(false);
      setCopiedInviteId(null);
      setInviteRole('member');
      setInviteExpiresAt('');
    }
  }, [open]);

  if (!open || !roomSlug || !roomDetail || typeof document === 'undefined') {
    return null;
  }

  const inviteLink = (code: string): string => {
    if (typeof window === 'undefined') {
      return code;
    }
    return `${window.location.origin}/#/invite/${code}`;
  };

  const publicInviteLink = roomDetail.invitations.length > 0
    ? inviteLink(roomDetail.invitations[0].code)
    : null;

  const handleSaveTitle = async (event: FormEvent) => {
    event.preventDefault();
    if (!roomSlug || !roomTitle.trim()) {
      return;
    }
    setSavingTitle(true);
    setError(null);
    try {
      await updateRoom(roomSlug, { title: roomTitle.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.updateFailed'));
    } finally {
      setSavingTitle(false);
    }
  };

  const handleCopyLink = async () => {
    if (!publicInviteLink || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(publicInviteLink);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.copyFailed'));
    }
  };

  const handleCopyInvite = async (invitation: RoomInvitation) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setError(t('invites.copyFailed'));
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteLink(invitation.code));
      setCopiedInviteId(invitation.id);
      window.setTimeout(() => setCopiedInviteId(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invites.copyFailed'));
    }
  };

  const handleCreateInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (!roomSlug) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await createInvitation(roomSlug, {
        role: inviteRole,
        expires_at: inviteExpiresAt ? new Date(inviteExpiresAt).toISOString() : null,
      });
      setInviteExpiresAt('');
      setInviteRole('member');
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('invites.unexpectedError'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteInvitation = async (invitationId: number) => {
    if (!roomSlug) {
      return;
    }
    setError(null);
    try {
      await deleteInvitation(roomSlug, invitationId);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('invites.unexpectedError'));
      }
    }
  };

  const handleUpdateMemberRole = async (userId: number, role: RoomRole) => {
    if (!roomSlug) {
      return;
    }
    setError(null);
    try {
      await updateMemberRole(roomSlug, userId, role);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('rooms.updateMemberRoleFailed'));
      }
    }
  };

  const sortedInvitations = useMemo(
    () =>
      roomDetail.invitations
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [roomDetail.invitations],
  );

  const sortedMembers = useMemo(
    () =>
      roomDetail.members
        .slice()
        .sort((a, b) => {
          const aName = (a.display_name || a.login || '').toLowerCase();
          const bName = (b.display_name || b.login || '').toLowerCase();
          return aName.localeCompare(bName);
        }),
    [roomDetail.members],
  );

  const canManage = roomDetail.current_role === 'owner' || roomDetail.current_role === 'admin';

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="room-management-title">
        <header className="modal-header">
          <div>
            <h2 id="room-management-title">{t('rooms.management.title', { defaultValue: 'Управление комнатой' })}</h2>
            <p className="modal-description">
              {t('rooms.management.subtitle', { defaultValue: 'Управление настройками и участниками комнаты' })}
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        {error && <p className="auth-form__error" role="alert">{error}</p>}
        <div className="channel-settings-tabs">
          <button
            type="button"
            className={clsx('channel-settings-tab', { 'is-active': activeTab === 'overview' })}
            onClick={() => setActiveTab('overview')}
          >
            <SettingsIcon size={16} strokeWidth={1.8} />
            {t('rooms.management.tabs.overview', { defaultValue: 'Обзор' })}
          </button>
          <button
            type="button"
            className={clsx('channel-settings-tab', { 'is-active': activeTab === 'members' })}
            onClick={() => setActiveTab('members')}
          >
            <UserIcon size={16} strokeWidth={1.8} />
            {t('rooms.management.tabs.members', { defaultValue: 'Участники' })}
            <span className="channel-settings-tab__badge">{roomDetail.members.length}</span>
          </button>
          <button
            type="button"
            className={clsx('channel-settings-tab', { 'is-active': activeTab === 'invitations' })}
            onClick={() => setActiveTab('invitations')}
          >
            <MailIcon size={16} strokeWidth={1.8} />
            {t('rooms.management.tabs.invitations', { defaultValue: 'Приглашения' })}
          </button>
        </div>
        <div className="modal-body">
          {activeTab === 'overview' && (
            <div className="channel-settings-content">
              <div className="room-overview">
              <form className="auth-form" onSubmit={handleSaveTitle}>
                <label className="field">
                  {t('rooms.management.roomName', { defaultValue: 'Название комнаты' })}
                  <input
                    type="text"
                    value={roomTitle}
                    onChange={(e) => setRoomTitle(e.target.value)}
                    disabled={!canManage || savingTitle}
                    maxLength={128}
                  />
                </label>
                {canManage && (
                  <div className="auth-form__footer">
                    <div />
                    <button type="submit" className="primary" disabled={savingTitle || !roomTitle.trim()}>
                      {savingTitle ? t('common.loading') : t('common.save')}
                    </button>
                  </div>
                )}
              </form>
              <div className="room-info">
                <div className="room-info__item">
                  <label>{t('rooms.management.slug', { defaultValue: 'URL идентификатор' })}</label>
                  <div className="room-info__value">
                    <code>{roomDetail.slug}</code>
                  </div>
                </div>
                <div className="room-info__item">
                  <label>{t('rooms.management.publicLink', { defaultValue: 'Публичная ссылка' })}</label>
                  <div className="room-info__value">
                    {publicInviteLink ? (
                      <div className="room-info__link">
                        <code>{publicInviteLink}</code>
                        <button
                          type="button"
                          className="ghost button-with-icon"
                          onClick={handleCopyLink}
                          title={t('common.copy')}
                        >
                          <CopyIcon size={16} strokeWidth={1.8} />
                          {copiedLink ? t('common.copied') : t('common.copy')}
                        </button>
                      </div>
                    ) : (
                      <span className="room-info__empty">
                        {t('rooms.management.noInvites', { defaultValue: 'Нет активных приглашений' })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="room-info__item">
                  <label>{t('rooms.management.memberCount', { defaultValue: 'Количество участников' })}</label>
                  <div className="room-info__value">{roomDetail.members.length}</div>
                </div>
                <div className="room-info__item">
                  <label>{t('rooms.management.createdAt', { defaultValue: 'Создана' })}</label>
                  <div className="room-info__value">
                    {new Date(roomDetail.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
              </div>
            </div>
          )}
          {activeTab === 'members' && (
            <div className="channel-settings-content">
              <div className="room-members">
                {sortedMembers.length === 0 ? (
                  <p className="sidebar-empty">{t('rooms.management.noMembers', { defaultValue: 'Нет участников' })}</p>
                ) : (
                  <ul className="member-list">
                    {sortedMembers.map((member) => (
                      <li key={member.user_id} className="member-item">
                        <div className="member-item__info">
                          {member.avatar_url ? (
                            <img
                              src={member.avatar_url}
                              alt=""
                              className="member-item__avatar"
                              width={32}
                              height={32}
                            />
                          ) : (
                            <div className="member-item__avatar member-item__avatar--placeholder">
                              {(member.display_name || member.login || '?')[0].toUpperCase()}
                            </div>
                          )}
                          <div>
                            <p className="member-item__name">
                              {member.display_name || member.login}
                            </p>
                            <p className="member-item__login">{member.login}</p>
                          </div>
                        </div>
                        <div className="member-item__actions">
                          {canManage && (
                            <select
                              value={member.role}
                              onChange={(e) => handleUpdateMemberRole(member.user_id, e.target.value as RoomRole)}
                              className="member-role-select"
                            >
                              <option value="owner">{t('roles.owner')}</option>
                              <option value="admin">{t('roles.admin')}</option>
                              <option value="member">{t('roles.member')}</option>
                              <option value="guest">{t('roles.guest')}</option>
                            </select>
                          )}
                          {!canManage && (
                            <span className="member-role-badge">{t(`roles.${member.role}`)}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {activeTab === 'invitations' && (
            <div className="channel-settings-content">
              <div className="room-invitations">
                {canManage && (
                <form className="auth-form" onSubmit={handleCreateInvitation}>
                  <label className="field">
                    {t('invites.roleLabel')}
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as RoomRole)}
                    >
                      <option value="owner">{t('roles.owner')}</option>
                      <option value="admin">{t('roles.admin')}</option>
                      <option value="member">{t('roles.member')}</option>
                      <option value="guest">{t('roles.guest')}</option>
                    </select>
                  </label>
                  <label className="field">
                    {t('invites.expirationLabel')}
                    <input
                      type="datetime-local"
                      value={inviteExpiresAt}
                      onChange={(e) => setInviteExpiresAt(e.target.value)}
                    />
                    <span className="field-hint">{t('invites.expirationHint')}</span>
                  </label>
                  <div className="auth-form__footer">
                    <div />
                    <button type="submit" className="primary" disabled={loading}>
                      {loading ? t('common.loading') : t('invites.createButton')}
                    </button>
                  </div>
                </form>
                )}
                {sortedInvitations.length === 0 ? (
                  <p className="sidebar-empty">{t('invites.none')}</p>
                ) : (
                  <ul className="invite-list">
                    {sortedInvitations.map((invitation) => (
                      <li key={invitation.id} className="invite-item">
                        <div>
                          <p className="invite-item__code">{invitation.code}</p>
                          <p className="invite-item__meta">
                            <span>
                              {t('invites.roleValue', { role: t(`roles.${invitation.role}`) })}
                            </span>
                            {invitation.expires_at ? (
                              <span>
                                {t('invites.expiresAt', {
                                  date: new Date(invitation.expires_at).toLocaleString(),
                                })}
                              </span>
                            ) : (
                              <span>{t('invites.noExpiration')}</span>
                            )}
                          </p>
                        </div>
                        <div className="invite-item__actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleCopyInvite(invitation)}
                          >
                            {copiedInviteId === invitation.id ? t('invites.copied') : t('invites.copyLink')}
                          </button>
                          {canManage && (
                            <button
                              type="button"
                              className="ghost danger"
                              onClick={() => handleDeleteInvitation(invitation.id)}
                            >
                              {t('invites.delete')}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

