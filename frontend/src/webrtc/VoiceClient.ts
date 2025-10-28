import { AudioLevelMonitor } from './audioLevel';
import type { VoiceParticipant, VoiceRoomStats, VoiceFeatureFlags } from '../types';

export type VoiceClientConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface VoiceClientHandlers {
  onConnectionStateChange?: (state: VoiceClientConnectionState) => void;
  onError?: (message: string) => void;
  onWelcome?: (payload: {
    user: VoiceParticipant;
    role: string;
    features: VoiceFeatureFlags;
  }) => void;
  onParticipantsSnapshot?: (participants: VoiceParticipant[], stats: VoiceRoomStats) => void;
  onParticipantUpdated?: (participant: VoiceParticipant, stats?: VoiceRoomStats) => void;
  onParticipantJoined?: (participant: VoiceParticipant) => void;
  onParticipantLeft?: (participantId: number) => void;
  onRemoteStream?: (participantId: number, stream: MediaStream | null) => void;
  onAudioActivity?: (participantId: number, level: number, speaking: boolean) => void;
  onRecordingState?: (state: { active: boolean; timestamp?: string; by?: VoiceParticipant }) => void;
}

export interface VoiceClientOptions {
  roomSlug: string;
  signalUrl: string;
  token: string;
  iceServers: RTCIceServer[];
  reconnect?: boolean;
  handlers?: VoiceClientHandlers;
}

interface ConnectParams {
  localStream: MediaStream;
  muted: boolean;
  videoEnabled: boolean;
}

interface PeerEntry {
  id: number;
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isPolite: boolean;
}

interface SignalPayload {
  type: 'signal';
  signal: {
    kind: 'offer' | 'answer' | 'candidate' | 'bye' | string;
    description?: RTCSessionDescriptionInit | null;
    candidate?: RTCIceCandidateInit | null;
    [key: string]: unknown;
  };
  from: VoiceParticipant;
}

interface ParticipantsStatePayload {
  type: 'state';
  event: 'participants';
  participants: VoiceParticipant[];
  stats: VoiceRoomStats;
}

interface ParticipantUpdatePayload {
  type: 'state';
  event: 'participant-updated';
  participant: VoiceParticipant;
  stats?: VoiceRoomStats;
}

interface RecordingPayload {
  type: 'state';
  event: 'recording';
  active: boolean;
  timestamp?: string;
  by?: VoiceParticipant;
}

interface WelcomePayload {
  type: 'system';
  event: 'welcome';
  user: VoiceParticipant;
  role: string;
  features: VoiceFeatureFlags;
}

interface PeerEventPayload {
  type: 'system';
  event: 'peer-joined' | 'peer-left';
  user: VoiceParticipant;
}

interface ErrorPayload {
  type: 'error';
  detail?: string;
}

type ServerPayload =
  | SignalPayload
  | ParticipantsStatePayload
  | ParticipantUpdatePayload
  | RecordingPayload
  | WelcomePayload
  | PeerEventPayload
  | ErrorPayload
  | { type: string; [key: string]: unknown };

type PendingResolver = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;

export class VoiceClient {
  private token: string;
  private websocket: WebSocket | null = null;
  private readonly roomSlug: string;
  private readonly signalUrl: string;
  private readonly iceServers: RTCIceServer[];
  private handlers: VoiceClientHandlers;
  private shouldReconnect: boolean;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectResolver: PendingResolver | null = null;
  private peers = new Map<number, PeerEntry>();
  private localStream: MediaStream | null = null;
  private localParticipant: VoiceParticipant | null = null;
  private localRole: string | null = null;
  private localFeatures: VoiceFeatureFlags | null = null;
  private localMuted = false;
  private localDeafened = false;
  private localVideoEnabled = false;
  private lastConnectParams: ConnectParams | null = null;
  private audioContext: AudioContext | null = null;
  private localMonitor: AudioLevelMonitor | null = null;
  private remoteMonitors = new Map<number, AudioLevelMonitor>();
  private activityLevels = new Map<number, { level: number; speaking: boolean }>();
  private keepAliveTimer: number | null = null;
  private pendingSocketError: string | null = null;

