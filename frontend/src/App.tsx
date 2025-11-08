import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChannelSidebar } from './components/ChannelSidebar';
import { ChatView, type MessageComposerPayload } from './components/ChatView';
import { InviteJoinDialog } from './components/InviteJoinDialog';
import { PresenceList } from './components/PresenceList';
import { ServerSidebar } from './components/ServerSidebar';
import { SettingsDialog } from './components/SettingsDialog';
import { VoicePanel } from './components/VoicePanel';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { CommandPalette } from './components/CommandPalette';
import { AppShell } from './components/layout/AppShell';
import { ResizableSidebar } from './components/layout/ResizableSidebar';
import { useChannelSocket } from './hooks/useChannelSocket';
import { usePresenceSocket } from './hooks/usePresenceSocket';
import { useDirectSocket } from './hooks/useDirectSocket';
import { useWorkspaceSocket } from './hooks/useWorkspaceSocket';
import { useToken } from './hooks/useToken';
import { useDirectStore } from './stores/directStore';
import { useWorkspaceStore } from './state/workspaceStore';
import {
  ApiError,
  addMessageReaction as apiAddMessageReaction,
  createMessage as apiCreateMessage,
  deleteMessage as apiDeleteMessage,
  moderateMessage as apiModerateMessage,
  removeMessageReaction as apiRemoveMessageReaction,
  updateMessage as apiUpdateMessage,
  updateMessageReceipt as apiUpdateMessageReceipt,
} from './services/api';
import { getCurrentUserId, initializeSession } from './services/session';
import { requestNotificationPermission } from './utils/notifications';
import { ThemeProvider, useTheme } from './theme';
import { ToastProvider, useToast } from './components/ui';
import { TEXT_CHANNEL_TYPES, VOICE_CHANNEL_TYPES, type Channel, type Message } from './types';
import { LoginModal, RegisterModal } from './pages/Auth';
import { DirectMessagesPage } from './pages/DirectMessages';
import { ProfilePage } from './pages/Profile';
import { Router, useNavigate, usePathname, useRouteMatch } from './router';

