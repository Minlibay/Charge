import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChannelSidebar } from './components/ChannelSidebar';
import { ChatView } from './components/ChatView';
import { InviteJoinDialog } from './components/InviteJoinDialog';
import { PresenceList } from './components/PresenceList';
import { ServerSidebar } from './components/ServerSidebar';
import { VoicePanel } from './components/VoicePanel';
import { VoiceParticipantsPanel } from './components/voice/VoiceParticipantsPanel';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { CommandPalette } from './components/CommandPalette';
import { AppShell } from './components/layout/AppShell';
import { ResizableSidebar } from './components/layout/ResizableSidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthOverlay } from './components/workspace/AuthOverlay';
import { OfflineIndicator } from './components/OfflineIndicator';
import { useChannelSocket } from './hooks/useChannelSocket';
import { usePresenceSocket } from './hooks/usePresenceSocket';
import { useDirectSocket } from './hooks/useDirectSocket';
import { useWorkspaceSocket } from './hooks/useWorkspaceSocket';
import { useToken } from './hooks/useToken';
import { useWorkspaceStore } from './state/workspaceStore';
import { useWorkspaceHandlers } from './hooks/useWorkspaceHandlers';
import { useWorkspaceInitialization } from './hooks/useWorkspaceInitialization';
import { useMessageAcknowledgement } from './hooks/useMessageAcknowledgement';
import { getCurrentUserId, logout } from './services/session';
import { ThemeProvider, useTheme } from './theme';
import { ToastProvider, useToast } from './components/ui';
import { TEXT_CHANNEL_TYPES, VOICE_CHANNEL_TYPES, type Channel } from './types';
import { LoginModal, RegisterModal } from './pages/Auth';
import { DirectMessagesPage } from './pages/DirectMessages';
import { ProfilePage } from './pages/Profile';
import { Router, useNavigate, usePathname, useRouteMatch } from './router';

function WorkspaceApp(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [token] = useToken();
  const { theme, toggleTheme, animationsEnabled } = useTheme();
  const initialize = useWorkspaceStore((state) => state.initialize);
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

  const lastErrorRef = useRef<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const { pushToast } = useToast();

  useWorkspaceInitialization(token);

  // Handle invite link from URL
  const inviteMatch = useRouteMatch(/^\/invite\/(.+)$/);
  useEffect(() => {
    if (inviteMatch && inviteMatch[1]) {
      const code = inviteMatch[1];
      setInviteCode(code);
      setInviteOpen(true);
    } else {
      setInviteCode(null);
    }
  }, [inviteMatch]);

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

  const {
    handleSendMessage,
    handleEditMessage,
    handleDeleteMessage,
    handleModerateMessage,
    handleAddReaction,
    handleRemoveReaction,
  } = useWorkspaceHandlers();

  useMessageAcknowledgement(selectedChannelId, currentChannelType, messages);

  const handleTyping = (isTyping: boolean) => {
    if (selectedTextChannelId) {
      sendTyping(isTyping);
    }
  };

  const handleOpenLogin = () => navigate('/auth/login');
  const handleOpenRegister = () => navigate('/auth/register');
  const handleOpenInvite = () => setInviteOpen(true);

  const handleLogout = () => {
    logout();
    setInviteOpen(false);
    setCommandOpen(false);
    navigate('/auth/login', { replace: true });
  };

  const handleInviteJoined = () => {
    pushToast({
      type: 'success',
      title: t('invites.joinSuccessTitle', { defaultValue: 'Успешное присоединение' }),
      description: t('invites.joinSuccessDescription', {
        defaultValue: 'Новые каналы появятся в списке серверов.',
      }),
    });
    setInviteCode(null);
    setInviteOpen(false);
    navigate('/', { replace: true });
    initialize().catch((err) => {
      const message = err instanceof Error ? err.message : t('errors.loadRooms');
      setError(message);
    });
  };

  const handleInviteClose = () => {
    setInviteCode(null);
    setInviteOpen(false);
    navigate('/', { replace: true });
  };

  return (
    <>
      <OfflineIndicator />
      <AppShell
        header={
          <WorkspaceHeader
            onLogout={handleLogout}
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
            <PresenceList users={presence} members={members} />
          </ResizableSidebar>
        }
        mainProps={{ id: 'main' }}
      >
        {!token && (
          <AuthOverlay
            onOpenLogin={handleOpenLogin}
            onOpenRegister={handleOpenRegister}
          />
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
      <InviteJoinDialog
        open={inviteOpen}
        inviteCode={inviteCode}
        onClose={handleInviteClose}
        onJoined={handleInviteJoined}
      />
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
      !pathname.startsWith('/dm') &&
      !pathname.startsWith('/invite/')
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
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <Router>
            <Suspense fallback={<div className="app-loading">Loading…</div>}>
              <AppRoutes />
            </Suspense>
          </Router>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
