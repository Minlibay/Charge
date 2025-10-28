import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel } from '../types';
import { useVoiceConnection } from '../hooks/useVoiceConnection';
import { useWorkspaceStore } from '../state/workspaceStore';
import { applyOutputDevice, isSetSinkIdSupported } from '../webrtc/devices';

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
}

function VoiceControlButton({ label, onClick, icon, active = false, disabled = false }: VoiceControlButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={clsx('voice-control-button', { 'voice-control-button--active': active })}
      onClick={onClick}
      title={label}
      aria-label={label}
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
}: VoiceParticipantRowProps): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) {
      return;
    }
    element.muted = deafened || isLocal;
  }, [deafened, isLocal]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) {
      return;
    }
    if (stream) {
      if (element.srcObject !== stream) {
        element.srcObject = stream;
      }
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {
          // autoplay may be blocked; ignore
        });
      }
      if (!isLocal && isSetSinkIdSupported()) {
        void applyOutputDevice(element, speakerDeviceId ?? null);
      }
    } else if (element.srcObject) {
      element.srcObject = null;
    }
  }, [isLocal, speakerDeviceId, stream]);

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
  const voiceActivity = useWorkspaceStore((state) => state.voiceActivity);
  const remoteStreams = useWorkspaceStore((state) => state.voiceRemoteStreams);
  const localParticipantId = useWorkspaceStore((state) => state.voiceLocalParticipantId);

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

  return (
    <section className="voice-panel" aria-labelledby="voice-title">
      <header className="panel-header">
        <div>
          <h2 id="voice-title">{t('voice.title')}</h2>
          <span className={clsx('voice-status', `voice-status--${connectionStatus}`)}>{statusLabel}</span>
          {connectionStatus === 'error' && connectionError ? (
            <p className="voice-status__error" role="alert">
              {connectionError}
            </p>
          ) : null}
        </div>
        <div className="voice-controls" role="group" aria-label={t('voice.controls.label')}>
          <VoiceControlButton
            label={muted ? t('voice.controls.unmute') : t('voice.controls.mute')}
            onClick={toggleMute}
            icon={muted ? <MicOffIcon /> : <MicOnIcon />}
            active={!muted}
          />
          <VoiceControlButton
            label={deafened ? t('voice.controls.undeafen') : t('voice.controls.deafen')}
            onClick={toggleDeafened}
            icon={deafened ? <HeadsetOffIcon /> : <HeadsetIcon />}
            active={!deafened}
          />
          <VoiceControlButton
            label={videoEnabled ? t('voice.controls.videoOff') : t('voice.controls.videoOn')}
            onClick={toggleVideo}
            icon={videoEnabled ? <VideoOffIcon /> : <VideoOnIcon />}
            active={videoEnabled}
          />
          <VoiceControlButton
            label={t('voice.controls.refreshDevices')}
            onClick={() => void refreshDevices()}
            icon={<RefreshIcon />}
          />
          {connectionStatus === 'error' ? (
            <VoiceControlButton
              label={t('voice.controls.retry')}
              onClick={() => void retry()}
              icon={<RetryIcon />}
            />
          ) : null}
        </div>
      </header>
      <div className="voice-section">
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
      <div className="voice-participants">
        <h3>{t('voice.participants', { defaultValue: 'Participants' })}</h3>
        {participants.length === 0 ? (
          <p className="panel-empty">{t('voice.empty')}</p>
        ) : (
          <ul>
            {participants.map((participant) => {
              const activity = voiceActivity[participant.id];
              const stream = remoteStreams[participant.id] ?? null;
              const isLocal = participant.id === localParticipantId;
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
                />
              );
            })}
          </ul>
        )}
      </div>
      {roomSlug ? null : (
        <p className="panel-empty">{t('voice.noRoomSelected')}</p>
      )}
    </section>
  );
}
