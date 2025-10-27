import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChannelSidebar } from './components/ChannelSidebar';
import { ChatView, type MessageComposerPayload } from './components/ChatView';
import { InviteJoinDialog } from './components/InviteJoinDialog';
import { PresenceList } from './components/PresenceList';
import { ServerSidebar } from './components/ServerSidebar';
import { SettingsDialog } from './components/SettingsDialog';
import { VoicePanel } from './components/VoicePanel';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { useApiBase } from './hooks/useApiBase';
import { useChannelSocket } from './hooks/useChannelSocket';
import { usePresenceSocket } from './hooks/usePresenceSocket';
import { useToken } from './hooks/useToken';
import { useFriendsStore } from './state/friendsStore';
import { useWorkspaceStore } from './state/workspaceStore';
import {
  ApiError,
  createMessage as apiCreateMessage,
  deleteMessage as apiDeleteMessage,
  moderateMessage as apiModerateMessage,
  updateMessage as apiUpdateMessage,
  updateMessageReceipt as apiUpdateMessageReceipt,
} from './services/api';
import { getCurrentUserId, initializeSession } from './services/session';
import { requestNotificationPermission } from './utils/notifications';
import { ThemeProvider, useTheme } from './theme';
import type { Channel, Message } from './types';
import { LoginModal, RegisterModal } from './pages/Auth';
import { ProfilePage } from './pages/Profile';
import { Router, useNavigate, usePathname } from './router';

