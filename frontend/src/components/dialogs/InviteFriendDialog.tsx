import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import { fetchFriendsList, createDirectConversation, sendDirectMessage } from '../../services/api';
import type { RoomRole, FriendUser } from '../../types';
import { UserPlusIcon, CopyIcon, CheckIcon, UsersIcon, LinkIcon, XIcon } from '../icons/LucideIcons';
import { PresenceIndicator } from '../PresenceList';

interface InviteFriendDialogProps {
  open: boolean;
  roomSlug: string | null;
  roomTitle?: string;
  onClose: () => void;
}

type InviteMode = 'link' | 'friends';

export function InviteFriendDialog({ open, roomSlug, roomTitle, onClose }: InviteFriendDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const createInvitation = useWorkspaceStore((state) => state.createInvitation);
  const [mode, setMode] = useState<InviteMode>('link');
  const [role, setRole] = useState<RoomRole>('member');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [friends, setFriends] = useState<FriendUser[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [selectedFriendIds, setSelectedFriendIds] = useState<number[]>([]);
  const [sendingMessages, setSendingMessages] = useState(false);

  useEffect(() => {
    if (!open) {
      setMode('link');
      setRole('member');
      setError(null);
      setInviteCode(null);
      setInviteLink(null);
      setCopied(false);
      setSelectedFriendIds([]);
      setFriends([]);
    }
  }, [open]);

  useEffect(() => {
    if (open && mode === 'friends') {
      loadFriends();
    }
  }, [open, mode]);

  const loadFriends = async () => {
    setLoadingFriends(true);
    setError(null);
    try {
      const friendsList = await fetchFriendsList();
      setFriends(friendsList);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invites.loadFriendsError', { defaultValue: 'Не удалось загрузить список друзей' }));
    } finally {
      setLoadingFriends(false);
    }
  };

  const generateInviteLink = async () => {
    if (!roomSlug) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const invitation = await createInvitation(roomSlug, {
        role,
        expires_at: null,
      });
      const link = typeof window !== 'undefined' ? `${window.location.origin}/#/invite/${invitation.code}` : invitation.code;
      setInviteCode(invitation.code);
      setInviteLink(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invites.createError', { defaultValue: 'Не удалось создать приглашение' }));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!inviteLink || typeof navigator === 'undefined' || !navigator.clipboard) {
      setError(t('invites.copyFailed', { defaultValue: 'Не удалось скопировать ссылку' }));
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invites.copyFailed', { defaultValue: 'Не удалось скопировать ссылку' }));
    }
  };

  const toggleFriendSelection = (friendId: number) => {
    setSelectedFriendIds((current) =>
      current.includes(friendId) ? current.filter((id) => id !== friendId) : [...current, friendId],
    );
  };

  const sendInvitesToFriends = async () => {
    if (!roomSlug || selectedFriendIds.length === 0) {
      return;
    }

    setSendingMessages(true);
    setError(null);

    try {
      // Сначала создаем приглашение
      const invitation = await createInvitation(roomSlug, {
        role,
        expires_at: null,
      });
      const link = typeof window !== 'undefined' ? `${window.location.origin}/#/invite/${invitation.code}` : invitation.code;
      const roomName = roomTitle || roomSlug;
      const message = t('invites.friendMessage', {
        defaultValue: 'Привет! Присоединяйся к комнате "{{roomName}}": {{link}}',
        roomName,
        link,
      });

      // Отправляем сообщения каждому выбранному другу
      const sendPromises = selectedFriendIds.map(async (friendId) => {
        try {
          // Создаем или находим беседу с другом
          let conversation = await createDirectConversation({ participant_ids: [friendId] });
          
          // Отправляем сообщение с приглашением
          await sendDirectMessage(conversation.id, message);
        } catch (err) {
          console.error(`Failed to send invite to friend ${friendId}:`, err);
          throw err;
        }
      });

      await Promise.all(sendPromises);
      
      // Закрываем диалог после успешной отправки
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invites.sendError', { defaultValue: 'Не удалось отправить приглашения' }));
    } finally {
      setSendingMessages(false);
    }
  };

  const statusLabel = (status: string, t: (key: string, options?: any) => string): string => {
    switch (status) {
      case 'online':
        return t('presence.online', { defaultValue: 'В сети' });
      case 'idle':
        return t('presence.idle', { defaultValue: 'Неактивен' });
      case 'dnd':
        return t('presence.dnd', { defaultValue: 'Не беспокоить' });
      case 'offline':
        return t('presence.offline', { defaultValue: 'Не в сети' });
      default:
        return status;
    }
  };

  if (!open || !roomSlug || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="invite-friend-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2 id="invite-friend-title">{t('invites.friendTitle', { defaultValue: 'Пригласить друга' })}</h2>
            <p className="modal-description">
              {t('invites.friendSubtitle', { defaultValue: 'Пригласите друга в комнату, отправив ссылку или сообщение' })}
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            <XIcon size={20} strokeWidth={2} />
          </button>
        </header>

        <div className="invite-friend-content">
          {/* Выбор режима */}
          <div className="invite-friend-modes">
            <button
              type="button"
              className={mode === 'link' ? 'primary' : 'ghost'}
              onClick={() => setMode('link')}
            >
              <LinkIcon size={18} strokeWidth={1.8} />
              {t('invites.generateLink', { defaultValue: 'Сгенерировать ссылку' })}
            </button>
            <button
              type="button"
              className={mode === 'friends' ? 'primary' : 'ghost'}
              onClick={() => setMode('friends')}
            >
              <UsersIcon size={18} strokeWidth={1.8} />
              {t('invites.selectFriends', { defaultValue: 'Выбрать из списка друзей' })}
            </button>
          </div>

          {error && <p className="auth-form__error" role="alert">{error}</p>}

          {/* Режим генерации ссылки */}
          {mode === 'link' && (
            <div className="invite-friend-link-mode">
              <label className="field">
                {t('invites.roleLabel', { defaultValue: 'Роль' })}
                <select value={role} onChange={(event) => setRole(event.target.value as RoomRole)}>
                  <option value="member">{t('roles.member', { defaultValue: 'Участник' })}</option>
                  <option value="admin">{t('roles.admin', { defaultValue: 'Администратор' })}</option>
                  <option value="owner">{t('roles.owner', { defaultValue: 'Владелец' })}</option>
                  <option value="guest">{t('roles.guest', { defaultValue: 'Гость' })}</option>
                </select>
              </label>

              {!inviteLink ? (
                <button type="button" className="primary" onClick={generateInviteLink} disabled={loading}>
                  {loading ? t('common.loading', { defaultValue: 'Загрузка...' }) : t('invites.generateButton', { defaultValue: 'Сгенерировать ссылку' })}
                </button>
              ) : (
                <div className="invite-link-result">
                  <div className="invite-link-display">
                    <input type="text" value={inviteLink} readOnly className="invite-link-input" />
                    <button
                      type="button"
                      className={copied ? 'primary' : 'ghost'}
                      onClick={handleCopyLink}
                      title={t('invites.copyLink', { defaultValue: 'Скопировать ссылку' })}
                    >
                      {copied ? (
                        <>
                          <CheckIcon size={18} strokeWidth={1.8} />
                          {t('invites.copied', { defaultValue: 'Скопировано' })}
                        </>
                      ) : (
                        <>
                          <CopyIcon size={18} strokeWidth={1.8} />
                          {t('invites.copyLink', { defaultValue: 'Скопировать' })}
                        </>
                      )}
                    </button>
                  </div>
                  <p className="invite-link-hint">
                    {t('invites.linkHint', { defaultValue: 'Отправьте эту ссылку другу, чтобы он мог присоединиться к комнате' })}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Режим выбора друзей */}
          {mode === 'friends' && (
            <div className="invite-friend-friends-mode">
              <label className="field">
                {t('invites.roleLabel', { defaultValue: 'Роль' })}
                <select value={role} onChange={(event) => setRole(event.target.value as RoomRole)}>
                  <option value="member">{t('roles.member', { defaultValue: 'Участник' })}</option>
                  <option value="admin">{t('roles.admin', { defaultValue: 'Администратор' })}</option>
                  <option value="owner">{t('roles.owner', { defaultValue: 'Владелец' })}</option>
                  <option value="guest">{t('roles.guest', { defaultValue: 'Гость' })}</option>
                </select>
              </label>

              {loadingFriends ? (
                <p className="sidebar-empty">{t('common.loading', { defaultValue: 'Загрузка...' })}</p>
              ) : friends.length === 0 ? (
                <p className="sidebar-empty">{t('invites.noFriends', { defaultValue: 'У вас пока нет друзей' })}</p>
              ) : (
                <>
                  <div className="friends-list">
                    {friends.map((friend) => {
                      const isSelected = selectedFriendIds.includes(friend.id);
                      return (
                        <button
                          key={friend.id}
                          type="button"
                          className={`friend-item ${isSelected ? 'friend-item--selected' : ''}`}
                          onClick={() => toggleFriendSelection(friend.id)}
                        >
                          <PresenceIndicator status={friend.status} label={statusLabel(friend.status, t)} />
                          <span className="friend-item__name">{friend.display_name || friend.login}</span>
                          {isSelected && <CheckIcon size={16} strokeWidth={2} />}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="primary"
                    onClick={sendInvitesToFriends}
                    disabled={selectedFriendIds.length === 0 || sendingMessages}
                  >
                    {sendingMessages
                      ? t('invites.sending', { defaultValue: 'Отправка...' })
                      : t('invites.sendToFriends', {
                          defaultValue: 'Отправить приглашение ({{count}})',
                          count: selectedFriendIds.length,
                        })}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

