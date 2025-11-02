import { useCallback, useEffect, useRef } from 'react';

import { buildWebsocketUrl, fetchWorkspaceConfig, type WorkspaceConfiguration } from '../services/api';
import { getAccessToken } from '../services/session';
import { useWorkspaceStore } from '../state/workspaceStore';
import type { ScreenShareQuality, VoiceRoomStats } from '../types';
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
  setScreenShareQuality: (quality: ScreenShareQuality) => void;
  setHandRaised: (raised: boolean) => void;
  setStageStatus: (participantId: number, status: string) => void;
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

async function createUserMediaStream(
  microphoneId: string | null,
  cameraId: string | null,
  muted: boolean,
  videoEnabled: boolean,
): Promise<MediaStream> {
  const audioConstraints: MediaTrackConstraints = {
    autoGainControl: false,
    ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
  };
  const videoConstraints: MediaTrackConstraints | boolean = videoEnabled
    ? cameraId
      ? { deviceId: { exact: cameraId } }
      : true
    : false;
  try {
    const stream = await requestMediaStream({ audio: audioConstraints, video: videoConstraints });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = videoEnabled;
    });
    return stream;
  } catch (error) {
    if (videoEnabled) {
      const audioOnly = await requestMediaStream({ audio: audioConstraints, video: false });
      audioOnly.getAudioTracks().forEach((track) => {
        track.enabled = true;
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

interface AudioProcessingChain {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  destination: MediaStreamAudioDestinationNode;
  rafId: number | null;
  buffer: Float32Array;
}

const MIN_MIC_GAIN = 0.1;
const MAX_MIC_GAIN = 4;
const AUTO_GAIN_TARGET = 0.25;
const AUTO_GAIN_LOWER = 0.8;
const AUTO_GAIN_UPPER = 1.25;
const AUTO_GAIN_STEP = 0.05;

export function useVoiceConnection(): VoiceConnectionControls {
  const clientRef = useRef<VoiceClient | null>(null);
  const roomRef = useRef<string | null>(null);
  const iceServersRef = useRef<RTCIceServer[] | null>(null);
  const rawInputStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const audioChainRef = useRef<AudioProcessingChain | null>(null);
  const voiceGainRef = useRef<number>(useWorkspaceStore.getState().voiceGain);
  const autoGainRef = useRef<boolean>(useWorkspaceStore.getState().voiceAutoGain);
  const voiceGainValue = useWorkspaceStore((state) => state.voiceGain);
  const voiceAutoGainValue = useWorkspaceStore((state) => state.voiceAutoGain);

  const stopStream = useCallback((stream: MediaStream | null, preserve?: MediaStream | null) => {
    if (!stream || stream === preserve) {
      return;
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch (error) {
        // ignore track stop errors
      }
    }
  }, []);

  const disposeAudioChain = useCallback((chain: AudioProcessingChain | null) => {
    if (!chain) {
      return;
    }
    if (chain.rafId !== null) {
      cancelAnimationFrame(chain.rafId);
    }
    try {
      chain.source.disconnect();
    } catch (error) {
      // ignore disconnect errors
    }
    try {
      chain.gain.disconnect();
    } catch (error) {
      // ignore disconnect errors
    }
    try {
      chain.analyser.disconnect();
    } catch (error) {
      // ignore disconnect errors
    }
    try {
      chain.destination.disconnect();
    } catch (error) {
      // ignore disconnect errors
    }
    void chain.context.close().catch(() => {
      // ignore close errors
    });
  }, []);

  const cleanupAudioProcessing = useCallback(() => {
    const previousChain = audioChainRef.current;
    const previousProcessed = processedStreamRef.current;
    const previousRaw = rawInputStreamRef.current;
    audioChainRef.current = null;
    processedStreamRef.current = null;
    rawInputStreamRef.current = null;
    disposeAudioChain(previousChain);
    stopStream(previousProcessed, null);
    stopStream(previousRaw, null);
    const store = useWorkspaceStore.getState();
    store.setVoiceInputLevel(0);
  }, [disposeAudioChain, stopStream]);

  const applyAudioProcessing = useCallback(
    async (
      stream: MediaStream,
    ): Promise<{ stream: MediaStream; commit: () => void; rollback: () => void }> => {
      const previousChain = audioChainRef.current;
      const previousProcessed = processedStreamRef.current;
      const previousRaw = rawInputStreamRef.current;

      const fallback = () => {
        return {
          stream,
          commit: () => {
            audioChainRef.current = null;
            processedStreamRef.current = stream;
            rawInputStreamRef.current = stream;
            disposeAudioChain(previousChain);
            stopStream(previousProcessed, stream);
            stopStream(previousRaw, stream);
            const store = useWorkspaceStore.getState();
            store.setVoiceInputLevel(0);
          },
          rollback: () => {
            stopStream(stream, null);
            const store = useWorkspaceStore.getState();
            store.setVoiceInputLevel(0);
          },
        };
      };

      if (typeof window === 'undefined') {
        return fallback();
      }

      const AudioContextCtor: typeof AudioContext | undefined =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextCtor) {
        return fallback();
      }

      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const destination = context.createMediaStreamDestination();

      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(destination);

      const processed = new MediaStream();
      destination.stream.getAudioTracks().forEach((track) => {
        processed.addTrack(track);
      });
      stream.getVideoTracks().forEach((track) => {
        processed.addTrack(track);
      });

      const buffer = new Float32Array(analyser.fftSize);
      const chain: AudioProcessingChain = {
        context,
        source,
        gain,
        analyser,
        destination,
        rafId: null,
        buffer,
      };

      const monitor = (): void => {
        if (audioChainRef.current !== chain) {
          return;
        }
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let index = 0; index < buffer.length; index += 1) {
          const sample = buffer[index];
          sum += sample * sample;
        }
        const level = Math.min(1, Math.sqrt(sum / buffer.length));
        const store = useWorkspaceStore.getState();
        store.setVoiceInputLevel(level);

        if (autoGainRef.current) {
          const currentGain = gain.gain.value;
          let nextGain = currentGain;
          if (level < AUTO_GAIN_TARGET * AUTO_GAIN_LOWER) {
            nextGain = Math.min(MAX_MIC_GAIN, currentGain * (1 + AUTO_GAIN_STEP));
          } else if (level > AUTO_GAIN_TARGET * AUTO_GAIN_UPPER) {
            nextGain = Math.max(MIN_MIC_GAIN, currentGain * (1 - AUTO_GAIN_STEP));
          }
          if (Math.abs(nextGain - currentGain) > 0.001) {
            gain.gain.setTargetAtTime(nextGain, context.currentTime, 0.05);
            const storeState = useWorkspaceStore.getState();
            if (Math.abs(storeState.voiceGain - nextGain) > 0.001) {
              storeState.setVoiceGain(nextGain);
            }
          }
        }

        chain.rafId = requestAnimationFrame(monitor);
      };

      const commit = (): void => {
        disposeAudioChain(previousChain);
        stopStream(previousProcessed, processed);
        stopStream(previousRaw, stream);
        audioChainRef.current = chain;
        processedStreamRef.current = processed;
        rawInputStreamRef.current = stream;
        const clamped = Math.min(Math.max(voiceGainRef.current, MIN_MIC_GAIN), MAX_MIC_GAIN);
        gain.gain.setValueAtTime(clamped, context.currentTime);
        const store = useWorkspaceStore.getState();
        store.setVoiceInputLevel(0);
        chain.rafId = requestAnimationFrame(monitor);
      };

      const rollback = (): void => {
        disposeAudioChain(chain);
        stopStream(processed, null);
        stopStream(stream, null);
        audioChainRef.current = previousChain;
        processedStreamRef.current = previousProcessed;
        rawInputStreamRef.current = previousRaw;
        const store = useWorkspaceStore.getState();
        store.setVoiceInputLevel(0);
      };

      return { stream: processed, commit, rollback };
    },
    [disposeAudioChain, stopStream, autoGainRef, voiceGainRef],
  );

  useEffect(() => {
    const clamped = Math.min(Math.max(voiceGainValue, MIN_MIC_GAIN), MAX_MIC_GAIN);
    voiceGainRef.current = clamped;
    const chain = audioChainRef.current;
    if (chain) {
      chain.gain.gain.setTargetAtTime(clamped, chain.context.currentTime, 0.05);
    }
  }, [voiceGainValue]);

  useEffect(() => {
    autoGainRef.current = voiceAutoGainValue;
  }, [voiceAutoGainValue]);

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
      onQualityUpdate: (participantId, track, metrics) => {
        if (!roomSlug) {
          return;
        }
        const store = useWorkspaceStore.getState();
        store.setVoiceParticipantQuality(roomSlug, participantId, track, metrics);
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

      let processing:
        | { stream: MediaStream; commit: () => void; rollback: () => void }
        | null = null;
      try {
        const client = await ensureClient(roomSlug, token);
        const rawStream = await createUserMediaStream(microphoneId, cameraId, muted, videoEnabled);
        await refreshDevices();
        const processingResult = await applyAudioProcessing(rawStream);
        processing = processingResult;
        const processedStream = processingResult.stream;
        processedStream.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
          if (!track.contentHint) {
            track.contentHint = 'speech';
          }
        });
        processedStream.getVideoTracks().forEach((track) => {
          track.enabled = videoEnabled;
        });
        await client.connect({ localStream: processedStream, muted, videoEnabled });
        processingResult.commit();
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
        processing?.rollback();
        store.setVoiceConnectionStatus('error', message);
        return { success: false, error: message };
      }
    },
    [applyAudioProcessing, ensureClient, refreshDevices],
  );

  const leave = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    roomRef.current = null;
    const store = useWorkspaceStore.getState();
    store.resetVoiceState();
    cleanupAudioProcessing();
  }, [cleanupAudioProcessing]);

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
        let processing:
          | { stream: MediaStream; commit: () => void; rollback: () => void }
          | null = null;
        try {
          const state = useWorkspaceStore.getState();
          const rawStream = await createUserMediaStream(
            state.selectedMicrophoneId,
            state.selectedCameraId,
            state.muted,
            true,
          );
          const processingResult = await applyAudioProcessing(rawStream);
          processing = processingResult;
          const stream = processingResult.stream;
          stream.getAudioTracks().forEach((track) => {
            track.enabled = !state.muted;
            if (!track.contentHint) {
              track.contentHint = 'speech';
            }
          });
          stream.getVideoTracks().forEach((track) => {
            track.enabled = true;
          });
          await client.replaceLocalStream(stream, {
            muted: state.muted,
            videoEnabled: true,
          });
          processingResult.commit();
        } catch (error) {
          processing?.rollback();
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
  }, [applyAudioProcessing]);

  const selectMicrophone = useCallback((deviceId: string | null) => {
    const store = useWorkspaceStore.getState();
    store.setSelectedMicrophoneId(deviceId);
    const client = clientRef.current;
    if (client && client.getLocalStream()) {
      void (async () => {
        let processing:
          | { stream: MediaStream; commit: () => void; rollback: () => void }
          | null = null;
        try {
          const state = useWorkspaceStore.getState();
          const rawStream = await createUserMediaStream(
            deviceId,
            state.selectedCameraId,
            state.muted,
            state.videoEnabled,
          );
          const processingResult = await applyAudioProcessing(rawStream);
          processing = processingResult;
          const stream = processingResult.stream;
          stream.getAudioTracks().forEach((track) => {
            track.enabled = !state.muted;
            if (!track.contentHint) {
              track.contentHint = 'speech';
            }
          });
          stream.getVideoTracks().forEach((track) => {
            track.enabled = state.videoEnabled;
          });
          await client.replaceLocalStream(stream, {
            muted: state.muted,
            videoEnabled: state.videoEnabled,
          });
          processingResult.commit();
        } catch (error) {
          processing?.rollback();
          console.warn('Failed to switch microphone', error);
        }
      })();
    }
  }, [applyAudioProcessing]);

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
        let processing:
          | { stream: MediaStream; commit: () => void; rollback: () => void }
          | null = null;
        try {
          const state = useWorkspaceStore.getState();
          const rawStream = await createUserMediaStream(
            state.selectedMicrophoneId,
            deviceId,
            state.muted,
            state.videoEnabled,
          );
          const processingResult = await applyAudioProcessing(rawStream);
          processing = processingResult;
          const stream = processingResult.stream;
          stream.getAudioTracks().forEach((track) => {
            track.enabled = !state.muted;
            if (!track.contentHint) {
              track.contentHint = 'speech';
            }
          });
          stream.getVideoTracks().forEach((track) => {
            track.enabled = state.videoEnabled;
          });
          await client.replaceLocalStream(stream, {
            muted: state.muted,
            videoEnabled: state.videoEnabled,
          });
          processingResult.commit();
        } catch (error) {
          processing?.rollback();
          console.warn('Failed to switch camera', error);
        }
      })();
    }
  }, [applyAudioProcessing]);

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

  const setScreenShareQualityControl = useCallback((quality: ScreenShareQuality) => {
    const store = useWorkspaceStore.getState();
    store.setScreenShareQuality(quality);
    clientRef.current?.setScreenShareQuality(quality);
  }, []);

  const setHandRaised = useCallback((raised: boolean) => {
    clientRef.current?.setHandRaised(raised);
  }, []);

  const setStageStatusControl = useCallback((participantId: number, status: string) => {
    clientRef.current?.setStageStatus(participantId, status);
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
    setScreenShareQuality: setScreenShareQualityControl,
    setHandRaised,
    setStageStatus: setStageStatusControl,
  };
}