function WorkspaceApp(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [apiBase, setApiBase] = useApiBase();
  const [token, setToken] = useToken();
  const { theme, toggleTheme, setTheme } = useTheme();
  const initialize = useWorkspaceStore((state) => state.initialize);
  const resetStore = useWorkspaceStore((state) => state.reset);
  const clearFriends = useFriendsStore((state) => state.clear);
  const rooms = useWorkspaceStore((state) => state.rooms);
  const selectedRoomSlug = useWorkspaceStore((state) => state.selectedRoomSlug);
  const roomDetail = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.roomDetails[state.selectedRoomSlug] : undefined,
  );
  const channels = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.channelsByRoom[state.selectedRoomSlug] ?? [] : [],
  );
  const categories = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.categoriesByRoom[state.selectedRoomSlug] ?? [] : [],
  );
  const members = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.membersByRoom[state.selectedRoomSlug] ?? [] : [],
  );
  const selectedChannelId = useWorkspaceStore((state) => state.selectedChannelId);
  const messages = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.messagesByChannel[state.selectedChannelId] ?? [] : [],
  );
  const presence = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.presenceByChannel[state.selectedChannelId] ?? [] : [],
  );
  const typing = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.typingByChannel[state.selectedChannelId] ?? [] : [],
  );
  const ingestMessage = useWorkspaceStore((state) => state.ingestMessage);
  const selectRoom = useWorkspaceStore((state) => state.selectRoom);
  const selectChannel = useWorkspaceStore((state) => state.selectChannel);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const setError = useWorkspaceStore((state) => state.setError);

  const previousTokenRef = useRef<string | null>(null);
  const ackPendingRef = useRef<Set<number>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(!token);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    void initializeSession().catch((err) => {
      console.warn('Failed to initialize session', err);
    });
  }, []);

  useEffect(() => {
    if (token) {
      if (previousTokenRef.current !== token) {
        previousTokenRef.current = token;
        initialize().catch((err) => {
          const message = err instanceof Error ? err.message : t('errors.loadRooms');
          setError(message);
        });
      }
    } else {
      previousTokenRef.current = null;
      resetStore();
      clearFriends();
    }
  }, [clearFriends, initialize, resetStore, setError, t, token]);

  useEffect(() => {
    if (!token) {
      setSettingsOpen(true);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void requestNotificationPermission().catch((error) => {
      console.warn('Notification permission request failed', error);
    });
  }, [token]);

  const { status, sendTyping } = useChannelSocket(selectedChannelId ?? null);
  usePresenceSocket(Boolean(token));
  const currentUserId = useMemo(() => getCurrentUserId(), [token]);

  const currentChannel: Channel | undefined = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId),
    [channels, selectedChannelId],
  );

  const currentChannelType = currentChannel?.type ?? null;
  const pathname = usePathname();
  const isProfileOpen = pathname.startsWith('/profile');

  const handleOpenProfile = () => {
    navigate('/profile');
  };

  const voiceChannels = useMemo(() => channels.filter((channel) => channel.type === 'voice'), [channels]);

  const handleSendMessage = async (draft: MessageComposerPayload) => {
    if (!selectedChannelId) {
      return;
    }
    setError(undefined);
    try {
      const created = await apiCreateMessage({
        channelId: selectedChannelId,
        content: draft.content,
        parentId: draft.parentId ?? null,
        files: draft.files,
      });
      ingestMessage(selectedChannelId, created);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('chat.sendError', { defaultValue: 'Не удалось отправить сообщение' });
      setError(message);
      throw err;
    }
  };

  const handleEditMessage = async (target: Message, content: string) => {
    try {
      const updated = await apiUpdateMessage(target.id, content);
      ingestMessage(updated.channel_id, updated);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('chat.editError', { defaultValue: 'Не удалось обновить сообщение' });
      setError(message);
      throw err;
    }
  };

  const handleDeleteMessage = async (target: Message) => {
    try {
      const updated = await apiDeleteMessage(target.id);
      ingestMessage(updated.channel_id, updated);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('chat.deleteError', { defaultValue: 'Не удалось удалить сообщение' });
      setError(message);
      throw err;
    }
  };

  const handleModerateMessage = async (target: Message, action: 'suppress' | 'restore', note?: string) => {
    try {
      const updated = await apiModerateMessage(target.id, { action, note });
      ingestMessage(updated.channel_id, updated);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('chat.moderateError', { defaultValue: 'Не удалось модерировать сообщение' });
      setError(message);
      throw err;
    }
  };

  useEffect(() => {
    if (!selectedChannelId || currentChannelType !== 'text') {
      return;
    }
    if (messages.length === 0) {
      return;
    }
    const pending = ackPendingRef.current;
    const targets = messages.filter((message) => {
      if (message.read_at) {
        return false;
      }
      if (message.author_id !== null && message.author_id === currentUserId) {
        return false;
      }
      return !pending.has(message.id);
    });
    if (targets.length === 0) {
      return;
    }

    let cancelled = false;

    const acknowledge = async () => {
      for (const message of targets) {
        if (cancelled) {
          break;
        }
        pending.add(message.id);
        try {
          const updated = await apiUpdateMessageReceipt(selectedChannelId, message.id, {
            delivered: true,
            read: true,
          });
          if (!cancelled) {
            ingestMessage(selectedChannelId, updated);
          }
        } catch (error) {
          console.warn('Failed to acknowledge message', error);
        } finally {
          pending.delete(message.id);
        }
      }
    };

    void acknowledge();

    return () => {
      cancelled = true;
    };
  }, [currentChannelType, currentUserId, ingestMessage, messages, selectedChannelId]);

  const handleTyping = (isTyping: boolean) => {
    if (selectedChannelId) {
      sendTyping(isTyping);
    }
  };

  const handleOpenLogin = () => navigate('/auth/login');
  const handleOpenRegister = () => navigate('/auth/register');
  const handleOpenInvite = () => setInviteOpen(true);

  const handleInviteJoined = () => {
    initialize().catch((err) => {
      const message = err instanceof Error ? err.message : t('errors.loadRooms');
      setError(message);
    });
  };

  return (
    <div className="app-shell">
      <WorkspaceHeader
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
        theme={theme}
        language={i18n.language}
        onChangeLanguage={(lng) => i18n.changeLanguage(lng)}
        apiBase={apiBase}
        loading={loading}
        error={error}
        tokenPresent={Boolean(token)}
        onOpenLogin={handleOpenLogin}
        onOpenRegister={handleOpenRegister}
        onOpenInvite={handleOpenInvite}
        onOpenProfile={handleOpenProfile}
      />
      <div className="app-layout" id="main">
        <ServerSidebar rooms={rooms} selectedRoomSlug={selectedRoomSlug} onSelect={selectRoom} />
        <ChannelSidebar
          channels={channels}
          categories={categories}
          selectedChannelId={selectedChannelId}
          onSelectChannel={selectChannel}
          roomTitle={roomDetail?.title}
          currentRole={roomDetail?.current_role ?? null}
          roomSlug={selectedRoomSlug}
          invitations={roomDetail?.invitations ?? []}
          roleHierarchy={roomDetail?.role_hierarchy ?? []}
        />
        <main className="app-main">
          {!token && (
            <div className="auth-overlay" role="alert">
              <p>{t('app.signInRequired')}</p>
              <div className="auth-overlay__actions">
                <button type="button" className="primary" onClick={handleOpenLogin}>
                  {t('auth.loginAction')}
                </button>
                <button type="button" className="ghost" onClick={handleOpenRegister}>
                  {t('auth.registerAction')}
                </button>
                <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
                  {t('app.openSettings')}
                </button>
              </div>
            </div>
          )}
          <ChatView
            channel={currentChannel}
            messages={messages}
            typingUsers={typing}
            status={status}
            onSendMessage={handleSendMessage}
            onTyping={handleTyping}
            error={error}
            loading={loading}
            members={members}
            currentUserId={currentUserId}
            currentRole={roomDetail?.current_role ?? null}
            onEditMessage={handleEditMessage}
            onDeleteMessage={handleDeleteMessage}
            onModerateMessage={handleModerateMessage}
          />
        </main>
        <aside className="app-aside">
          <VoicePanel channels={voiceChannels} />
          <PresenceList users={presence} />
        </aside>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiBase={apiBase}
        onApiBaseChange={setApiBase}
        token={token}
        onTokenChange={setToken}
        theme={theme}
        onThemeChange={setTheme}
        language={i18n.language}
        onLanguageChange={(lng) => {
          i18n.changeLanguage(lng);
        }}
      />
      <InviteJoinDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onJoined={handleInviteJoined} />
      <ProfilePage open={isProfileOpen} onClose={() => navigate('/')} />
    </div>
  );
}

function AppRoutes(): JSX.Element {
  const pathname = usePathname();
  const navigate = useNavigate();

  useEffect(() => {
    if (
      pathname !== '/' &&
      !pathname.startsWith('/auth/') &&
      !pathname.startsWith('/profile')
    ) {
      navigate('/', { replace: true });
    }
  }, [navigate, pathname]);

  return (
    <>
      <WorkspaceApp />
      {pathname === '/auth/login' && <LoginModal />}
      {pathname === '/auth/register' && <RegisterModal />}
    </>
  );
}

export default function App(): JSX.Element {
  return (
    <ThemeProvider>
      <Router>
        <Suspense fallback={<div className="app-loading">Loading…</div>}>
          <AppRoutes />
        </Suspense>
      </Router>
    </ThemeProvider>
  );
}
