import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import { updateChannel, archiveChannel, unarchiveChannel } from '../../services/api';
import {
  CHANNEL_PERMISSIONS,
  type Channel,
  type ChannelPermission,
  type ChannelPermissionSummary,
  type ChannelRolePermissionOverwrite,
  type ChannelUserPermissionOverwrite,
  type RoomMemberSummary,
  type RoomRoleLevel,
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

const PERMISSION_OPTIONS: PermissionOption[] = CHANNEL_PERMISSIONS.map((permission) => ({
  id: permission,
  labelKey: `channels.permissionNames.${permission}`,
}));

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
  const [activeTab, setActiveTab] = useState<'overview' | 'settings' | 'permissions'>('overview');
  
  // Overview tab state
  const [topic, setTopic] = useState('');
  const [savingTopic, setSavingTopic] = useState(false);
  
  // Settings tab state
  const [slowmodeSeconds, setSlowmodeSeconds] = useState(0);
  const [isNsfw, setIsNsfw] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const summary = channel ? permissionsByChannel[channel.id] : undefined;

  useEffect(() => {
    if (!open || !channel) {
      return;
    }
    // Initialize form fields from channel
    setTopic(channel.topic ?? '');
    setSlowmodeSeconds(channel.slowmode_seconds);
    setIsNsfw(channel.is_nsfw);
    setIsPrivate(channel.is_private);
    
    // Load permissions if on permissions tab
    if (activeTab === 'permissions') {
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
    }
  }, [open, channel, activeTab, loadPermissions, t]);

  const handleSaveTopic = async () => {
    if (!channel) return;
    setSavingTopic(true);
    setError(null);
    try {
      const updated = await updateChannel(channel.id, { topic: topic || null });
      // Update channel in store
      const updateChannelInStore = useWorkspaceStore.getState().updateChannel;
      const roomSlug = useWorkspaceStore.getState().channelRoomById[channel.id];
      if (roomSlug) {
        updateChannelInStore(roomSlug, updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.updateFailed', { defaultValue: 'Failed to update channel' }));
    } finally {
      setSavingTopic(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!channel) return;
    setSavingSettings(true);
    setError(null);
    try {
      const updated = await updateChannel(channel.id, {
        slowmode_seconds: slowmodeSeconds,
        is_nsfw: isNsfw,
        is_private: isPrivate,
      });
      // Update channel in store
      const updateChannelInStore = useWorkspaceStore.getState().updateChannel;
      const roomSlug = useWorkspaceStore.getState().channelRoomById[channel.id];
      if (roomSlug) {
        updateChannelInStore(roomSlug, updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.updateFailed', { defaultValue: 'Failed to update channel' }));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleArchive = async () => {
    if (!channel) return;
    if (!confirm(t('channels.archiveConfirm', { defaultValue: 'Are you sure you want to archive this channel?' }))) {
      return;
    }
    setArchiving(true);
    setError(null);
    try {
      const updated = await archiveChannel(channel.id);
      // Update channel in store
      const updateChannelInStore = useWorkspaceStore.getState().updateChannel;
      const roomSlug = useWorkspaceStore.getState().channelRoomById[channel.id];
      if (roomSlug) {
        updateChannelInStore(roomSlug, updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.archiveFailed', { defaultValue: 'Failed to archive channel' }));
    } finally {
      setArchiving(false);
    }
  };

  const handleUnarchive = async () => {
    if (!channel) return;
    setArchiving(true);
    setError(null);
    try {
      const updated = await unarchiveChannel(channel.id);
      // Update channel in store
      const updateChannelInStore = useWorkspaceStore.getState().updateChannel;
      const roomSlug = useWorkspaceStore.getState().channelRoomById[channel.id];
      if (roomSlug) {
        updateChannelInStore(roomSlug, updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.unarchiveFailed', { defaultValue: 'Failed to unarchive channel' }));
    } finally {
      setArchiving(false);
    }
  };

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
              {t('channels.settingsTitle', { name: channel.name, defaultValue: `Settings: ${channel.name}` })}
            </h2>
            <p className="modal-description">
              {t('channels.settingsSubtitle', {
                defaultValue: 'Manage channel settings and permissions.',
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
        <div className="modal-body">
          {/* Tabs */}
          <div className="channel-settings-tabs">
            <button
              type="button"
              className={clsx('channel-settings-tab', { 'is-active': activeTab === 'overview' })}
              onClick={() => setActiveTab('overview')}
            >
              {t('channels.overview', { defaultValue: 'Overview' })}
            </button>
            <button
              type="button"
              className={clsx('channel-settings-tab', { 'is-active': activeTab === 'settings' })}
              onClick={() => setActiveTab('settings')}
            >
              {t('channels.settings', { defaultValue: 'Settings' })}
            </button>
            <button
              type="button"
              className={clsx('channel-settings-tab', { 'is-active': activeTab === 'permissions' })}
              onClick={() => {
                setActiveTab('permissions');
                if (channel && !permissionsByChannel[channel.id]) {
                  loadPermissions(channel.id);
                }
              }}
            >
              {t('channels.permissions', { defaultValue: 'Permissions' })}
            </button>
          </div>

          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="channel-settings-content">
              <div className="field">
                <label htmlFor="channel-topic">
                  {t('channels.topic', { defaultValue: 'Channel Topic' })}
                </label>
                <textarea
                  id="channel-topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  maxLength={1024}
                  rows={3}
                  placeholder={t('channels.topicPlaceholder', { defaultValue: 'Add a topic to describe this channel...' })}
                />
                <div className="field-hint">
                  {topic.length}/1024 {t('channels.characters', { defaultValue: 'characters' })}
                </div>
                <button
                  type="button"
                  className="primary"
                  onClick={handleSaveTopic}
                  disabled={savingTopic || topic === (channel.topic ?? '')}
                >
                  {savingTopic ? t('common.loading') : t('common.save')}
                </button>
              </div>
            </div>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && (
            <div className="channel-settings-content">
              <div className="field">
                <label htmlFor="channel-slowmode">
                  {t('channels.slowmode', { defaultValue: 'Slowmode (seconds)' })}
                </label>
                <input
                  id="channel-slowmode"
                  type="number"
                  min="0"
                  max="21600"
                  value={slowmodeSeconds}
                  onChange={(e) => setSlowmodeSeconds(Math.max(0, Math.min(21600, parseInt(e.target.value) || 0)))}
                />
                <div className="field-hint">
                  {t('channels.slowmodeHint', { defaultValue: 'Users must wait this many seconds between messages (0-21600)' })}
                </div>
              </div>

              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={isNsfw}
                    onChange={(e) => setIsNsfw(e.target.checked)}
                  />
                  <span>{t('channels.nsfw', { defaultValue: 'NSFW Channel' })}</span>
                </label>
                <div className="field-hint">
                  {t('channels.nsfwHint', { defaultValue: 'Mark this channel as containing adult content' })}
                </div>
              </div>

              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                  />
                  <span>{t('channels.private', { defaultValue: 'Private Channel' })}</span>
                </label>
                <div className="field-hint">
                  {t('channels.privateHint', { defaultValue: 'Only users with explicit permission can view this channel' })}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button
                  type="button"
                  className="primary"
                  onClick={handleSaveSettings}
                  disabled={savingSettings || (
                    slowmodeSeconds === channel.slowmode_seconds &&
                    isNsfw === channel.is_nsfw &&
                    isPrivate === channel.is_private
                  )}
                >
                  {savingSettings ? t('common.loading') : t('common.save')}
                </button>
              </div>

              <div style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border)' }}>
                <h3 style={{ marginBottom: '0.5rem' }}>
                  {t('channels.archive', { defaultValue: 'Archive Channel' })}
                </h3>
                <p style={{ marginBottom: '1rem', color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
                  {t('channels.archiveDescription', {
                    defaultValue: channel.is_archived
                      ? 'This channel is archived. Unarchive it to allow new messages.'
                      : 'Archive this channel to prevent new messages from being sent.',
                  })}
                </p>
                {channel.is_archived ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={handleUnarchive}
                    disabled={archiving}
                  >
                    {archiving ? t('common.loading') : t('channels.unarchive', { defaultValue: 'Unarchive Channel' })}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="danger"
                    onClick={handleArchive}
                    disabled={archiving}
                  >
                    {archiving ? t('common.loading') : t('channels.archiveButton', { defaultValue: 'Archive Channel' })}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Permissions Tab */}
          {activeTab === 'permissions' && (
            <div className="permission-modal">
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
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