function WorkspaceApp(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [token, setToken] = useToken();
  const {
    theme,
    toggleTheme,
    setTheme,
    availableThemes,
    customBackground,
    setCustomBackground,
    animationsEnabled,
    setAnimationsEnabled,
  } = useTheme();
  const initialize = useWorkspaceStore((state) => state.initialize);
  const resetStore = useWorkspaceStore((state) => state.reset);
  const clearFriends = useDirectStore((state) => state.clear);
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
  const selectedTextChannelId = useWorkspaceStore((state) => {
    const id = state.selectedChannelId;
    if (!id) {
      return null;
    }
    const slug = state.channelRoomById[id];
    if (!slug) {
      return null;
    }
    const channel = state.channelsByRoom[slug]?.find((item) => item.id === id);
    if (!channel) {
      return null;
    }
    return TEXT_CHANNEL_TYPES.includes(channel.type) ? id : null;
  });
  const messages = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.messagesByChannel[state.selectedChannelId] ?? [] : [],
  );
  const presence = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.presenceByChannel[state.selectedChannelId] ?? [] : [],
  );
  const typing = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.typingByChannel[state.selectedChannelId] ?? [] : [],
  );
  const selfReactions = useWorkspaceStore((state) => state.selfReactionsByMessage);
  const historyMeta = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.historyMetaByChannel[state.selectedChannelId] : undefined,
  );
  const loadingOlder = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.loadingOlderByChannel[state.selectedChannelId] ?? false : false,
  );
  const loadingNewer = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.loadingNewerByChannel[state.selectedChannelId] ?? false : false,
  );
  const pinnedMessages = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.pinnedByChannel[state.selectedChannelId] ?? [] : [],
  );
  const pinnedLoading = useWorkspaceStore((state) =>
    state.selectedChannelId ? state.loadingPinsByChannel[state.selectedChannelId] ?? false : false,
  );
  const ingestMessage = useWorkspaceStore((state) => state.ingestMessage);
  const selectRoom = useWorkspaceStore((state) => state.selectRoom);
  const selectChannel = useWorkspaceStore((state) => state.selectChannel);
  const channelRoomById = useWorkspaceStore((state) => state.channelRoomById);
  const channelsByRoom = useWorkspaceStore((state) => state.channelsByRoom);
  const loadRoom = useWorkspaceStore((state) => state.loadRoom);
  const loadOlderHistory = useWorkspaceStore((state) => state.loadOlderHistory);
  const loadNewerHistory = useWorkspaceStore((state) => state.loadNewerHistory);
  const loadPinnedMessages = useWorkspaceStore((state) => state.loadPinnedMessages);
  const unpinMessage = useWorkspaceStore((state) => state.unpinMessage);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const setError = useWorkspaceStore((state) => state.setError);

  const previousTokenRef = useRef<string | null>(null);
  const ackPendingRef = useRef<Set<number>>(new Set());
  const lastErrorRef = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(!token);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const { pushToast } = useToast();

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

  useEffect(() => {
    if (error && error !== lastErrorRef.current) {
      lastErrorRef.current = error;
      pushToast({
        type: 'error',
        title: t('common.error', { defaultValue: 'Ошибка' }),
        description: error,
      });
    } else if (!error) {
      lastErrorRef.current = null;
    }
  }, [error, pushToast, t]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (isTextInput) {
          return;
        }
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === 'Escape' && commandOpen) {
        setCommandOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [commandOpen]);

  const { status, sendTyping } = useChannelSocket(selectedTextChannelId ?? null);
  usePresenceSocket(Boolean(token));
  useDirectSocket(Boolean(token));
  useWorkspaceSocket(selectedRoomSlug ?? null);
  const currentUserId = useMemo(() => getCurrentUserId(), [token]);

  const currentChannel: Channel | undefined = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId),
    [channels, selectedChannelId],
  );

  const currentChannelType = currentChannel?.type ?? null;
  const pathname = usePathname();
  const dmMatch = useRouteMatch(/^\/dm\/(\d+)$/);
  const isProfileOpen = pathname.startsWith('/profile');
  const isDirectMessagesOpen = pathname === '/dm' || pathname.startsWith('/dm/');
  const directMessagesConversationId = useMemo(() => {
    if (!dmMatch) {
      return null;
    }
    const id = Number(dmMatch[1]);
    return Number.isNaN(id) ? null : id;
  }, [dmMatch]);

  const hasMoreOlder = historyMeta?.hasMoreBackward ?? false;
  const hasMoreNewer = historyMeta?.hasMoreForward ?? false;

  const handleOpenProfile = () => {
    navigate('/profile');
  };

  const handleOpenDirectMessages = () => {
    navigate('/dm');
  };

  const handleSelectDirectConversation = useCallback(
    (conversationId: number | null) => {
      if (conversationId) {
        navigate(`/dm/${conversationId}`);
      } else {
        navigate('/dm');
      }
    },
    [navigate],
  );

  useEffect(() => {
    if (!isDirectMessagesOpen) {
      return;
    }
    if (pathname === '/dm' || directMessagesConversationId !== null) {
      return;
    }
    navigate('/dm', { replace: true });
  }, [directMessagesConversationId, isDirectMessagesOpen, navigate, pathname]);

  useEffect(() => {
    if (!selectedTextChannelId) {
      return;
    }
    const state = useWorkspaceStore.getState();
    if (!state.pinnedByChannel[selectedTextChannelId]) {
      void loadPinnedMessages(selectedTextChannelId);
    }
  }, [loadPinnedMessages, selectedTextChannelId]);

  const voiceChannels = useMemo(
    () => channels.filter((channel) => VOICE_CHANNEL_TYPES.includes(channel.type)),
    [channels],
  );
  const paletteChannels = useMemo(
    () =>
      Object.entries(channelsByRoom).flatMap(([slug, list]) =>
        list.map((channel) => ({ ...channel, roomSlug: slug })),
      ),
    [channelsByRoom],
  );

  const handleFocusUser = useCallback(
    (userId: number) => {
      const element = document.getElementById(`presence-user-${userId}`);
      if (element instanceof HTMLElement) {
        element.focus();
        element.scrollIntoView({
          block: 'nearest',
          behavior: animationsEnabled ? 'smooth' : 'auto',
        });
      }
    },
    [animationsEnabled],
  );

  const handleSelectRoomFromPalette = useCallback(
    async (slug: string) => {
      await loadRoom(slug);
    },
    [loadRoom],
  );

  const handleSelectChannelFromPalette = useCallback(
    async (channelId: number) => {
      const slug = channelRoomById[channelId];
      if (slug && slug !== selectedRoomSlug) {
        await loadRoom(slug);
      }
      selectChannel(channelId);
    },
    [channelRoomById, loadRoom, selectChannel, selectedRoomSlug],
  );

  const handleLoadOlderHistory = useCallback(() => {
    if (!selectedTextChannelId) {
      return;
    }
    void loadOlderHistory(selectedTextChannelId);
  }, [loadOlderHistory, selectedTextChannelId]);

  const handleLoadNewerHistory = useCallback(() => {
    if (!selectedTextChannelId) {
      return;
    }
    void loadNewerHistory(selectedTextChannelId);
  }, [loadNewerHistory, selectedTextChannelId]);

  const handleRefreshPins = useCallback(() => {
    if (!selectedTextChannelId) {
      return;
    }
    void loadPinnedMessages(selectedTextChannelId);
  }, [loadPinnedMessages, selectedTextChannelId]);

  const handleUnpinPinnedMessage = useCallback(
    async (messageId: number) => {
      if (!selectedTextChannelId) {
        return;
      }
      await unpinMessage(selectedTextChannelId, messageId);
    },
    [selectedTextChannelId, unpinMessage],
  );

  const handleSendMessage = async (draft: MessageComposerPayload) => {
    if (!selectedTextChannelId) {
      return;
    }
    setError(undefined);
    try {
      const created = await apiCreateMessage({
        channelId: selectedTextChannelId,
        content: draft.content,
        parentId: draft.parentId ?? null,
        files: draft.files,
      });
      ingestMessage(selectedTextChannelId, created);
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

  const handleAddReaction = async (target: Message, emoji: string) => {
    try {
      const updated = await apiAddMessageReaction(target.channel_id, target.id, emoji);
      ingestMessage(updated.channel_id, updated);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('chat.reactionError', { defaultValue: 'Не удалось обновить реакцию' });
      setError(message);
      throw err;
    }
  };

  const handleRemoveReaction = async (target: Message, emoji: string) => {
    try {
      const updated = await apiRemoveMessageReaction(target.channel_id, target.id, emoji);
      ingestMessage(updated.channel_id, updated);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('chat.reactionError', { defaultValue: 'Не удалось обновить реакцию' });
      setError(message);
      throw err;
    }
  };

  useEffect(() => {
    if (
      !selectedChannelId ||
      currentChannelType === null ||
      !TEXT_CHANNEL_TYPES.includes(currentChannelType)
    ) {
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
    if (selectedTextChannelId) {
      sendTyping(isTyping);
    }
  };

  const handleOpenLogin = () => navigate('/auth/login');
  const handleOpenRegister = () => navigate('/auth/register');
  const handleOpenInvite = () => setInviteOpen(true);

  const handleInviteJoined = () => {
    pushToast({
      type: 'success',
      title: t('invites.joinSuccessTitle', { defaultValue: 'Успешное присоединение' }),
      description: t('invites.joinSuccessDescription', {
        defaultValue: 'Новые каналы появятся в списке серверов.',
      }),
    });
    initialize().catch((err) => {
      const message = err instanceof Error ? err.message : t('errors.loadRooms');
      setError(message);
    });
  };

  return (
    <>
      <AppShell
        header={
          <WorkspaceHeader
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleTheme={toggleTheme}
            theme={theme}
            onOpenCommandPalette={() => setCommandOpen(true)}
            language={i18n.language}
            onChangeLanguage={(lng) => i18n.changeLanguage(lng)}
            loading={loading}
            error={error}
            tokenPresent={Boolean(token)}
            onOpenLogin={handleOpenLogin}
            onOpenRegister={handleOpenRegister}
            onOpenInvite={handleOpenInvite}
            onOpenProfile={handleOpenProfile}
            onOpenDirectMessages={handleOpenDirectMessages}
          />
        }
        primarySidebar={
          <ResizableSidebar
            storageKey="sidebar.servers"
            defaultWidth={220}
            minWidth={180}
            maxWidth={320}
            ariaLabel={t('servers.title')}
          >
            <ServerSidebar rooms={rooms} selectedRoomSlug={selectedRoomSlug} onSelect={selectRoom} />
          </ResizableSidebar>
        }
        secondarySidebar={
          <ResizableSidebar
            storageKey="sidebar.channels"
            defaultWidth={280}
            minWidth={220}
            maxWidth={420}
            ariaLabel={t('channels.title')}
          >
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
              members={members}
            />
          </ResizableSidebar>
        }
        aside={
          <ResizableSidebar
            storageKey="sidebar.utility"
            defaultWidth={260}
            minWidth={220}
            maxWidth={360}
            position="right"
            ariaLabel={t('presence.title')}
          >
            <VoicePanel channels={voiceChannels} />
            <PresenceList users={presence} />
          </ResizableSidebar>
        }
        mainProps={{ id: 'main' }}
      >
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
          onAddReaction={handleAddReaction}
          onRemoveReaction={handleRemoveReaction}
          selfReactions={selfReactions}
          hasMoreOlder={hasMoreOlder}
          hasMoreNewer={hasMoreNewer}
          loadingOlder={loadingOlder}
          loadingNewer={loadingNewer}
          onLoadOlder={handleLoadOlderHistory}
          onLoadNewer={handleLoadNewerHistory}
          pinnedMessages={pinnedMessages}
          pinnedLoading={pinnedLoading}
          onRefreshPins={handleRefreshPins}
          onUnpinPinnedMessage={handleUnpinPinnedMessage}
        />
      </AppShell>
      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        rooms={rooms}
        channels={paletteChannels}
        users={members}
        activeRoomSlug={selectedRoomSlug}
        onSelectRoom={handleSelectRoomFromPalette}
        onSelectChannel={handleSelectChannelFromPalette}
        onFocusUser={handleFocusUser}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        token={token}
        onTokenChange={setToken}
        theme={theme}
        themes={availableThemes}
        onThemeChange={setTheme}
        customBackground={customBackground}
        onCustomBackgroundChange={setCustomBackground}
        animationsEnabled={animationsEnabled}
        onAnimationsEnabledChange={setAnimationsEnabled}
        language={i18n.language}
        onLanguageChange={(lng) => {
          i18n.changeLanguage(lng);
        }}
      />
      <InviteJoinDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onJoined={handleInviteJoined} />
      <DirectMessagesPage
        open={isDirectMessagesOpen}
        selectedConversationId={directMessagesConversationId}
        onSelectConversation={handleSelectDirectConversation}
        onClose={() => navigate('/')}
      />
      <ProfilePage open={isProfileOpen} onClose={() => navigate('/')} />
    </>
  );
}

function AppRoutes(): JSX.Element {
  const pathname = usePathname();
  const navigate = useNavigate();

  useEffect(() => {
    if (
      pathname !== '/' &&
      !pathname.startsWith('/auth/') &&
      !pathname.startsWith('/profile') &&
      !pathname.startsWith('/dm')
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
      <ToastProvider>
        <Router>
          <Suspense fallback={<div className="app-loading">Loading…</div>}>
            <AppRoutes />
          </Suspense>
        </Router>
      </ToastProvider>
    </ThemeProvider>
  );
}
