import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ChangeEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel } from '../types';
import { useVoiceConnection } from '../hooks/useVoiceConnection';
import { useWorkspaceStore } from '../state/workspaceStore';
import { applyOutputDevice, isSetSinkIdSupported } from '../webrtc/devices';
import { StagePanel } from './voice/StagePanel';

interface VoicePanelProps {
  channels: Channel[];
}

interface VoiceParticipantRowProps {
  participantId: number;
  name: string;
  role: string;
  isLocal: boolean;
  muted: boolean;
  deafened: boolean;
  videoEnabled: boolean;
  speaking: boolean;
  level: number;
  stream: MediaStream | null;
  speakerDeviceId: string | null;
  youLabel: string;
  globalVolume: number;
  volume: number;
  onVolumeChange: (participantId: number, volume: number) => void;
  volumeAriaLabel: string;
  volumeValueText: string;
  menuLabel: string;
}

interface PlaybackAudioChain {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  stream: MediaStream;
}

function SvgIcon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      className="voice-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const MicOnIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
    <path d="M19 11a7 7 0 0 1-14 0" />
    <path d="M12 18v3" />
  </SvgIcon>
);

const MicOffIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M15 12V7a3 3 0 0 0-4.75-2.55" />
    <path d="M9 10v2a3 3 0 0 0 3 3c.7 0 1.36-.24 1.88-.64" />
    <path d="M19 11a7 7 0 0 1-7 7" />
    <path d="M5 11a7 7 0 0 0 2.1 4.9" />
    <path d="M12 18v3" />
    <path d="M3 3l18 18" />
  </SvgIcon>
);

const HeadsetIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M5 12a7 7 0 0 1 14 0" />
    <path d="M7 12v-1a5 5 0 0 1 10 0v1" />
    <path d="M5 12v3a2 2 0 0 0 2 2h1" />
    <path d="M19 12v3a2 2 0 0 1-2 2h-1" />
    <path d="M12 18v3" />
  </SvgIcon>
);

const HeadsetOffIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M8.6 6.4A5 5 0 0 1 17 11v1" />
    <path d="M5 12v3a2 2 0 0 0 2 2h1" />
    <path d="M19 14.5V12a7 7 0 0 0-9.4-6.6" />
    <path d="M12 18v3" />
    <path d="M3 3l18 18" />
  </SvgIcon>
);

const VideoOnIcon = (): JSX.Element => (
  <SvgIcon>
    <rect x="4" y="7" width="10" height="10" rx="2" ry="2" />
    <path d="M18 9v6l-4-2.5V11.5Z" />
  </SvgIcon>
);

const VideoOffIcon = (): JSX.Element => (
  <SvgIcon>
    <rect x="4" y="7" width="10" height="10" rx="2" ry="2" />
    <path d="M18 9v6l-3.6-2.1" />
    <path d="M5 5l14 14" />
  </SvgIcon>
);

const RefreshIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M4 10a8 8 0 0 1 13-4.6" />
    <path d="M17 4h3v3" />
    <path d="M20 14a8 8 0 0 1-13 4.6" />
    <path d="M7 20H4v-3" />
  </SvgIcon>
);

const RetryIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M5 11a7 7 0 0 1 11.9-4.9" />
    <path d="M17 4v4H13" />
    <path d="M19 13a7 7 0 0 1-11.9 4.9" />
    <path d="M7 20v-4h4" />
  </SvgIcon>
);

const PhoneIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M6 4h3l1.2 4.5-2 2a11 11 0 0 0 7.3 7.3l2-2L22 17v3a2 2 0 0 1-2 2A17 17 0 0 1 4 7a2 2 0 0 1 2-2Z" />
  </SvgIcon>
);

const PhoneHangupIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M4 15c3-3 13-3 16 0" />
    <path d="M4 15v3" />
    <path d="M20 15v3" />
  </SvgIcon>
);

interface VoiceControlButtonProps {
  label: string;
  onClick: () => void;
  icon: JSX.Element;
  active?: boolean;
  disabled?: boolean;
  toggle?: boolean;
}

