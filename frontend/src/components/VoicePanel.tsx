import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
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
          <button type="button" className="ghost" onClick={toggleMute}>
            {muted ? t('voice.controls.unmute') : t('voice.controls.mute')}
          </button>
          <button type="button" className="ghost" onClick={toggleDeafened}>
            {deafened ? t('voice.controls.undeafen') : t('voice.controls.deafen')}
          </button>
          <button type="button" className="ghost" onClick={toggleVideo}>
            {videoEnabled ? t('voice.controls.videoOff') : t('voice.controls.videoOn')}
          </button>
          <button type="button" className="ghost" onClick={() => void refreshDevices()}>
            {t('voice.controls.refreshDevices')}
          </button>
          {connectionStatus === 'error' ? (
            <button type="button" className="ghost" onClick={() => void retry()}>
              {t('voice.controls.retry')}
            </button>
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
                  <div className="voice-channel">
                    <span className="voice-channel__name">{channel.name}</span>
                    <button
                      type="button"
                      className={clsx('ghost', { primary: isActive })}
                      onClick={() => void handleJoin(channel.id)}
                      disabled={disabled}
                    >
                      {joinLabel}
                    </button>
                  </div>
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
