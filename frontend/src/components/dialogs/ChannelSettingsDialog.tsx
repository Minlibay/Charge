import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import type {
  Channel,
  ChannelPermission,
  ChannelPermissionSummary,
  ChannelRolePermissionOverwrite,
  ChannelUserPermissionOverwrite,
  RoomMemberSummary,
  RoomRoleLevel,
} from '../../types';

interface ChannelSettingsDialogProps {
  open: boolean;
  channel: Channel | null;
  roleHierarchy: RoomRoleLevel[];
  members: RoomMemberSummary[];
  onClose: () => void;
}

type PermissionState = 'allow' | 'deny' | 'inherit';

interface PermissionOption {
  id: ChannelPermission;
  labelKey: string;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'view', labelKey: 'channels.permissionNames.view' },
  { id: 'send_messages', labelKey: 'channels.permissionNames.send_messages' },
  { id: 'manage_messages', labelKey: 'channels.permissionNames.manage_messages' },
  { id: 'connect', labelKey: 'channels.permissionNames.connect' },
  { id: 'speak', labelKey: 'channels.permissionNames.speak' },
];

function findRoleOverwrite(
  summary: ChannelPermissionSummary | undefined,
  role: ChannelRolePermissionOverwrite['role'],
): ChannelRolePermissionOverwrite | undefined {
  return summary?.roles.find((entry) => entry.role === role);
}

function findUserOverwrite(
  summary: ChannelPermissionSummary | undefined,
  userId: number,
): ChannelUserPermissionOverwrite | undefined {
  return summary?.users.find((entry) => entry.user_id === userId);
}