function VoiceControlButton({
  label,
  onClick,
  icon,
  active = false,
  disabled = false,
  toggle = false,
}: VoiceControlButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={clsx('voice-control-button', { 'voice-control-button--active': active })}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={toggle ? active : undefined}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}

function VoiceParticipantRow({
  participantId,
  name,
  role,
  isLocal,
  muted,
  deafened,
  videoEnabled,
  speaking,
  level,
  stream,
  speakerDeviceId,
  youLabel,
  globalVolume,
  volume,
  onVolumeChange,
  volumeAriaLabel,
  volumeValueText,
}: VoiceParticipantRowProps): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackChainRef = useRef<PlaybackAudioChain | null>(null);
  const safeVolume = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 2) : 1;
  const combinedVolume = Math.min(Math.max(globalVolume * safeVolume, 0), 4);
  const volumeRef = useRef<number>(combinedVolume);
  volumeRef.current = combinedVolume;
  const volumeInputId = useMemo(() => `voice-participant-volume-${participantId}`, [participantId]);

  const disposePlaybackChain = useCallback((chain: PlaybackAudioChain | null) => {
    if (!chain) {
      return;
    }
    try {
      chain.source.disconnect();
    } catch (error) {
      void error;
    }
    try {
      chain.gain.disconnect();
    } catch (error) {
      void error;
    }
    try {
      chain.destination.disconnect();
    } catch (error) {
      void error;
    }
    void chain.context.close().catch(() => {
      // ignore close errors
    });
  }, []);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) {
      return;
    }

    const previousChain = playbackChainRef.current;

    if (!stream) {
      if (previousChain) {
        disposePlaybackChain(previousChain);
        playbackChainRef.current = null;
      }
      if (element.srcObject) {
        element.srcObject = null;
      }
      return;
    }

    const AudioContextCtor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;

    if (!AudioContextCtor) {
      if (previousChain) {
        disposePlaybackChain(previousChain);
        playbackChainRef.current = null;
      }
      element.srcObject = stream;
      element.volume = Math.min(Math.max(volumeRef.current, 0), 1);
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {
          // autoplay may be blocked; ignore
        });
      }
      return () => {
        if (element.srcObject === stream) {
          element.srcObject = null;
        }
      };
    }

    if (previousChain && previousChain.stream === stream) {
      if (element.srcObject !== previousChain.destination.stream) {
        element.srcObject = previousChain.destination.stream;
      }
      previousChain.gain.gain.setTargetAtTime(volumeRef.current, previousChain.context.currentTime, 0.05);
      void previousChain.context.resume().catch(() => {
        // ignore resume errors
      });
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {
          // autoplay may be blocked; ignore
        });
      }
      return () => {
        const activeChain = playbackChainRef.current;
        if (activeChain && activeChain.stream === stream) {
          disposePlaybackChain(activeChain);
          playbackChainRef.current = null;
        }
      };
    }

    if (previousChain) {
      disposePlaybackChain(previousChain);
      playbackChainRef.current = null;
    }

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();

    source.connect(gain);
    gain.connect(destination);
    gain.gain.setValueAtTime(volumeRef.current, context.currentTime);

    playbackChainRef.current = { context, source, gain, destination, stream };

    element.srcObject = destination.stream;
    void context.resume().catch(() => {
      // ignore resume errors
    });
    const playPromise = element.play();
    if (playPromise !== undefined) {
      void playPromise.catch(() => {
        // autoplay may be blocked; ignore
      });
    }

    return () => {
      const activeChain = playbackChainRef.current;
      if (activeChain && activeChain.stream === stream) {
        disposePlaybackChain(activeChain);
        playbackChainRef.current = null;
      }
    };
  }, [disposePlaybackChain, stream]);

  useEffect(() => {
    const element = audioRef.current;
    const chain = playbackChainRef.current;
    const nextVolume = volumeRef.current;
    if (chain) {
      chain.gain.gain.setTargetAtTime(nextVolume, chain.context.currentTime, 0.05);
    } else if (element) {
      element.volume = Math.min(Math.max(nextVolume, 0), 1);
    }
  }, [combinedVolume]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) {
      return;
    }
    const shouldMute = deafened || isLocal;
    element.muted = shouldMute;
    if (!shouldMute) {
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {
          // autoplay may be blocked; ignore
        });
      }
      const chain = playbackChainRef.current;
      if (chain) {
        void chain.context.resume().catch(() => {
          // ignore resume errors
        });
      }
    }
  }, [deafened, isLocal]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || isLocal || !stream) {
      return;
    }
    if (!isSetSinkIdSupported()) {
      return;
    }
    void applyOutputDevice(element, speakerDeviceId ?? null);
  }, [isLocal, speakerDeviceId, stream]);

  const handleVolumeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onVolumeChange(participantId, Number(event.target.value));
    },
    [onVolumeChange, participantId],
  );

  const initials = useMemo(() => name.trim().charAt(0).toUpperCase() || '•', [name]);

  return (
    <li
      key={participantId}
      className={clsx('voice-participant', {
        'voice-participant--muted': muted,
        'voice-participant--deafened': deafened,
        'voice-participant--speaking': speaking,
        'voice-participant--local': isLocal,
      })}
    >
      <span className="presence-avatar" aria-hidden="true">
        {initials}
      </span>
      <div className="voice-participant__details">
        <span className="presence-name">
          {name}
          {isLocal ? ` (${youLabel})` : ''}
        </span>
        <span className="voice-participant__role">{role}</span>
      </div>
      <div className="voice-participant__status">
        <div className="voice-participant__indicators" role="group" aria-label="Media state">
          <span className={clsx('voice-indicator', 'voice-indicator--mic', { 'is-off': muted })} aria-hidden="true">
            {muted ? '🔇' : '🎙️'}
          </span>
          <span className={clsx('voice-indicator', 'voice-indicator--deaf', { 'is-off': !deafened })} aria-hidden="true">
            {deafened ? '🙉' : '👂'}
          </span>
          <span className={clsx('voice-indicator', 'voice-indicator--video', { 'is-off': !videoEnabled })} aria-hidden="true">
            {videoEnabled ? '🎥' : '📷'}
          </span>
          <span className="voice-activity" aria-hidden="true" style={{ '--voice-level': level } as CSSProperties} />
        </div>
        {!isLocal ? (
          <details className="voice-participant__menu">
            <summary
              className="voice-participant__menu-trigger"
              role="button"
              aria-haspopup="menu"
              aria-label={menuLabel}
            >
              ⋯
            </summary>
            <div className="voice-participant__menu-content" role="menu">
              <label className="sr-only" htmlFor={volumeInputId}>
                {volumeAriaLabel}
              </label>
              <div className="voice-participant__menu-row">
                <span className="voice-participant__menu-label">{volumeValueText}</span>
                <input
                  id={volumeInputId}
                  className="voice-participant__menu-slider"
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={safeVolume}
                  onChange={handleVolumeChange}
                  aria-valuemin={0}
                  aria-valuemax={2}
                  aria-valuenow={Number.isFinite(safeVolume) ? Number(safeVolume.toFixed(2)) : 1}
                  aria-valuetext={volumeValueText}
                  title={volumeValueText}
                />
              </div>
            </div>
          </details>
        ) : null}
      </div>
      {!isLocal ? <audio ref={audioRef} autoPlay playsInline /> : null}
    </li>
  );
}

