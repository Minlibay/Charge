import { useCallback, useEffect, useRef } from 'react';

import { buildWebsocketUrl, fetchWorkspaceConfig, type WorkspaceConfiguration } from '../services/api';
import { getAccessToken } from '../services/session';
import { useWorkspaceStore } from '../state/workspaceStore';
import type { VoiceRoomStats } from '../types';
import { VoiceClient, type VoiceClientHandlers, type VoiceClientConnectionState } from '../webrtc/VoiceClient';
import { listMediaDevices, requestMediaStream } from '../webrtc/devices';

interface JoinResult {
  success: boolean;
  error?: string;
}

export interface VoiceConnectionControls {
  join: (channelId: number) => Promise<JoinResult>;
  leave: () => void;
  toggleMute: () => Promise<void>;
  toggleDeafened: () => void;
  toggleVideo: () => Promise<void>;
  selectMicrophone: (deviceId: string | null) => void;
  selectSpeaker: (deviceId: string | null) => void;
  selectCamera: (deviceId: string | null) => void;
  refreshDevices: () => Promise<void>;
  retry: () => Promise<void>;
}

const configCache: {
  promise: Promise<WorkspaceConfiguration> | null;
} = {
  promise: null,
};

async function loadWorkspaceConfig(): Promise<WorkspaceConfiguration> {
  if (!configCache.promise) {
    configCache.promise = fetchWorkspaceConfig();
  }
  return configCache.promise;
}

function normalizeIceServers(config: WorkspaceConfiguration): RTCIceServer[] {
  const entries = Array.isArray(config.iceServers) ? config.iceServers : [];
  const servers: RTCIceServer[] = [];
  const seenKeys = new Set<string>();
  const appendServer = (server: RTCIceServer | null): void => {
    if (!server) {
      return;
    }
    const urls = Array.isArray(server.urls) ? [...server.urls] : [server.urls];
    if (!urls.length) {
      return;
    }
    const key = `${[...urls].sort().join(',')}|${server.username ?? ''}|${server.credential ?? ''}`;
    if (seenKeys.has(key)) {
      return;
    }
    const normalized: RTCIceServer = { urls };
    if (server.username) {
      normalized.username = server.username;
    }
    if (server.credential) {
      normalized.credential = server.credential;
    }
    servers.push(normalized);
    seenKeys.add(key);
  };

  const coerceEntry = (entry: unknown): RTCIceServer | null => {
    if (!entry) {
      return null;
    }
    if (typeof entry === 'string') {
      return { urls: [entry] };
    }
    if (Array.isArray(entry)) {
      const urls = entry.map((item) => String(item)).filter(Boolean);
      return urls.length ? { urls } : null;
    }
    if (typeof entry === 'object') {
      const value = entry as Record<string, unknown>;
      const urlsField = value.urls ?? value.url;
      let urls: string[] = [];
      if (typeof urlsField === 'string') {
        urls = [urlsField];
      } else if (Array.isArray(urlsField)) {
        urls = urlsField.map((item) => String(item)).filter(Boolean);
      }
      if (!urls.length) {
        return null;
      }
      const server: RTCIceServer = { urls };
      if (typeof value.username === 'string' && value.username) {
        server.username = value.username;
      }
      if (typeof value.credential === 'string' && value.credential) {
        server.credential = value.credential;
      }
      return server;
    }
    return null;
  };

  entries.forEach((entry) => {
    appendServer(coerceEntry(entry));
  });

  if (servers.length === 0 && Array.isArray(config.stun)) {
    config.stun.forEach((url) => {
      if (typeof url === 'string' && url) {
        appendServer({ urls: [url] });
      }
    });
  }

  return servers;
}

function mapConnectionState(state: VoiceClientConnectionState): 'disconnected' | 'connecting' | 'connected' {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    default:
      return 'disconnected';
  }
}

async function acquireLocalStream(
  microphoneId: string | null,
  cameraId: string | null,
  muted: boolean,
  videoEnabled: boolean,
): Promise<MediaStream> {
  const audioConstraints: MediaTrackConstraints | boolean = microphoneId
    ? { deviceId: { exact: microphoneId } }
    : true;
  const videoConstraints: MediaTrackConstraints | boolean = videoEnabled
    ? cameraId
      ? { deviceId: { exact: cameraId } }
      : true
    : false;
  try {
    const stream = await requestMediaStream({ audio: audioConstraints, video: videoConstraints });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = videoEnabled;
    });
    return stream;
  } catch (error) {
    if (videoEnabled) {
      const audioOnly = await requestMediaStream({ audio: audioConstraints, video: false });
      audioOnly.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      return audioOnly;
    }
    throw error;
  }
}

function defaultStats(): VoiceRoomStats {
  return {
    total: 0,
    speakers: 0,
    listeners: 0,
    activeSpeakers: 0,
  };
}

