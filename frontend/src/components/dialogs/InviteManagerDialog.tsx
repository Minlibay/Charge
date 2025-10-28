import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import type { RoomInvitation, RoomRole } from '../../types';

interface InviteManagerDialogProps {
  open: boolean;
  roomSlug: string | null;
  invitations: RoomInvitation[];
  onClose: () => void;
}

export function InviteManagerDialog({ open, roomSlug, invitations, onClose }: InviteManagerDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const refreshInvitations = useWorkspaceStore((state) => state.refreshInvitations);
  const createInvitation = useWorkspaceStore((state) => state.createInvitation);
  const deleteInvitation = useWorkspaceStore((state) => state.deleteInvitation);
  const [role, setRole] = useState<RoomRole>('member');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    if (open && roomSlug) {
      setError(null);
      void refreshInvitations(roomSlug).catch((err) => {
        setError(err instanceof Error ? err.message : t('invites.unexpectedError'));
      });
    }
  }, [open, refreshInvitations, roomSlug, t]);

  useEffect(() => {
    if (!open) {
      setRole('member');
      setExpiresAt('');
      setError(null);
      setCopiedId(null);
    }
  }, [open]);

  const sortedInvitations = useMemo(
    () => invitations.slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [invitations],
  );

  if (!open || !roomSlug || typeof document === 'undefined') {
    return null;
  }

  const inviteLink = (code: string): string => {
    if (typeof window === 'undefined') {
      return code;
    }
    return `${window.location.origin}/#/invite/${code}`;
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await createInvitation(roomSlug, {
        role,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setExpiresAt('');
      setRole('member');
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

  const handleDelete = async (invitationId: number) => {
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

  const handleCopy = async (invitation: RoomInvitation) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setError(t('invites.copyFailed'));
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteLink(invitation.code));
      setCopiedId(invitation.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invites.copyFailed'));
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="invite-manager-title">
        <header className="modal-header">
          <div>
            <h2 id="invite-manager-title">{t('invites.manageTitle')}</h2>
            <p className="modal-description">{t('invites.manageSubtitle')}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        <form className="auth-form" onSubmit={handleCreate}>
          <label className="field">
            {t('invites.roleLabel')}
            <select value={role} onChange={(event) => setRole(event.target.value as RoomRole)}>
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
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
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
        {error && <p className="auth-form__error" role="alert">{error}</p>}
        <div className="modal-body">
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
                    <button type="button" className="ghost" onClick={() => handleCopy(invitation)}>
                      {copiedId === invitation.id ? t('invites.copied') : t('invites.copyLink')}
                    </button>
                    <button type="button" className="ghost danger" onClick={() => handleDelete(invitation.id)}>
                      {t('invites.delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