export function ChannelSettingsDialog({
  open,
  channel,
  roleHierarchy,
  members,
  onClose,
}: ChannelSettingsDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const permissionsByChannel = useWorkspaceStore((state) => state.channelPermissions);
  const loadPermissions = useWorkspaceStore((state) => state.loadChannelPermissions);
  const updateRolePermissions = useWorkspaceStore((state) => state.updateChannelRolePermissions);
  const deleteRolePermissions = useWorkspaceStore((state) => state.deleteChannelRolePermissions);
  const updateUserPermissions = useWorkspaceStore((state) => state.updateChannelUserPermissions);
  const deleteUserPermissions = useWorkspaceStore((state) => state.deleteChannelUserPermissions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<number | ''>('');

  const summary = channel ? permissionsByChannel[channel.id] : undefined;

  useEffect(() => {
    if (!open || !channel) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadPermissions(channel.id)
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('channels.permissionsUpdateFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, channel?.id, loadPermissions, t]);

  const availableMembers = useMemo(() => {
    if (!channel) {
      return [];
    }
    const usedIds = new Set((summary?.users ?? []).map((entry) => entry.user_id));
    return members
      .filter((member) => !usedIds.has(member.user_id))
      .sort((a, b) => {
        const left = a.display_name ?? a.login;
        const right = b.display_name ?? b.login;
        return left.localeCompare(right);
      });
  }, [members, summary?.users, channel]);

  if (!open || !channel || typeof document === 'undefined') {
    return null;
  }

  const applyRoleChange = async (
    role: ChannelRolePermissionOverwrite['role'],
    permission: ChannelPermission,
    state: PermissionState,
  ) => {
    if (!channel) {
      return;
    }
    const key = `role:${role}:${permission}`;
    setPendingKey(key);
    setError(null);
    try {
      const existing = findRoleOverwrite(summary, role);
      const allow = new Set(existing?.allow ?? []);
      const deny = new Set(existing?.deny ?? []);
      if (state === 'allow') {
        allow.add(permission);
        deny.delete(permission);
      } else if (state === 'deny') {
        deny.add(permission);
        allow.delete(permission);
      } else {
        allow.delete(permission);
        deny.delete(permission);
      }
      if (!allow.size && !deny.size) {
        if (existing) {
          await deleteRolePermissions(channel.id, role);
        }
      } else {
        await updateRolePermissions(channel.id, role, {
          allow: Array.from(allow),
          deny: Array.from(deny),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.permissionsUpdateFailed'));
    } finally {
      setPendingKey(null);
    }
  };

  const applyUserChange = async (
    userId: number,
    permission: ChannelPermission,
    state: PermissionState,
  ) => {
    if (!channel) {
      return;
    }
    const key = `user:${userId}:${permission}`;
    setPendingKey(key);
    setError(null);
    try {
      const existing = findUserOverwrite(summary, userId);
      const allow = new Set(existing?.allow ?? []);
      const deny = new Set(existing?.deny ?? []);
      if (state === 'allow') {
        allow.add(permission);
        deny.delete(permission);
      } else if (state === 'deny') {
        deny.add(permission);
        allow.delete(permission);
      } else {
        allow.delete(permission);
        deny.delete(permission);
      }
      if (!allow.size && !deny.size) {
        if (existing) {
          await deleteUserPermissions(channel.id, userId);
        }
      } else {
        await updateUserPermissions(channel.id, userId, {
          allow: Array.from(allow),
          deny: Array.from(deny),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.permissionsUpdateFailed'));
    } finally {
      setPendingKey(null);
    }
  };

  const handleRemoveUser = async (userId: number) => {
    if (!channel) {
      return;
    }
    setPendingKey(`remove:${userId}`);
    setError(null);
    try {
      await deleteUserPermissions(channel.id, userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.permissionsUpdateFailed'));
    } finally {
      setPendingKey(null);
    }
  };

  const handleAddMember = async () => {
    if (!channel || selectedMemberId === '') {
      return;
    }
    setPendingKey(`add:${selectedMemberId}`);
    setError(null);
    try {
      await updateUserPermissions(channel.id, selectedMemberId, { allow: [], deny: [] });
      setSelectedMemberId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.permissionsUpdateFailed'));
    } finally {
      setPendingKey(null);
    }
  };

  const renderPermissionControls = (
    entryKey: string,
    allow: ChannelPermission[],
    deny: ChannelPermission[],
    onChange: (permission: ChannelPermission, state: PermissionState) => void,
  ) => {
    const allowSet = new Set(allow);
    const denySet = new Set(deny);
    return (
      <div className="permission-controls">
        {PERMISSION_OPTIONS.map((option) => {
          const state: PermissionState = allowSet.has(option.id)
            ? 'allow'
            : denySet.has(option.id)
            ? 'deny'
            : 'inherit';
          const key = `${entryKey}:${option.id}`;
          return (
            <div key={key} className="permission-control">
              <span className="permission-control__label">{t(option.labelKey)}</span>
              <div className="permission-control__actions">
                <button
                  type="button"
                  className={clsx('ghost', 'permission-button', 'permission-button--allow', {
                    'is-active': state === 'allow',
                  })}
                  onClick={() => onChange(option.id, 'allow')}
                  disabled={pendingKey === key}
                >
                  {t('channels.permissionStates.allow')}
                </button>
                <button
                  type="button"
                  className={clsx('ghost', 'permission-button', 'permission-button--deny', {
                    'is-active': state === 'deny',
                  })}
                  onClick={() => onChange(option.id, 'deny')}
                  disabled={pendingKey === key}
                >
                  {t('channels.permissionStates.deny')}
                </button>
                <button
                  type="button"
                  className={clsx('ghost', 'permission-button', {
                    'is-active': state === 'inherit',
                  })}
                  onClick={() => onChange(option.id, 'inherit')}
                  disabled={pendingKey === key}
                >
                  {t('channels.permissionStates.inherit')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div
        className="server-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-settings-title"
      >
        <header className="modal-header">
          <div>
            <h2 id="channel-settings-title">
              {t('channels.permissionsTitle', { name: channel.name, defaultValue: 'Channel permissions' })}
            </h2>
            <p className="modal-description">
              {t('channels.permissionsSubtitle', {
                defaultValue: 'Allow or block actions for specific roles and members.',
              })}
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        {error ? (
          <p className="auth-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-body permission-modal">
          <section className="permission-section">
            <h3>{t('channels.permissionRoles')}</h3>
            {roleHierarchy.length === 0 ? (
              <p className="permission-empty">{t('channels.permissionEmpty')}</p>
            ) : null}
            {roleHierarchy.map((entry) => {
              const overwrite = findRoleOverwrite(summary, entry.role);
              return (
                <div key={entry.role} className="permission-entry">
                  <div className="permission-entry__header">
                    <span className="permission-entry__title">{t(`roles.${entry.role}`)}</span>
                  </div>
                  {renderPermissionControls(
                    `role:${entry.role}`,
                    overwrite?.allow ?? [],
                    overwrite?.deny ?? [],
                    (permission, state) => void applyRoleChange(entry.role, permission, state),
                  )}
                </div>
              );
            })}
          </section>
          <section className="permission-section">
            <div className="permission-section__header">
              <h3>{t('channels.permissionMembers')}</h3>
              <div className="permission-add">
                <select
                  value={selectedMemberId}
                  onChange={(event) => setSelectedMemberId(event.target.value ? Number(event.target.value) : '')}
                  disabled={pendingKey?.startsWith('add:') || loading}
                >
                  <option value="">{t('channels.permissionSelectMember')}</option>
                  {availableMembers.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.display_name ?? member.login}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ghost"
                  onClick={handleAddMember}
                  disabled={selectedMemberId === '' || pendingKey?.startsWith('add:')}
                >
                  {t('channels.permissionAddMember')}
                </button>
              </div>
            </div>
            {loading && !summary ? (
              <p className="permission-empty">{t('channels.permissionsLoading')}</p>
            ) : null}
            {summary && summary.users.length === 0 && !loading ? (
              <p className="permission-empty">{t('channels.permissionEmpty')}</p>
            ) : null}
            {(summary?.users ?? []).map((entry) => (
              <div key={entry.user_id} className="permission-entry">
                <div className="permission-entry__header">
                  <div>
                    <span className="permission-entry__title">{entry.display_name ?? entry.login}</span>
                    <span className="permission-entry__subtitle">@{entry.login}</span>
                  </div>
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={() => void handleRemoveUser(entry.user_id)}
                    disabled={pendingKey === `remove:${entry.user_id}`}
                  >
                    {t('channels.permissionRemoveMember')}
                  </button>
                </div>
                {renderPermissionControls(
                  `user:${entry.user_id}`,
                  entry.allow,
                  entry.deny,
                  (permission, state) => void applyUserChange(entry.user_id, permission, state),
                )}
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
