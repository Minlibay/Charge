import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChannelSidebar } from './components/ChannelSidebar';
import { ChatView } from './components/ChatView';
import { PresenceList } from './components/PresenceList';
import { ServerSidebar } from './components/ServerSidebar';
import { SettingsDialog } from './components/SettingsDialog';
import { VoicePanel } from './components/VoicePanel';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { useApiBase } from './hooks/useApiBase';
import { useChannelSocket } from './hooks/useChannelSocket';
import { useToken } from './hooks/useToken';
import { useWorkspaceStore } from './state/workspaceStore';
import { ThemeProvider, useTheme } from './theme';
import type { Channel } from './types';

function WorkspaceApp(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [apiBase, setApiBase] = useApiBase();
  const [token, setToken] = useToken();
  const { theme, toggleTheme, setTheme } = useTheme();
  const initialize = useWorkspaceStore((state) => state.initialize);
  const resetStore = useWorkspaceStore((state) => state.reset);
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
  const selectRoom = useWorkspaceStore((state) => state.selectRoom);
  const selectChannel = useWorkspaceStore((state) => state.selectChannel);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const setError = useWorkspaceStore((state) => state.setError);
  const voiceParticipants = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.voiceParticipantsByRoom[state.selectedRoomSlug] ?? [] : [],
  );

  const previousTokenRef = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(!token);
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
    }
  }, [initialize, resetStore, setError, t, token]);

  useEffect(() => {
    if (!token) {
      setSettingsOpen(true);
    }
  }, [token]);

  const { status, sendMessage, sendTyping } = useChannelSocket(selectedChannelId ?? null);

  const currentChannel: Channel | undefined = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId),
    [channels, selectedChannelId],
  );

  const voiceChannels = useMemo(() => channels.filter((channel) => channel.type === 'voice'), [channels]);

  const handleSendMessage = (content: string) => {
    setError(undefined);
    sendMessage(content);
  };

  const handleTyping = (isTyping: boolean) => {
    if (selectedChannelId) {
      sendTyping(isTyping);
    }
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
        />
        <main className="app-main">
          {!token && (
            <div className="auth-overlay" role="alert">
              <p>{t('app.signInRequired')}</p>
              <button type="button" className="primary" onClick={() => setSettingsOpen(true)}>
                {t('app.openSettings')}
              </button>
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
          />
        </main>
        <aside className="app-aside">
          <VoicePanel channels={voiceChannels} participants={voiceParticipants} />
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
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <ThemeProvider>
      <Suspense fallback={<div className="app-loading">Loading…</div>}>
        <WorkspaceApp />
      </Suspense>
    </ThemeProvider>
  );
}