  constructor(options: VoiceClientOptions) {
    this.roomSlug = options.roomSlug;
    this.signalUrl = options.signalUrl;
    this.token = options.token;
    this.iceServers = options.iceServers;
    this.handlers = options.handlers ?? {};
    this.shouldReconnect = options.reconnect ?? true;
  }

  setHandlers(handlers: VoiceClientHandlers): void {
    this.handlers = handlers;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async connect(params: ConnectParams): Promise<void> {
    this.localStream = params.localStream;
    this.lastConnectParams = params;
    this.applyLocalMediaState(params.muted, params.videoEnabled);
    this.localMuted = params.muted;
    this.localVideoEnabled = params.videoEnabled;
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    await this.startConnection();
  }

  async retry(): Promise<void> {
    if (!this.localStream || !this.lastConnectParams) {
      throw new Error('No active connection to retry');
    }
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    await this.startConnection();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.safeSend({ type: 'bye' });
    }
    this.cleanup();
  }

  destroy(): void {
    this.disconnect();
    this.stopLocalStream();
    this.localStream = null;
  }

  async setMuted(muted: boolean): Promise<void> {
    this.localMuted = muted;
    if (this.lastConnectParams) {
      this.lastConnectParams.muted = muted;
    }
    this.applyLocalMediaState(muted, this.localVideoEnabled);
    this.safeSend({ type: 'set-muted', muted });
    await this.updateAudioActivity(this.localParticipant?.id ?? null, 0, false);
  }

  setDeafened(deafened: boolean): void {
    this.localDeafened = deafened;
    this.safeSend({ type: 'set-deafened', deafened });
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    this.localVideoEnabled = enabled;
    if (this.lastConnectParams) {
      this.lastConnectParams.videoEnabled = enabled;
    }
    this.applyLocalMediaState(this.localMuted, enabled);
    this.safeSend({ type: 'media', videoEnabled: enabled });
    if (this.localStream) {
      await this.refreshLocalSenders();
    }
  }