export function useVoiceConnection(): VoiceConnectionControls {
  const clientRef = useRef<VoiceClient | null>(null);
  const roomRef = useRef<string | null>(null);
  const iceServersRef = useRef<RTCIceServer[] | null>(null);

  const updateHandlers = useCallback(
    (roomSlug: string | null): VoiceClientHandlers => ({
      onConnectionStateChange: (state) => {
        const store = useWorkspaceStore.getState();
        store.setVoiceConnectionStatus(mapConnectionState(state));
      },
      onError: (message) => {
        const store = useWorkspaceStore.getState();
        store.setVoiceConnectionStatus('error', message);
        store.setError(message);
      },
      onWelcome: ({ user, role, features }) => {
        const store = useWorkspaceStore.getState();
        store.setVoiceConnectionMeta({
          roomSlug,
          localParticipantId: user.id,
          localRole: role,
          features,
        });
        if (roomSlug) {
          store.updateVoiceParticipant(roomSlug, user);
        }
      },
      onParticipantsSnapshot: (participants, stats) => {
        if (!roomSlug) {
          return;
        }
        const store = useWorkspaceStore.getState();
        store.setVoiceParticipants(roomSlug, participants);
        store.setVoiceStats(roomSlug, stats);
      },
      onParticipantUpdated: (participant, stats) => {
        if (!roomSlug) {
          return;
        }
        const store = useWorkspaceStore.getState();
        store.updateVoiceParticipant(roomSlug, participant);
        if (stats) {
          store.setVoiceStats(roomSlug, stats);
        }
      },
      onParticipantJoined: (participant) => {
        if (!roomSlug) {
          return;
        }
        const store = useWorkspaceStore.getState();
        store.updateVoiceParticipant(roomSlug, participant);
      },
      onParticipantLeft: (participantId) => {
        const store = useWorkspaceStore.getState();
        if (roomSlug) {
          store.removeVoiceParticipant(roomSlug, participantId);
        }
        store.clearVoiceActivity(participantId);
        store.setVoiceRemoteStream(participantId, null);
      },
      onRemoteStream: (participantId, stream) => {
        const store = useWorkspaceStore.getState();
        store.setVoiceRemoteStream(participantId, stream);
      },
      onAudioActivity: (participantId, level, speaking) => {
        const store = useWorkspaceStore.getState();
        store.setVoiceActivity(participantId, { level, speaking });
      },
      onRecordingState: () => {
        // Recording state updates can be handled in future iterations.
      },
    }),
    [],
  );

  const ensureClient = useCallback(
    async (roomSlug: string, token: string): Promise<VoiceClient> => {
      if (!iceServersRef.current) {
        const config = await loadWorkspaceConfig();
        iceServersRef.current = normalizeIceServers(config);
      }
      const iceServers = iceServersRef.current ?? [];
      let client = clientRef.current;
      if (!client || roomRef.current !== roomSlug) {
        client?.destroy();
        const signalUrl = buildWebsocketUrl(`/ws/signal/${encodeURIComponent(roomSlug)}`);
        client = new VoiceClient({
          roomSlug,
          signalUrl,
          token,
          iceServers,
          reconnect: true,
        });
        clientRef.current = client;
        roomRef.current = roomSlug;
      } else {
        client.setToken(token);
      }
      client.setHandlers(updateHandlers(roomSlug));
      return client;
    },
    [updateHandlers],
  );

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await listMediaDevices();
      const store = useWorkspaceStore.getState();
      store.setVoiceDevices(devices);
      const current = useWorkspaceStore.getState();
      if (!current.selectedMicrophoneId && devices.microphones[0]) {
        store.setSelectedMicrophoneId(devices.microphones[0].deviceId);
      }
      if (!current.selectedSpeakerId && devices.speakers[0]) {
        store.setSelectedSpeakerId(devices.speakers[0].deviceId);
      }
      if (!current.selectedCameraId && devices.cameras[0]) {
        store.setSelectedCameraId(devices.cameras[0].deviceId);
      }
    } catch (error) {
      console.warn('Failed to enumerate media devices', error);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) {
      return;
    }
    const handler = () => {
      void refreshDevices();
    };
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, [refreshDevices]);

  const join = useCallback(
    async (channelId: number): Promise<JoinResult> => {
      const state = useWorkspaceStore.getState();
      const roomSlug = state.selectedRoomSlug;
      if (!roomSlug) {
        const message = 'Комната не выбрана';
        state.setVoiceConnectionStatus('error', message);
        state.setError(message);
        return { success: false, error: message };
      }
      const token = getAccessToken();
      if (!token) {
        const message = 'Требуется авторизация для голосового канала';
        state.setVoiceConnectionStatus('error', message);
        state.setError(message);
        return { success: false, error: message };
      }

      const muted = state.muted;
      const deafened = state.deafened;
      const videoEnabled = state.videoEnabled;
      const microphoneId = state.selectedMicrophoneId;
      const cameraId = state.selectedCameraId;

      state.setVoiceConnectionStatus('connecting');
      state.setVoiceConnectionMeta({ roomSlug, channelId, localParticipantId: null, localRole: null, features: null });
      state.setActiveVoiceChannel(channelId);
      state.setVoiceParticipants(roomSlug, []);
      state.setVoiceStats(roomSlug, defaultStats());

      try {
        const client = await ensureClient(roomSlug, token);
        const stream = await acquireLocalStream(microphoneId, cameraId, muted, videoEnabled);
        await refreshDevices();
        await client.connect({ localStream: stream, muted, videoEnabled });
        if (deafened) {
          client.setDeafened(true);
        }
        return { success: true };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Не удалось подключиться к голосовому каналу';
        const store = useWorkspaceStore.getState();
        store.setVoiceConnectionStatus('error', message);
        store.setError(message);
        if (clientRef.current) {
          clientRef.current.destroy();
          clientRef.current = null;
          roomRef.current = null;
        }
        store.setVoiceConnectionStatus('error', message);
        return { success: false, error: message };
      }
    },
    [ensureClient, refreshDevices],
  );

  const leave = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    roomRef.current = null;
    const store = useWorkspaceStore.getState();
    store.resetVoiceState();
  }, []);

  const selectedRoomSlug = useWorkspaceStore((state) => state.selectedRoomSlug);

  useEffect(() => {
    if (!selectedRoomSlug && clientRef.current) {
      leave();
      return;
    }
    if (selectedRoomSlug && roomRef.current && roomRef.current !== selectedRoomSlug) {
      leave();
    }
  }, [leave, selectedRoomSlug]);

  const toggleMute = useCallback(async () => {
    const store = useWorkspaceStore.getState();
    const muted = !store.muted;
    store.setVoiceMuted(muted);
    const client = clientRef.current;
    if (client) {
      await client.setMuted(muted);
    }
  }, []);

  const toggleDeafened = useCallback(() => {
    const store = useWorkspaceStore.getState();
    const deafened = !store.deafened;
    store.setVoiceDeafened(deafened);
    clientRef.current?.setDeafened(deafened);
  }, []);

  const toggleVideo = useCallback(async () => {
    const store = useWorkspaceStore.getState();
    const enabled = !store.videoEnabled;
    store.setVoiceVideoEnabled(enabled);
    const client = clientRef.current;
    if (client) {
      if (enabled && client.getLocalStream()?.getVideoTracks().length === 0) {
        try {
          const state = useWorkspaceStore.getState();
          const stream = await acquireLocalStream(
            state.selectedMicrophoneId,
            state.selectedCameraId,
            state.muted,
            true,
          );
          await client.replaceLocalStream(stream, {
            muted: state.muted,
            videoEnabled: true,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Не удалось включить камеру';
          const current = useWorkspaceStore.getState();
          current.setVoiceConnectionStatus('error', message);
          current.setError(message);
          current.setVoiceVideoEnabled(false);
          return;
        }
      }
      await client.setVideoEnabled(enabled);
    }
  }, []);

  const selectMicrophone = useCallback((deviceId: string | null) => {
    const store = useWorkspaceStore.getState();
    store.setSelectedMicrophoneId(deviceId);
    const client = clientRef.current;
    if (client && client.getLocalStream()) {
      void (async () => {
        try {
          const state = useWorkspaceStore.getState();
          const stream = await acquireLocalStream(
            deviceId,
            state.selectedCameraId,
            state.muted,
            state.videoEnabled,
          );
          await client.replaceLocalStream(stream, {
            muted: state.muted,
            videoEnabled: state.videoEnabled,
          });
        } catch (error) {
          console.warn('Failed to switch microphone', error);
        }
      })();
    }
  }, []);

  const selectSpeaker = useCallback((deviceId: string | null) => {
    const store = useWorkspaceStore.getState();
    store.setSelectedSpeakerId(deviceId);
  }, []);

  const selectCamera = useCallback((deviceId: string | null) => {
    const store = useWorkspaceStore.getState();
    store.setSelectedCameraId(deviceId);
    const client = clientRef.current;
    if (client && client.getLocalStream()) {
      void (async () => {
        try {
          const state = useWorkspaceStore.getState();
          const stream = await acquireLocalStream(
            state.selectedMicrophoneId,
            deviceId,
            state.muted,
            state.videoEnabled,
          );
          await client.replaceLocalStream(stream, {
            muted: state.muted,
            videoEnabled: state.videoEnabled,
          });
        } catch (error) {
          console.warn('Failed to switch camera', error);
        }
      })();
    }
  }, []);

  const retry = useCallback(async () => {
    if (!clientRef.current) {
      return;
    }
    try {
      await clientRef.current.retry();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Не удалось переподключиться к голосовому каналу';
      const store = useWorkspaceStore.getState();
      store.setVoiceConnectionStatus('error', message);
      store.setError(message);
    }
  }, []);

  return {
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
  };
}