export function VoicePanel({ channels }: VoicePanelProps): JSX.Element {
  const { t } = useTranslation();
  const {
    join,
    leave,
    toggleMute,
    toggleDeafened,
    toggleVideo,
    selectMicrophone,
    selectSpeaker,
    selectCamera,
    refreshDevices,
    retry,
    setScreenShareQuality,
    setHandRaised,
  } = useVoiceConnection();

  const roomSlug = useWorkspaceStore((state) => state.selectedRoomSlug);
  const participants = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.voiceParticipantsByRoom[state.selectedRoomSlug] ?? [] : [],
  );
  const connectionStatus = useWorkspaceStore((state) => state.voiceConnectionStatus);
  const connectionError = useWorkspaceStore((state) => state.voiceConnectionError);
  const activeChannelId = useWorkspaceStore((state) => state.activeVoiceChannelId);
  const muted = useWorkspaceStore((state) => state.muted);
  const deafened = useWorkspaceStore((state) => state.deafened);
  const videoEnabled = useWorkspaceStore((state) => state.videoEnabled);
  const devices = useWorkspaceStore((state) => state.voiceDevices);
  const selectedMicrophoneId = useWorkspaceStore((state) => state.selectedMicrophoneId);
  const selectedSpeakerId = useWorkspaceStore((state) => state.selectedSpeakerId);
  const selectedCameraId = useWorkspaceStore((state) => state.selectedCameraId);
  const voicePlaybackVolume = useWorkspaceStore((state) => state.voicePlaybackVolume);
  const setVoicePlaybackVolumeState = useWorkspaceStore((state) => state.setVoicePlaybackVolume);
  const voiceParticipantVolumes = useWorkspaceStore((state) => state.voiceParticipantVolumes);
  const setVoiceParticipantVolume = useWorkspaceStore((state) => state.setVoiceParticipantVolume);
  const voiceGain = useWorkspaceStore((state) => state.voiceGain);
  const voiceAutoGain = useWorkspaceStore((state) => state.voiceAutoGain);
  const voiceInputLevel = useWorkspaceStore((state) => state.voiceInputLevel);
  const setVoiceGain = useWorkspaceStore((state) => state.setVoiceGain);
  const setVoiceAutoGain = useWorkspaceStore((state) => state.setVoiceAutoGain);
  const voiceActivity = useWorkspaceStore((state) => state.voiceActivity);
  const remoteStreams = useWorkspaceStore((state) => state.voiceRemoteStreams);
  const localParticipantId = useWorkspaceStore((state) => state.voiceLocalParticipantId);
  const screenShareQuality = useWorkspaceStore((state) => state.screenShareQuality);
  const voiceStats = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.voiceStatsByRoom[state.selectedRoomSlug] ?? null : null,
  );

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  );
  const stageChannelActive = activeChannel?.type === 'stage';

  const handleGainChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setVoiceGain(Number(event.target.value));
    },
    [setVoiceGain],
  );

  const handleAutoGainChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setVoiceAutoGain(event.target.checked);
    },
    [setVoiceAutoGain],
  );

  const handlePlaybackVolumeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setVoicePlaybackVolumeState(Number(event.target.value));
    },
    [setVoicePlaybackVolumeState],
  );

  const handleParticipantVolumeChange = useCallback(
    (participantId: number, value: number) => {
      setVoiceParticipantVolume(participantId, value);
    },
    [setVoiceParticipantVolume],
  );

  const levelPercent = useMemo(() => Math.min(100, Math.round(voiceInputLevel * 100)), [voiceInputLevel]);
  const gainValueText = useMemo(
    () => t('voice.microphoneSettings.gainValue', { value: voiceGain.toFixed(2) }),
    [t, voiceGain],
  );

  const playbackValueText = useMemo(
    () => t('voice.playbackSettings.volumeValue', { value: Math.round(voicePlaybackVolume * 100) }),
    [t, voicePlaybackVolume],
  );

  const statusLabel = useMemo(() => {
    switch (connectionStatus) {
      case 'connected':
        return t('voice.status.connected');
      case 'connecting':
        return t('voice.status.connecting');
      case 'error':
        return t('voice.status.error');
      default:
        return t('voice.status.disconnected');
    }
  }, [connectionStatus, t]);

  const handleJoin = useCallback(
    async (channelId: number) => {
      if (activeChannelId === channelId && connectionStatus === 'connected') {
        leave();
        return;
      }
      await join(channelId);
    },
    [activeChannelId, connectionStatus, join, leave],
  );


  const handleLeave = useCallback(() => {
    if (!activeChannelId || connectionStatus === 'connecting') {
      return;
    }
    leave();
  }, [activeChannelId, connectionStatus, leave]);

  const sectionTitles = useMemo(
    () => ({
      status: t('voice.sections.status', { defaultValue: 'Status' }),
      channels: t('voice.sections.channels', { defaultValue: 'Channels' }),
      devices: t('voice.sections.devices', { defaultValue: 'Devices' }),
      participants: t('voice.sections.participants', { defaultValue: 'Participants' }),
    }),
    [t],
  );

  const callBarLabel = t('voice.controls.label');
  const canLeaveCall = Boolean(activeChannelId) && connectionStatus !== 'connecting';

  const callBar = (
    <footer className="voice-call-bar" role="toolbar" aria-label={callBarLabel}>
      <div className="voice-call-bar__controls">
        <VoiceControlButton
          label={muted ? t('voice.controls.unmute') : t('voice.controls.mute')}
          onClick={toggleMute}
          icon={muted ? <MicOffIcon /> : <MicOnIcon />}
          active={!muted}
          toggle
        />
        <VoiceControlButton
          label={deafened ? t('voice.controls.undeafen') : t('voice.controls.deafen')}
          onClick={toggleDeafened}
          icon={deafened ? <HeadsetOffIcon /> : <HeadsetIcon />}
          active={!deafened}
          toggle
        />
        <VoiceControlButton
          label={videoEnabled ? t('voice.controls.videoOff') : t('voice.controls.videoOn')}
          onClick={toggleVideo}
          icon={videoEnabled ? <VideoOffIcon /> : <VideoOnIcon />}
          active={videoEnabled}
          toggle
        />
        <VoiceControlButton
          label={t('voice.controls.refreshDevices')}
          onClick={() => void refreshDevices()}
          icon={<RefreshIcon />}
          disabled={connectionStatus === 'connecting'}
        />
        {connectionStatus === 'error' ? (
          <VoiceControlButton
            label={t('voice.controls.retry')}
            onClick={() => void retry()}
            icon={<RetryIcon />}
          />
        ) : null}
      </div>
      <button
        type="button"
        className="voice-call-bar__leave"
        onClick={handleLeave}
        disabled={!canLeaveCall}
      >
        {t('voice.leave')}
      </button>
    </footer>
  );

  if (stageChannelActive) {
    return (
      <section className="voice-panel voice-panel--stage" aria-labelledby="voice-title">
        <header className="voice-panel__header">
          <span className="voice-panel__section-label">{sectionTitles.status}</span>
          <div className="voice-panel__title-row">
            <h2 id="voice-title">{t('voice.title')}</h2>
            <span
              className={clsx('voice-status', `voice-status--${connectionStatus}`)}
              role="status"
              aria-live="polite"
            >
              {statusLabel}
            </span>
          </div>
          {connectionStatus === 'error' && connectionError ? (
            <p className="voice-status__error" role="alert">
              {connectionError}
            </p>
          ) : null}
          {!roomSlug ? <p className="panel-empty">{t('voice.noRoomSelected')}</p> : null}
        </header>
        {roomSlug ? (
          <div className="voice-panel__stage-content">
            <div className="voice-card voice-card--stage">
              <StagePanel
                participants={participants}
                localParticipantId={localParticipantId}
                stats={voiceStats}
                screenShareQuality={screenShareQuality}
                onScreenShareQualityChange={setScreenShareQuality}
                onToggleHand={setHandRaised}
              />
            </div>
          </div>
        ) : null}
        {callBar}
      </section>
    );
  }

  return (
    <section className="voice-panel" aria-labelledby="voice-title">
      <header className="voice-panel__header">
        <span className="voice-panel__section-label">{sectionTitles.status}</span>
        <div className="voice-panel__title-row">
          <h2 id="voice-title">{t('voice.title')}</h2>
          <span
            className={clsx('voice-status', `voice-status--${connectionStatus}`)}
            role="status"
            aria-live="polite"
          >
            {statusLabel}
          </span>
        </div>
        {connectionStatus === 'error' && connectionError ? (
          <p className="voice-status__error" role="alert">
            {connectionError}
          </p>
        ) : null}
        {!roomSlug ? <p className="panel-empty">{t('voice.noRoomSelected')}</p> : null}
      </header>
      <div className="voice-panel__body">
        <div className="voice-panel__main">
          <section className="voice-card voice-card--channels" aria-labelledby="voice-channels-title">
            <div className="voice-card__header">
              <h3 id="voice-channels-title">{sectionTitles.channels}</h3>
            </div>
            <div className="voice-card__body voice-card__body--scroll">
              {channels.length === 0 ? (
                <p className="panel-empty">{t('voice.connectHint')}</p>
              ) : (
                <ul className="voice-channel-list">
                  {channels.map((channel) => {
                    const isActive = activeChannelId === channel.id;
                    const joinLabel = isActive ? t('voice.leave') : t('voice.join');
                    const disabled = connectionStatus === 'connecting' && isActive;
                    return (
                      <li key={channel.id}>
                        <button
                          type="button"
                          className={clsx('voice-channel-card', { 'voice-channel-card--active': isActive })}
                          onClick={() => void handleJoin(channel.id)}
                          disabled={disabled}
                          aria-pressed={isActive}
                          title={joinLabel}
                        >
                          <span className="voice-channel-card__icon" aria-hidden="true">
                            {isActive ? <PhoneHangupIcon /> : <PhoneIcon />}
                          </span>
                          <span className="voice-channel-card__details">
                            <span className="voice-channel-card__name">{channel.name}</span>
                            <span className="voice-channel-card__status">{joinLabel}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <section className="voice-card voice-card--devices" aria-labelledby="voice-devices-title">
            <div className="voice-card__header">
              <h3 id="voice-devices-title">{sectionTitles.devices}</h3>
            </div>
            <div className="voice-card__body voice-card__body--stack">
              <div
                className="voice-mic-settings"
                role="group"
                aria-label={t('voice.microphoneSettings.label')}
              >
                <div className="voice-mic-settings__row voice-mic-settings__row--level">
                  <span className="voice-mic-settings__label">{t('voice.microphoneSettings.level')}</span>
                  <div
                    className="voice-mic-settings__meter"
                    role="meter"
                    aria-valuenow={levelPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="voice-mic-settings__meter-bar"
                      style={{ width: `${levelPercent}%` }}
                    />
                  </div>
                  <span className="voice-mic-settings__value">{levelPercent}%</span>
                </div>
                <label className="voice-mic-settings__row">
                  <span className="voice-mic-settings__label">{t('voice.microphoneSettings.gain')}</span>
                  <input
                    className="voice-mic-settings__slider"
                    type="range"
                    min={0.1}
                    max={4}
                    step={0.05}
                    value={voiceGain}
                    onChange={handleGainChange}
                    disabled={voiceAutoGain}
                    aria-valuemin={0.1}
                    aria-valuemax={4}
                    aria-valuenow={voiceGain}
                    aria-valuetext={gainValueText}
                  />
                  <span className="voice-mic-settings__value">{gainValueText}</span>
                </label>
                <label className="voice-mic-settings__toggle">
                  <input type="checkbox" checked={voiceAutoGain} onChange={handleAutoGainChange} />
                  <span>{t('voice.microphoneSettings.auto')}</span>
                </label>
              </div>

              <div
                className="voice-playback-settings"
                role="group"
                aria-label={t('voice.playbackSettings.label')}
              >
                <label className="voice-playback-settings__row">
                  <span className="voice-playback-settings__label">{t('voice.playbackSettings.volume')}</span>
                  <input
                    className="voice-playback-settings__slider"
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={voicePlaybackVolume}
                    onChange={handlePlaybackVolumeChange}
                    aria-valuemin={0}
                    aria-valuemax={2}
                    aria-valuenow={Number(voicePlaybackVolume.toFixed(2))}
                    aria-valuetext={playbackValueText}
                  />
                  <span className="voice-playback-settings__value">{playbackValueText}</span>
                </label>
              </div>

              <div className="voice-devices" role="group" aria-label={t('voice.devices.label')}>
                <label className="voice-device">
                  <span>{t('voice.devices.microphone')}</span>
                  <select
                    value={selectedMicrophoneId ?? ''}
                    onChange={(event) => selectMicrophone(event.target.value || null)}
                  >
                    {devices.microphones.length === 0 ? (
                      <option value="">{t('voice.devices.none')}</option>
                    ) : (
                      devices.microphones.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t('voice.devices.unknown')}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="voice-device">
                  <span>{t('voice.devices.speaker')}</span>
                  <select
                    value={selectedSpeakerId ?? ''}
                    onChange={(event) => selectSpeaker(event.target.value || null)}
                    disabled={!isSetSinkIdSupported()}
                  >
                    {devices.speakers.length === 0 ? (
                      <option value="">{t('voice.devices.none')}</option>
                    ) : (
                      devices.speakers.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t('voice.devices.unknown')}
                        </option>
                      ))
                    )}
                  </select>
                  {!isSetSinkIdSupported() ? (
                    <span className="voice-device__hint">{t('voice.devices.sinkNotSupported')}</span>
                  ) : null}
                </label>
                <label className="voice-device">
                  <span>{t('voice.devices.camera')}</span>
                  <select
                    value={selectedCameraId ?? ''}
                    onChange={(event) => selectCamera(event.target.value || null)}
                  >
                    {devices.cameras.length === 0 ? (
                      <option value="">{t('voice.devices.none')}</option>
                    ) : (
                      devices.cameras.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t('voice.devices.unknown')}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
            </div>
          </section>
        </div>

        <aside className="voice-panel__aside" aria-labelledby="voice-participants-title">
          <div className="voice-card voice-card--participants">
            <div className="voice-card__header">
              <h3 id="voice-participants-title">{sectionTitles.participants}</h3>
            </div>
            <div className="voice-card__body voice-card__body--scroll">
              {participants.length === 0 ? (
                <p className="panel-empty">{t('voice.empty')}</p>
              ) : (
                <ul className="voice-participants-list">
                  {participants.map((participant) => {
                    const activity = voiceActivity[participant.id];
                    const stream = remoteStreams[participant.id] ?? null;
                    const isLocal = participant.id === localParticipantId;
                    const participantVolume = voiceParticipantVolumes[participant.id] ?? 1;
                    const participantVolumeText = t('voice.playbackSettings.participantValue', {
                      value: Math.round(participantVolume * 100),
                    });
                    const participantVolumeLabel = t('voice.playbackSettings.participantSlider', {
                      name: participant.displayName,
                    });
                    const participantMenuLabel = t('voice.playbackSettings.participantMenu', {
                      defaultValue: 'Audio options for {{name}}',
                      name: participant.displayName,
                    });
                    return (
                      <VoiceParticipantRow
                        key={participant.id}
                        participantId={participant.id}
                        name={participant.displayName}
                        role={participant.role}
                        isLocal={isLocal}
                        muted={participant.muted}
                        deafened={participant.deafened}
                        videoEnabled={participant.videoEnabled}
                        speaking={activity?.speaking ?? false}
                        level={activity?.level ?? 0}
                        stream={isLocal ? null : stream}
                        speakerDeviceId={selectedSpeakerId}
                        youLabel={t('voice.participantYou')}
                        globalVolume={voicePlaybackVolume}
                        volume={participantVolume}
                        onVolumeChange={handleParticipantVolumeChange}
                        volumeAriaLabel={participantVolumeLabel}
                        volumeValueText={participantVolumeText}
                        menuLabel={participantMenuLabel}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </aside>
      </div>
      {callBar}
    </section>
  );

}