  async replaceLocalStream(stream: MediaStream, params: { muted: boolean; videoEnabled: boolean }): Promise<void> {
    const previous = this.localStream;
    this.localStream = stream;
    this.lastConnectParams = { localStream: stream, muted: params.muted, videoEnabled: params.videoEnabled };
    this.localMuted = params.muted;
    this.localVideoEnabled = params.videoEnabled;
    this.applyLocalMediaState(params.muted, params.videoEnabled);
    await this.refreshLocalSenders();
    previous?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (error) {
        // ignore stop errors
      }
    });
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  private async startConnection(): Promise<void> {
    this.cleanupWebSocket();
    this.cleanupPeers();
    this.handlers.onConnectionStateChange?.('connecting');
    this.pendingSocketError = null;
    const url = new URL(this.signalUrl);
    url.searchParams.set('token', this.token);

    return new Promise((resolve, reject) => {
      this.connectResolver = {
        resolve: () => {
          this.connectResolver = null;
          resolve();
        },
        reject: (error: Error) => {
          this.connectResolver = null;
          reject(error);
        },
      } satisfies PendingResolver;

      try {
        const socket = new WebSocket(url.toString());
        this.websocket = socket;
        socket.addEventListener('open', this.handleOpen);
        socket.addEventListener('message', this.handleMessage);
        socket.addEventListener('error', this.handleSocketError);
        socket.addEventListener('close', this.handleClose);
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Failed to connect to voice server');
        this.connectResolver?.reject(err);
        this.handlers.onError?.(err.message);
      }
    });
  }

  private handleOpen = (): void => {
    this.startKeepAlive();
    this.handlers.onConnectionStateChange?.('connecting');
  };

  private handleMessage = (event: MessageEvent): void => {
    let payload: ServerPayload;
    try {
      payload = JSON.parse(event.data as string) as ServerPayload;
    } catch (error) {
      console.warn('Failed to parse voice payload', error);
      return;
    }

    switch (payload.type) {
      case 'system':
        this.handleSystemPayload(payload as WelcomePayload | PeerEventPayload);
        break;
      case 'state':
        this.handleStatePayload(
          payload as ParticipantsStatePayload | ParticipantUpdatePayload | RecordingPayload,
        );
        break;
      case 'signal':
        void this.handleSignalPayload(payload as SignalPayload);
        break;
      case 'error':
        this.handleErrorPayload(payload as ErrorPayload);
        break;
      default:
        break;
    }
  };

  private handleSocketError = (): void => {
    this.stopKeepAlive();
    this.pendingSocketError = 'Voice connection error';
  };

  private handleClose = (event: CloseEvent): void => {
    this.stopKeepAlive();
    const reason = event.reason?.trim() || null;
    const fallbackMessage = this.pendingSocketError;
    this.pendingSocketError = null;
    const message =
      reason || (event.code !== 1000 ? fallbackMessage ?? 'Connection closed' : null);

    if (this.connectResolver) {
      this.connectResolver.reject(new Error(message ?? 'Connection closed'));
    } else if (message) {
      this.handlers.onError?.(message);
    }
    this.handlers.onConnectionStateChange?.('disconnected');
    this.cleanupPeers();
    this.stopLocalMonitor();
    if (event.code === 1008) {
      this.shouldReconnect = false;
      this.clearReconnectTimer();
    }
    if (this.shouldReconnect && this.localStream && this.lastConnectParams && event.code !== 1008) {
      this.scheduleReconnect();
    }
  };

  private handleSystemPayload(payload: WelcomePayload | PeerEventPayload): void {
    if (payload.event === 'welcome') {
      this.localParticipant = payload.user;
      this.localRole = payload.role;
      this.localFeatures = payload.features;
      this.handlers.onWelcome?.({ user: payload.user, role: payload.role, features: payload.features });
      this.handlers.onConnectionStateChange?.('connected');
      this.connectResolver?.resolve();
      this.startLocalMonitor();
      if (this.lastConnectParams?.muted) {
        this.safeSend({ type: 'set-muted', muted: true });
      }
      if (this.localDeafened) {
        this.safeSend({ type: 'set-deafened', deafened: true });
      }
      if (this.lastConnectParams?.videoEnabled) {
        this.safeSend({ type: 'media', videoEnabled: true });
      }
      return;
    }

    if (payload.event === 'peer-joined') {
      this.handlers.onParticipantJoined?.(payload.user);
      if (this.localParticipant && payload.user.id !== this.localParticipant.id) {
        void this.ensurePeerConnection(payload.user.id);
      }
    } else if (payload.event === 'peer-left') {
      this.handlers.onParticipantLeft?.(payload.user.id);
      this.closePeer(payload.user.id);
    }
  }

  private handleStatePayload(
    payload: ParticipantsStatePayload | ParticipantUpdatePayload | RecordingPayload,
  ): void {
    if (payload.event === 'participants') {
      this.handlers.onParticipantsSnapshot?.(payload.participants, payload.stats);
      if (this.localParticipant) {
        const remoteIds = payload.participants
          .filter((participant) => participant.id !== this.localParticipant?.id)
          .map((participant) => participant.id);
        remoteIds.forEach((id) => {
          void this.ensurePeerConnection(id);
        });
        for (const peerId of this.peers.keys()) {
          if (!remoteIds.includes(peerId)) {
            this.closePeer(peerId);
          }
        }
      }
      return;
    }

    if (payload.event === 'participant-updated') {
      this.handlers.onParticipantUpdated?.(payload.participant, payload.stats);
      if (this.localParticipant && payload.participant.id !== this.localParticipant.id) {
        void this.ensurePeerConnection(payload.participant.id);
      }
      return;
    }

    if (payload.event === 'recording') {
      this.handlers.onRecordingState?.({
        active: payload.active,
        timestamp: payload.timestamp,
        by: payload.by,
      });
    }
  }

  private async handleSignalPayload(payload: SignalPayload): Promise<void> {
    const from = payload.from;
    if (!from || (this.localParticipant && from.id === this.localParticipant.id)) {
      return;
    }
    const entry = await this.ensurePeerConnection(from.id);
    if (!entry) {
      return;
    }
    const { pc } = entry;
    const signal = payload.signal ?? {};
    const kind = signal.kind;

    if (kind === 'offer' || kind === 'answer') {
      const description = signal.description as RTCSessionDescriptionInit | undefined;
      if (!description) {
        return;
      }
      const offerCollision =
        description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
      entry.ignoreOffer = !entry.isPolite && offerCollision;
      if (entry.ignoreOffer) {
        return;
      }
      try {
        await pc.setRemoteDescription(description);
        entry.ignoreOffer = false;
        if (description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.sendSignal('answer', { description: pc.localDescription });
        }
      } catch (error) {
        console.warn('Failed to handle SDP description', error);
      }
      return;
    }

    if (kind === 'candidate') {
      const candidate = signal.candidate as RTCIceCandidateInit | undefined;
      try {
        await pc.addIceCandidate(candidate ?? null);
      } catch (error) {
        if (!entry.ignoreOffer) {
          console.warn('Failed to add ICE candidate', error);
        }
      }
      return;
    }

    if (kind === 'bye') {
      this.closePeer(from.id);
    }
  }

  private handleErrorPayload(payload: ErrorPayload): void {
    if (payload.detail) {
      this.handlers.onError?.(payload.detail);
    }
  }

  private async ensurePeerConnection(remoteId: number): Promise<PeerEntry | null> {
    if (!this.localStream || !this.localParticipant) {
      return null;
    }
    let entry = this.peers.get(remoteId);
    if (entry) {
      return entry;
    }
    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
    };
    const pc = new RTCPeerConnection(configuration);
    entry = {
      id: remoteId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      isPolite: this.localParticipant.id > remoteId,
    };
    this.peers.set(remoteId, entry);

    pc.addEventListener('negotiationneeded', async () => {
      try {
        entry!.makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        this.sendSignal('offer', { description: pc.localDescription });
      } catch (error) {
        console.warn('Negotiation failed', error);
      } finally {
        entry!.makingOffer = false;
      }
    });

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.sendSignal('candidate', { candidate: event.candidate });
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        this.closePeer(remoteId);
      }
    });

    pc.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.registerRemoteStream(remoteId, stream);
      }
    });

    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    return entry;
  }

  private registerRemoteStream(participantId: number, stream: MediaStream): void {
    this.handlers.onRemoteStream?.(participantId, stream);
    this.startRemoteMonitor(participantId, stream);
    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        this.removeRemoteStream(participantId);
      });
    });
  }

  private removeRemoteStream(participantId: number): void {
    this.handlers.onRemoteStream?.(participantId, null);
    this.stopRemoteMonitor(participantId);
    this.updateAudioActivity(participantId, 0, false).catch(() => {
      // ignore errors
    });
  }

  private closePeer(participantId: number): void {
    const entry = this.peers.get(participantId);
    if (!entry) {
      return;
    }
    this.peers.delete(participantId);
    this.stopRemoteMonitor(participantId);
    try {
      entry.pc.close();
    } catch (error) {
      // ignore
    }
    this.removeRemoteStream(participantId);
  }

  private cleanupPeers(): void {
    for (const participantId of this.peers.keys()) {
      this.closePeer(participantId);
    }
    this.peers.clear();
  }

  private cleanupWebSocket(): void {
    if (!this.websocket) {
      return;
    }
    this.stopKeepAlive();
    this.websocket.removeEventListener('open', this.handleOpen);
    this.websocket.removeEventListener('message', this.handleMessage);
    this.websocket.removeEventListener('error', this.handleSocketError);
    this.websocket.removeEventListener('close', this.handleClose);
    try {
      this.websocket.close();
    } catch (error) {
      // ignore
    }
    this.websocket = null;
  }

  private cleanup(): void {
    this.cleanupWebSocket();
    this.cleanupPeers();
    this.stopLocalMonitor();
    this.activityLevels.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.shouldReconnect) {
      return;
    }
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * 2 ** attempt);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || !this.localStream || !this.lastConnectParams) {
        return;
      }
      void this.startConnection().catch((error) => {
        this.handlers.onError?.(error instanceof Error ? error.message : String(error));
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  private sendSignal(kind: string, payload: Record<string, unknown>): void {
    this.safeSend({ type: kind, ...payload });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    if (typeof window === 'undefined') {
      return;
    }
    this.keepAliveTimer = window.setInterval(() => {
      this.safeSend({ type: 'ping' });
    }, 20_000);
  }

  private stopKeepAlive(): void {
    if (typeof window === 'undefined') {
      return;
    }
    if (this.keepAliveTimer !== null) {
      window.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private safeSend(payload: Record<string, unknown>): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.websocket.send(JSON.stringify(payload));
    } catch (error) {
      console.warn('Failed to send voice payload', error);
    }
  }

  private applyLocalMediaState(muted: boolean, videoEnabled: boolean): void {
    if (!this.localStream) {
      return;
    }
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
    for (const track of this.localStream.getVideoTracks()) {
      track.enabled = videoEnabled;
    }
  }

  private async refreshLocalSenders(): Promise<void> {
    if (!this.localStream) {
      return;
    }
    for (const entry of this.peers.values()) {
      const pc = entry.pc;
      const senders = pc.getSenders();
      const audioTrack = this.localStream.getAudioTracks()[0] ?? null;
      const videoTrack = this.localStream.getVideoTracks()[0] ?? null;
      const audioSender = senders.find((sender) => sender.track?.kind === 'audio');
      const videoSender = senders.find((sender) => sender.track?.kind === 'video');
      if (audioSender) {
        await audioSender.replaceTrack(audioTrack);
      } else if (audioTrack) {
        pc.addTrack(audioTrack, this.localStream);
      }
      if (videoSender) {
        await videoSender.replaceTrack(videoTrack);
      } else if (videoTrack) {
        pc.addTrack(videoTrack, this.localStream);
      }
    }
    this.startLocalMonitor();
  }

  private ensureAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') {
      return null;
    }
    if (this.audioContext && this.audioContext.state === 'closed') {
      this.audioContext = null;
    }
    if (!this.audioContext) {
      const ctor =
        window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!ctor) {
        return null;
      }
      this.audioContext = new ctor();
    }
    return this.audioContext;
  }

  private startLocalMonitor(): void {
    if (!this.localStream || !this.localParticipant) {
      return;
    }
    const context = this.ensureAudioContext();
    if (!context) {
      return;
    }
    if (this.localMonitor) {
      this.localMonitor.stop();
    }
    this.localMonitor = new AudioLevelMonitor(context, this.localStream, (level) => {
      const speaking = !this.localMuted && level > 0.05;
      void this.updateAudioActivity(this.localParticipant?.id ?? null, level, speaking);
    });
    this.localMonitor.start();
  }

  private stopLocalMonitor(): void {
    if (this.localMonitor) {
      this.localMonitor.stop();
      this.localMonitor = null;
    }
  }

  private startRemoteMonitor(participantId: number, stream: MediaStream): void {
    const context = this.ensureAudioContext();
    if (!context) {
      return;
    }
    this.stopRemoteMonitor(participantId);
    const monitor = new AudioLevelMonitor(context, stream, (level) => {
      const speaking = level > 0.05;
      void this.updateAudioActivity(participantId, level, speaking);
    });
    this.remoteMonitors.set(participantId, monitor);
    monitor.start();
  }

  private stopRemoteMonitor(participantId: number): void {
    const monitor = this.remoteMonitors.get(participantId);
    if (monitor) {
      monitor.stop();
      this.remoteMonitors.delete(participantId);
    }
  }

  private async updateAudioActivity(
    participantId: number | null,
    level: number,
    speaking: boolean,
  ): Promise<void> {
    if (participantId === null) {
      return;
    }
    const current = this.activityLevels.get(participantId);
    const roundedLevel = Math.round(level * 100) / 100;
    if (current && current.level === roundedLevel && current.speaking === speaking) {
      return;
    }
    this.activityLevels.set(participantId, { level: roundedLevel, speaking });
    this.handlers.onAudioActivity?.(participantId, roundedLevel, speaking);
  }

  private stopLocalStream(): void {
    this.localStream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (error) {
        // ignore stop errors
      }
    });
  }
}
