import { AudioLevelMonitor } from './audioLevel';
import type {
  ScreenShareQuality,
  VoiceFeatureFlags,
  VoiceParticipant,
  VoiceQualityMetrics,
  VoiceRoomStats,
} from '../types';
import { logger } from '../services/logger';

// Helper for conditional debug logging in development
const isDevelopment = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
const debugLog = (...args: unknown[]): void => {
  if (isDevelopment) {
    logger.debug(String(args[0]), args.length > 1 ? { args: args.slice(1) } : undefined);
  }
};

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
  onQualityUpdate?: (
    participantId: number,
    track: string,
    metrics: VoiceQualityMetrics,
  ) => void;
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
  remoteStream: MediaStream | null;
  pendingCandidates: (RTCIceCandidateInit | null)[];
  remoteDescriptionSet: boolean;
  disconnectTimer: number | null;
  receivedTracks: Map<string, MediaStreamTrack>;
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

interface QualityUpdatePayload {
  type: 'state';
  event: 'quality-update';
  userId: number;
  track: string;
  metrics: VoiceQualityMetrics;
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
  | QualityUpdatePayload
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
const PEER_DISCONNECT_GRACE_PERIOD = 5_000;

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
  private screenShareQuality: ScreenShareQuality = 'high';

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
      void this.applyScreenShareQuality();
    }
  }

  setScreenShareQuality(quality: ScreenShareQuality): void {
    if (this.screenShareQuality === quality) {
      return;
    }
    this.screenShareQuality = quality;
    void this.applyScreenShareQuality();
  }

  setHandRaised(raised: boolean): void {
    this.safeSend({ type: 'state', event: 'stage', action: 'hand', raised });
  }

  setStageStatus(participantId: number, status: string): void {
    this.safeSend({
      type: 'state',
      event: 'stage',
      action: 'set-status',
      target: participantId,
      status,
    });
  }

  async replaceLocalStream(stream: MediaStream, params: { muted: boolean; videoEnabled: boolean }): Promise<void> {
    const previous = this.localStream;
    this.localStream = stream;
    this.lastConnectParams = { localStream: stream, muted: params.muted, videoEnabled: params.videoEnabled };
    this.localMuted = params.muted;
    this.localVideoEnabled = params.videoEnabled;
    this.applyLocalMediaState(params.muted, params.videoEnabled);
    await this.refreshLocalSenders();
    void this.applyScreenShareQuality();
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
      logger.warn('Failed to parse voice payload', undefined, error instanceof Error ? error : new Error(String(error)));
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

  private isParticipantsStatePayload(payload: unknown): payload is ParticipantsStatePayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'type' in payload &&
      payload.type === 'state' &&
      'event' in payload &&
      payload.event === 'participants' &&
      'participants' in payload &&
      'stats' in payload
    );
  }

  private isParticipantUpdatePayload(payload: unknown): payload is ParticipantUpdatePayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'type' in payload &&
      payload.type === 'state' &&
      'event' in payload &&
      payload.event === 'participant-updated' &&
      'participant' in payload
    );
  }

  private isQualityUpdatePayload(payload: unknown): payload is QualityUpdatePayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'type' in payload &&
      payload.type === 'state' &&
      'event' in payload &&
      payload.event === 'quality-update' &&
      'userId' in payload &&
      'track' in payload &&
      'metrics' in payload
    );
  }

  private isRecordingPayload(payload: unknown): payload is RecordingPayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'type' in payload &&
      payload.type === 'state' &&
      'event' in payload &&
      payload.event === 'recording' &&
      'active' in payload
    );
  }

  private handleStatePayload(
    payload:
      | ParticipantsStatePayload
      | ParticipantUpdatePayload
      | RecordingPayload
      | QualityUpdatePayload,
  ): void {
    if (this.isParticipantsStatePayload(payload)) {
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

    if (this.isParticipantUpdatePayload(payload)) {
      this.handlers.onParticipantUpdated?.(payload.participant, payload.stats);
      if (this.localParticipant && payload.participant.id !== this.localParticipant.id) {
        void this.ensurePeerConnection(payload.participant.id);
      }
      return;
    }

    if (this.isQualityUpdatePayload(payload)) {
      const track = typeof payload.track === 'string' ? payload.track : 'audio';
      this.handlers.onQualityUpdate?.(payload.userId, track, payload.metrics);
      return;
    }

    if (this.isRecordingPayload(payload)) {
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
      entry.remoteDescriptionSet = false;
      try {
        // Check what the remote description contains
        const remoteHasAudio = description.sdp?.includes('m=audio') ?? false;
        const remoteHasVideo = description.sdp?.includes('m=video') ?? false;
        debugLog('Setting remote description for peer', from.id, {
          type: description.type,
          remoteHasAudio,
          remoteHasVideo,
          sdpPreview: description.sdp?.substring(0, 200) + '...',
        });
        
        await pc.setRemoteDescription(description);
        entry.remoteDescriptionSet = true;
        debugLog('Remote description set for peer', from.id, {
          signalingState: pc.signalingState,
          connectionState: pc.connectionState,
        });
        if (entry.pendingCandidates.length) {
          const queued = entry.pendingCandidates.splice(0);
          debugLog('Flushing', queued.length, 'pending ICE candidates for peer', from.id);
          for (const candidate of queued) {
            try {
              await pc.addIceCandidate(candidate);
              const candidateType = candidate?.candidate?.includes('typ relay') ? 'relay' : candidate?.candidate?.includes('typ srflx') ? 'srflx' : candidate?.candidate?.includes('typ host') ? 'host' : 'unknown';
              debugLog('Added queued ICE candidate for peer', from.id, candidateType);
            } catch (error) {
              logger.warn('Failed to flush pending ICE candidate for peer', { peerId: from.id }, error instanceof Error ? error : new Error(String(error)));
            }
          }
        }
        entry.ignoreOffer = false;
        if (description.type === 'offer') {
          debugLog('Creating answer for peer', from.id);
          const answer = await pc.createAnswer();
          // Check if SDP includes media tracks
          const hasAudio = answer.sdp?.includes('m=audio') ?? false;
          const hasVideo = answer.sdp?.includes('m=video') ?? false;
          debugLog('Created answer for peer', from.id, {
            type: answer.type,
            hasAudio,
            hasVideo,
            sdpPreview: answer.sdp?.substring(0, 200) + '...',
          });
          await pc.setLocalDescription(answer);
          this.sendSignal('answer', { description: pc.localDescription });
          debugLog('Sent answer to peer', from.id);
        }
      } catch (error) {
        logger.warn('Failed to handle SDP description', undefined, error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    if (kind === 'candidate') {
      const candidate = signal.candidate as RTCIceCandidateInit | undefined;
      
      // Accept all candidates (including relay/TURN) to allow connection establishment
      // P2P will be preferred, but TURN will be used as fallback if needed
      if (!entry.remoteDescriptionSet) {
        entry.pendingCandidates.push(candidate ?? null);
        debugLog('Queued ICE candidate for peer', from.id, 'waiting for remote description');
        return;
      }
      try {
        await pc.addIceCandidate(candidate ?? null);
        const candidateType = candidate?.candidate?.includes('typ relay') ? 'relay' : candidate?.candidate?.includes('typ srflx') ? 'srflx' : candidate?.candidate?.includes('typ host') ? 'host' : 'unknown';
        debugLog('Added ICE candidate for peer', from.id, candidateType);
      } catch (error) {
        if (!entry.ignoreOffer) {
          logger.warn('Failed to add ICE candidate for peer', { peerId: from.id }, error instanceof Error ? error : new Error(String(error)));
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

  // Keep this method for potential future use, but we now use all ICE servers
  // to allow TURN fallback when direct P2P connection fails
  private getDirectIceServers(): RTCIceServer[] {
    const directServers = this.iceServers
      .map((server) => {
        const urls = server.urls;
        const urlList = Array.isArray(urls) ? urls : urls ? [urls] : [];
        const filteredUrls = urlList.filter((url) => {
          if (typeof url !== 'string') {
            return true;
          }
          const normalized = url.trim().toLowerCase();
          return !normalized.startsWith('turn:') && !normalized.startsWith('turns:');
        });
        if (filteredUrls.length === 0) {
          return null;
        }
        return {
          ...server,
          urls: Array.isArray(urls)
            ? filteredUrls
            : filteredUrls.length === 1
            ? filteredUrls[0]
            : filteredUrls,
        } satisfies RTCIceServer;
      })
      .filter((server): server is RTCIceServer => server !== null);

    return directServers.length > 0 ? directServers : [];
  }

  private isRelayCandidate(
    candidate: (RTCIceCandidateInit | RTCIceCandidate) | null | undefined,
  ): boolean {
    if (!candidate) {
      return false;
    }

    // Check if candidate is RTCIceCandidate (has type property)
    if ('type' in candidate && typeof candidate.type === 'string' && candidate.type.toLowerCase() === 'relay') {
      return true;
    }

    // Check candidate string for relay type
    const candidateString =
      (candidate as RTCIceCandidateInit).candidate ?? (candidate as RTCIceCandidate).candidate;
    if (typeof candidateString === 'string') {
      return candidateString.toLowerCase().includes(' typ relay');
    }

    return false;
  }

  private async ensurePeerConnection(remoteId: number): Promise<PeerEntry | null> {
    if (!this.localStream || !this.localParticipant) {
      return null;
    }
    let entry = this.peers.get(remoteId);
    if (entry) {
      return entry;
    }
    // Use all ICE servers (including TURN) for WebRTC
    // TURN will be used as fallback when direct P2P connection fails
    // Log ICE servers for debugging
    debugLog('Creating peer connection with ICE servers', remoteId, {
      serverCount: this.iceServers.length,
      servers: this.iceServers.map((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return {
          urls: urls.map((u) => String(u).substring(0, 50)),
          hasUsername: Boolean(s.username),
          hasCredential: Boolean(s.credential),
        };
      }),
    });
    
    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 0,
      // Don't restrict to relay-only, allow P2P first, then TURN fallback
      iceTransportPolicy: 'all',
    };
    const pc = new RTCPeerConnection(configuration);
    entry = {
      id: remoteId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      isPolite: this.localParticipant.id > remoteId,
      remoteStream: null,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      disconnectTimer: null,
      receivedTracks: new Map<string, MediaStreamTrack>(),
    };
    this.peers.set(remoteId, entry);

    pc.addEventListener('negotiationneeded', async () => {
      try {
        debugLog('Negotiation needed for peer', remoteId, {
          signalingState: pc.signalingState,
          localTracks: pc.getSenders().length,
        });
        entry!.makingOffer = true;
        const offer = await pc.createOffer();
        // Check if SDP includes media tracks
        const hasAudio = offer.sdp?.includes('m=audio') ?? false;
        const hasVideo = offer.sdp?.includes('m=video') ?? false;
        debugLog('Created offer for peer', remoteId, {
          type: offer.type,
          hasAudio,
          hasVideo,
          sdpPreview: offer.sdp?.substring(0, 200) + '...',
        });
        await pc.setLocalDescription(offer);
        this.sendSignal('offer', { description: pc.localDescription });
        debugLog('Sent offer to peer', remoteId);
      } catch (error) {
        logger.error('Negotiation failed for peer', error instanceof Error ? error : new Error(String(error)), { peerId: remoteId });
      } finally {
        entry!.makingOffer = false;
      }
    });

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        // Log candidate type for debugging
        const candidateType = event.candidate.type;
        const isRelay = this.isRelayCandidate(event.candidate);
        debugLog('ICE candidate generated for peer', remoteId, {
          type: candidateType,
          isRelay,
          candidate: event.candidate.candidate?.substring(0, 100),
        });
        
        // Send all candidates (including relay/TURN) to allow fallback
        // TURN candidates are critical for NAT traversal
        this.sendSignal('candidate', { candidate: event.candidate });
      } else {
        debugLog('ICE candidate gathering completed for peer', remoteId);
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      const connectionState = pc.connectionState;
      const iceGatheringState = pc.iceGatheringState;
      debugLog('ICE connection state changed for peer', remoteId, {
        iceConnectionState: state,
        connectionState,
        iceGatheringState,
      });
      
      if (state === 'connected' || state === 'completed') {
        this.clearPeerDisconnectTimer(entry!);
        debugLog('Peer connection established', remoteId, {
          localDescription: pc.localDescription?.type,
          remoteDescription: pc.remoteDescription?.type,
        });
        
        // Re-register remote stream when connection is established
        // This ensures audio tracks start receiving data
        if (entry!.remoteStream) {
          logger.warn('Re-registering remote stream after connection established', {
            participantId: remoteId,
            streamId: entry!.remoteStream.id,
            audioTracks: entry!.remoteStream.getAudioTracks().length,
          });
          // Trigger stream update to ensure tracks are active
          updateStreamFromTracks();
        }
        return;
      }
      if (state === 'disconnected') {
        logger.warn('Peer connection disconnected', { peerId: remoteId, connectionState });
        this.schedulePeerDisconnect(remoteId, entry!);
        return;
      }
      if (state === 'failed') {
        logger.error('Peer connection failed', undefined, { 
          peerId: remoteId, 
          state,
          connectionState,
          localCandidates: pc.localDescription?.sdp?.match(/a=candidate:/g)?.length ?? 0,
          remoteCandidates: pc.remoteDescription?.sdp?.match(/a=candidate:/g)?.length ?? 0,
        });
        this.clearPeerDisconnectTimer(entry!);
        this.closePeer(remoteId);
      }
      if (state === 'closed') {
        logger.warn('Peer connection closed', { peerId: remoteId });
        this.clearPeerDisconnectTimer(entry!);
        this.closePeer(remoteId);
      }
    });
    
    pc.addEventListener('connectionstatechange', () => {
      debugLog('Peer connection state changed for peer', remoteId, pc.connectionState);
    });

    // Track all received tracks to build complete stream
    const receivedTracks = entry.receivedTracks;
    
    const updateStreamFromTracks = () => {
      const allTracks = Array.from(receivedTracks.values());
      const activeTracks = allTracks.filter(t => t.readyState !== 'ended');
      
      debugLog('=== updateStreamFromTracks CALLED ===', remoteId, {
        totalTracks: allTracks.length,
        activeTracks: activeTracks.length,
        endedTracks: allTracks.filter(t => t.readyState === 'ended').length,
        audioTracks: allTracks.filter(t => t.kind === 'audio').length,
        videoTracks: allTracks.filter(t => t.kind === 'video').length,
        trackDetails: allTracks.map(t => ({
          id: t.id,
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState,
          muted: t.muted,
        })),
      });
      
      if (activeTracks.length === 0) {
        debugLog('No active tracks, clearing stream', remoteId, {
          hadStream: entry!.remoteStream !== null,
        });
        if (entry!.remoteStream) {
          entry!.remoteStream = null;
          debugLog('Calling onRemoteStream with null', remoteId);
          this.handlers.onRemoteStream?.(remoteId, null);
        }
        return;
      }
      
      // Create new stream with all active tracks (always create fresh stream to ensure reactivity)
      const newStream = new MediaStream(activeTracks);
      
      debugLog('New MediaStream created', remoteId, {
        streamId: newStream.id,
        tracksInStream: newStream.getTracks().length,
        audioTracksInStream: newStream.getAudioTracks().length,
      });
      
      // Ensure all audio tracks are enabled immediately
      const audioTracks = newStream.getAudioTracks();
      audioTracks.forEach((track) => {
        const wasEnabled = track.enabled;
        track.enabled = true;
        debugLog('Audio track processed in stream', remoteId, {
          trackId: track.id,
          wasEnabled,
          nowEnabled: track.enabled,
          readyState: track.readyState,
          muted: track.muted,
          label: track.label,
        });
      });
      
      entry!.remoteStream = newStream;
      
      debugLog('Stream created and updated for peer', remoteId, {
        streamId: newStream.id,
        audioTracks: audioTracks.length,
        videoTracks: newStream.getVideoTracks().length,
        totalTracks: activeTracks.length,
        enabledAudioTracks: audioTracks.filter(t => t.enabled).length,
        liveAudioTracks: audioTracks.filter(t => t.readyState === 'live').length,
        mutedAudioTracks: audioTracks.filter(t => t.muted).length,
        trackIds: activeTracks.map(t => ({ id: t.id, kind: t.kind, enabled: t.enabled, muted: t.muted })),
      });
      
      // Always register stream to ensure UI updates
      debugLog('About to call registerRemoteStream', remoteId, {
        streamId: newStream.id,
        audioTracks: audioTracks.length,
        hasHandler: Boolean(this.handlers.onRemoteStream),
      });
      this.registerRemoteStream(remoteId, newStream);
      debugLog('registerRemoteStream completed', remoteId);
    };
    
    pc.addEventListener('track', (event) => {
      const track = event.track;
      const receiver = event.receiver;
      
      debugLog('=== TRACK EVENT RECEIVED ===', remoteId, {
        trackId: track.id,
        trackKind: track.kind,
        trackLabel: track.label,
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
        hasStreams: event.streams?.length ?? 0,
        streamIds: event.streams?.map(s => s.id) ?? [],
        hasReceiver: receiver !== undefined,
        receiverId: receiver?.track?.id,
      });
      
      // Check receiver statistics to verify RTP data is being received
      if (receiver && track.kind === 'audio') {
        // Check immediately
        receiver.getStats().then((stats) => {
          const statsArray = Array.from(stats.values());
          const inboundRtpStats = statsArray.filter((s: RTCStats) => s.type === 'inbound-rtp');
          logger.warn('Receiver statistics when track received', {
            participantId: remoteId,
            trackId: track.id,
            receiverId: receiver.track?.id,
            inboundRtpStats: inboundRtpStats.length,
            stats: inboundRtpStats.map((s: any) => ({
              bytesReceived: s.bytesReceived,
              packetsReceived: s.packetsReceived,
              packetsLost: s.packetsLost,
              audioLevel: s.audioLevel,
              totalAudioEnergy: s.totalAudioEnergy,
            })),
          });
        }).catch(() => {
          // ignore errors
        });
        
        // Check again after delay to see if data starts flowing
        setTimeout(() => {
          receiver.getStats().then((stats) => {
            const statsArray = Array.from(stats.values());
            const inboundRtpStats = statsArray.filter((s: RTCStats) => s.type === 'inbound-rtp');
            if (inboundRtpStats.length > 0) {
              const rtpStats = inboundRtpStats[0] as any;
              const hasData = (rtpStats.bytesReceived ?? 0) > 0 || (rtpStats.packetsReceived ?? 0) > 0;
              
              // Check for media source stats (decoder stats)
              const mediaSourceStats = statsArray.filter((s: RTCStats) => s.type === 'media-source');
              const decoderStats = statsArray.filter((s: RTCStats) => s.type === 'codec');
              
              logger.warn('Receiver statistics after delay', {
                participantId: remoteId,
                trackId: track.id,
                bytesReceived: rtpStats.bytesReceived,
                packetsReceived: rtpStats.packetsReceived,
                packetsLost: rtpStats.packetsLost,
                audioLevel: rtpStats.audioLevel,
                totalAudioEnergy: rtpStats.totalAudioEnergy,
                hasData,
                // Additional diagnostic info
                jitter: rtpStats.jitter,
                framesDecoded: rtpStats.framesDecoded,
                framesDropped: rtpStats.framesDropped,
                framesReceived: rtpStats.framesReceived,
                mediaSourceStatsCount: mediaSourceStats.length,
                decoderStatsCount: decoderStats.length,
                // Additional diagnostic fields
                ssrc: rtpStats.ssrc,
                kind: rtpStats.kind,
                mimeType: rtpStats.mimeType,
                clockRate: rtpStats.clockRate,
                note: 'If audioLevel is 0, remote participant may not be speaking or microphone is muted. If framesDecoded is undefined, frames may not be decoded.',
              });
              
              // Log media source stats if available
              if (mediaSourceStats.length > 0) {
                logger.warn('Media source statistics', {
                  participantId: remoteId,
                  trackId: track.id,
                  stats: mediaSourceStats.map((s: any) => ({
                    type: s.type,
                    audioLevel: s.audioLevel,
                    totalAudioEnergy: s.totalAudioEnergy,
                    totalSamplesDuration: s.totalSamplesDuration,
                    totalSamplesReceived: s.totalSamplesReceived,
                  })),
                });
              }
              
              // Log decoder stats if available
              if (decoderStats.length > 0) {
                logger.warn('Decoder statistics', {
                  participantId: remoteId,
                  trackId: track.id,
                  stats: decoderStats.map((s: any) => ({
                    type: s.type,
                    mimeType: s.mimeType,
                    payloadType: s.payloadType,
                    clockRate: s.clockRate,
                    channels: s.channels,
                  })),
                });
              }
              
              // If data is flowing but track is not receiving it, trigger stream update
              if (hasData && track.readyState === 'live') {
                logger.warn('RTP data is flowing but track may not be receiving it - triggering stream update', {
                  participantId: remoteId,
                  trackId: track.id,
                  audioLevel: rtpStats.audioLevel ?? 0,
                  totalAudioEnergy: rtpStats.totalAudioEnergy ?? 0,
                  framesDecoded: rtpStats.framesDecoded,
                });
                // Force track to be enabled
                track.enabled = true;
                // Trigger stream update to ensure track is properly connected
                updateStreamFromTracks();
              }
            } else {
              logger.warn('No inbound RTP stats found after delay', {
                participantId: remoteId,
                trackId: track.id,
                note: 'RTP data may not be flowing yet',
              });
            }
          }).catch(() => {
            // ignore errors
          });
        }, 2000);
      }
      
      // Immediately enable audio tracks
      if (track.kind === 'audio') {
        track.enabled = true;
        debugLog('Audio track enabled immediately', remoteId, track.id);
      }
      
      // If event has streams, also process tracks from those streams
      if (event.streams && event.streams.length > 0) {
        event.streams.forEach((stream) => {
          stream.getTracks().forEach((streamTrack) => {
            if (streamTrack.kind === 'audio') {
              streamTrack.enabled = true;
            }
            receivedTracks.set(streamTrack.id, streamTrack);
            debugLog('Track from event stream added', remoteId, {
              trackId: streamTrack.id,
              kind: streamTrack.kind,
              enabled: streamTrack.enabled,
            });
          });
        });
      }
      
      // Store track (replace if exists)
      receivedTracks.set(track.id, track);
      
      // Handle track events
      const handleEnded = () => {
        debugLog('Track ended for peer', remoteId, track.kind, track.id);
        receivedTracks.delete(track.id);
        updateStreamFromTracks();
      };
      
      const handleUnmute = () => {
        debugLog('Track unmuted for peer', remoteId, track.kind, track.id);
        if (track.kind === 'audio') {
          track.enabled = true;
        }
        // Update stream to trigger UI refresh
        updateStreamFromTracks();
      };
      
      const handleMute = () => {
        debugLog('Track muted for peer', remoteId, track.kind, track.id);
        // Track stays enabled even when muted
        if (track.kind === 'audio') {
          track.enabled = true;
        }
      };
      
      const handleStarted = () => {
        debugLog('Track started for peer', remoteId, track.kind, track.id);
        if (track.kind === 'audio') {
          track.enabled = true;
        }
        updateStreamFromTracks();
      };
      
      track.addEventListener('ended', handleEnded, { once: true });
      track.addEventListener('unmute', handleUnmute);
      track.addEventListener('mute', handleMute);
      track.addEventListener('started', handleStarted);
      
      // Update stream immediately
      updateStreamFromTracks();
    });

    // Add all local tracks to the peer connection BEFORE any negotiation
    // This ensures tracks are included in the SDP offer/answer
    const audioTracks = this.localStream.getAudioTracks();
    const videoTracks = this.localStream.getVideoTracks();
    debugLog('Adding local tracks to peer connection', remoteId, {
      audio: audioTracks.length,
      video: videoTracks.length,
    });
    
    for (const track of this.localStream.getTracks()) {
      try {
        pc.addTrack(track, this.localStream);
        debugLog('Added local track to peer connection', remoteId, {
          kind: track.kind,
          trackId: track.id,
          enabled: track.enabled,
        });
      } catch (error) {
        logger.error('Failed to add local track to peer connection', error instanceof Error ? error : new Error(String(error)), {
          peerId: remoteId,
          kind: track.kind,
          trackId: track.id,
        });
      }
    }
    
    // Verify tracks were added
    const senders = pc.getSenders();
    debugLog('Peer connection senders after adding tracks', remoteId, {
      total: senders.length,
      audio: senders.filter(s => s.track?.kind === 'audio').length,
      video: senders.filter(s => s.track?.kind === 'video').length,
    });

    void this.applyScreenShareQualityToConnection(pc);

    return entry;
  }

  private registerRemoteStream(participantId: number, stream: MediaStream | null): void {
    const entry = this.peers.get(participantId);
    if (entry) {
      entry.remoteStream = stream;
    }
    
    if (!stream) {
      debugLog('Removing remote stream for participant', participantId);
      this.handlers.onRemoteStream?.(participantId, null);
      this.stopRemoteMonitor(participantId);
      return;
    }
    
    const audioTracks = stream.getAudioTracks();
    debugLog('=== REGISTERING REMOTE STREAM ===', participantId, {
      streamId: stream.id,
      audioTracksCount: audioTracks.length,
      videoTracksCount: stream.getVideoTracks().length,
      totalTracksCount: stream.getTracks().length,
    });
    
    // Aggressively ensure all audio tracks are enabled
    audioTracks.forEach((track, index) => {
      const initialState = {
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
        label: track.label,
      };
      
      // Force enable regardless of current state
      if (!track.enabled) {
        track.enabled = true;
        debugLog(`[${index}] Force-enabled audio track for participant`, participantId, {
          trackId: track.id,
          before: initialState,
          after: {
            enabled: track.enabled,
            readyState: track.readyState,
            muted: track.muted,
          },
        });
      }
      
      // Add persistent listeners to keep track enabled
      const ensureEnabled = () => {
        if (!track.enabled && track.readyState !== 'ended') {
          track.enabled = true;
          debugLog(`[${index}] Re-enabled audio track via event listener`, participantId, {
            trackId: track.id,
            readyState: track.readyState,
            muted: track.muted,
          });
        }
      };
      
      // Listen to all events that might affect track state
      track.addEventListener('unmute', ensureEnabled);
      track.addEventListener('started', ensureEnabled);
      
      debugLog(`[${index}] Audio track fully registered for participant`, participantId, {
        trackId: track.id,
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
        label: track.label,
        settings: track.getSettings ? track.getSettings() : 'getSettings not available',
        constraints: track.getConstraints ? track.getConstraints() : 'getConstraints not available',
      });
    });
    
    const finalState = {
      audioTracks: audioTracks.length,
      videoTracks: stream.getVideoTracks().length,
      enabledAudioTracks: audioTracks.filter(t => t.enabled).length,
      mutedAudioTracks: audioTracks.filter(t => t.muted).length,
      liveAudioTracks: audioTracks.filter(t => t.readyState === 'live').length,
      endedAudioTracks: audioTracks.filter(t => t.readyState === 'ended').length,
      allTrackIds: stream.getTracks().map(t => ({ 
        id: t.id, 
        kind: t.kind, 
        enabled: t.enabled,
        readyState: t.readyState,
        muted: t.muted,
      })),
    };
    
    debugLog('=== STREAM REGISTRATION COMPLETE ===', participantId, finalState);
    
    // Always call handler to ensure UI updates - even if tracks are muted
    // The UI layer will handle muted state appropriately
    // Check WebRTC connection state before calling handler
    const peerEntry = entry;
    const pc = peerEntry?.pc;
    const connectionState = pc?.connectionState ?? 'unknown';
    const iceConnectionState = pc?.iceConnectionState ?? 'unknown';
    const iceGatheringState = pc?.iceGatheringState ?? 'unknown';
    const signalingState = pc?.signalingState ?? 'unknown';
    
    logger.warn('=== CALLING onRemoteStream HANDLER ===', {
      participantId,
      hasHandler: Boolean(this.handlers.onRemoteStream),
      streamId: stream.id,
      audioTracks: audioTracks.length,
      enabledAudioTracks: audioTracks.filter(t => t.enabled).length,
      liveAudioTracks: audioTracks.filter(t => t.readyState === 'live').length,
      webRTCState: {
        connectionState,
        iceConnectionState,
        iceGatheringState,
        signalingState,
        hasPeerConnection: pc !== undefined,
      },
    });
    
    // Warn if connection is not fully established
    if (iceConnectionState !== 'connected' && iceConnectionState !== 'completed') {
      logger.warn('WebRTC connection not fully established when stream received - will re-register when connected', {
        participantId,
        iceConnectionState,
        connectionState,
        streamId: stream.id,
        audioTracksCount: audioTracks.length,
        note: 'Stream will be re-registered automatically when connection is established',
      });
      // Don't call handler yet - wait for connection to be established
      // The stream will be re-registered in iceconnectionstatechange handler
      return;
    }
    
    // Connection is established - safe to register stream
    logger.warn('WebRTC connection established - registering stream', {
      participantId,
      iceConnectionState,
      connectionState,
      streamId: stream.id,
      audioTracksCount: audioTracks.length,
    });
    
    // Check WebRTC statistics to verify data transmission
    if (pc) {
      pc.getStats().then((stats) => {
        const statsArray = Array.from(stats.values());
        const inboundAudioStats = statsArray.filter((s: RTCStats) => 
          s.type === 'inbound-rtp' && (s as any).kind === 'audio'
        );
        const remoteOutboundAudioStats = statsArray.filter((s: RTCStats) => 
          s.type === 'remote-outbound-rtp' && (s as any).kind === 'audio'
        );
        const candidatePairs = statsArray.filter((s: RTCStats) => 
          s.type === 'candidate-pair' && (s as RTCIceCandidatePairStats).state === 'succeeded'
        );
        
        logger.warn('WebRTC statistics after connection established', {
          participantId,
          inboundAudioStats: inboundAudioStats.length,
          remoteOutboundAudioStats: remoteOutboundAudioStats.length,
          candidatePairs: candidatePairs.length,
          inboundStats: inboundAudioStats.map((s: any) => ({
            bytesReceived: s.bytesReceived,
            packetsReceived: s.packetsReceived,
            packetsLost: s.packetsLost,
            jitter: s.jitter,
            audioLevel: s.audioLevel,
            totalAudioEnergy: s.totalAudioEnergy,
            framesDecoded: s.framesDecoded,
            framesDropped: s.framesDropped,
            framesReceived: s.framesReceived,
            note: 'If audioLevel is 0, remote participant may not be speaking or microphone is muted',
          })),
          candidatePairInfo: candidatePairs.map((s: any) => ({
            localCandidateType: s.localCandidateType,
            remoteCandidateType: s.remoteCandidateType,
            bytesReceived: s.bytesReceived,
            bytesSent: s.bytesSent,
            packetsReceived: s.packetsReceived,
            packetsSent: s.packetsSent,
          })),
        });
      }).catch((error) => {
        logger.debug('Failed to get WebRTC statistics', {
          participantId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      
      // Check stats again after a delay to see if data starts flowing
      setTimeout(() => {
        pc.getStats().then((stats) => {
          const statsArray = Array.from(stats.values());
          const inboundAudioStats = statsArray.filter((s: RTCStats) => 
            s.type === 'inbound-rtp' && (s as any).kind === 'audio'
          );
          
          if (inboundAudioStats.length > 0) {
            const stats = inboundAudioStats[0] as any;
            logger.warn('WebRTC statistics check after delay', {
              participantId,
              bytesReceived: stats.bytesReceived,
              packetsReceived: stats.packetsReceived,
              packetsLost: stats.packetsLost,
              audioLevel: stats.audioLevel,
              totalAudioEnergy: stats.totalAudioEnergy,
              hasData: (stats.bytesReceived ?? 0) > 0 || (stats.packetsReceived ?? 0) > 0,
            });
          } else {
            logger.warn('No inbound audio stats found after delay', {
              participantId,
              note: 'Remote participant may not be sending audio',
            });
          }
        }).catch(() => {
          // ignore errors
        });
      }, 2000);
    }
    
    this.handlers.onRemoteStream?.(participantId, stream);
    this.startRemoteMonitor(participantId, stream);
    debugLog('=== onRemoteStream HANDLER CALLED AND MONITOR STARTED ===', participantId);
  }

  private removeRemoteStream(participantId: number): void {
    const entry = this.peers.get(participantId);
    if (entry) {
      entry.remoteStream = null;
    }
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
    this.clearPeerDisconnectTimer(entry);
    entry.receivedTracks.clear();
    entry.remoteStream = null;
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

  private schedulePeerDisconnect(remoteId: number, entry: PeerEntry): void {
    if (typeof window === 'undefined') {
      return;
    }
    if (entry.disconnectTimer !== null) {
      return;
    }
    entry.disconnectTimer = window.setTimeout(() => {
      entry.disconnectTimer = null;
      const current = this.peers.get(remoteId);
      if (!current) {
        return;
      }
      const state = current.pc.iceConnectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.closePeer(remoteId);
      }
    }, PEER_DISCONNECT_GRACE_PERIOD);
  }

  private clearPeerDisconnectTimer(entry: PeerEntry): void {
    if (typeof window === 'undefined') {
      entry.disconnectTimer = null;
      return;
    }
    if (entry.disconnectTimer !== null) {
      window.clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
    }
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
      logger.warn('Failed to send voice payload', undefined, error instanceof Error ? error : new Error(String(error)));
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
      const localTracks = this.localStream.getTracks();

      await Promise.all(
        senders.map(async (sender) => {
          const track = sender.track;
          if (!track) {
            return;
          }
          const replacement = localTracks.find((local) => local.id === track.id);
          if (replacement) {
            if (replacement !== track) {
              try {
                await sender.replaceTrack(replacement);
              } catch (error) {
                debugLog('Failed to replace track for sender', error);
              }
            }
          } else {
            try {
              pc.removeTrack(sender);
            } catch (error) {
              debugLog('Failed to remove sender', error);
            }
          }
        }),
      );

      for (const track of localTracks) {
        const hasSender = senders.some((sender) => sender.track?.id === track.id);
        if (!hasSender) {
          pc.addTrack(track, this.localStream);
        }
      }

      void this.applyScreenShareQualityToConnection(pc);
    }
    this.startLocalMonitor();
  }

  private getScreenShareBitrate(): number | undefined {
    switch (this.screenShareQuality) {
      case 'low':
        return 600_000;
      case 'medium':
        return 1_500_000;
      case 'high':
        return 3_000_000;
      default:
        return undefined;
    }
  }

  private isScreenShareTrack(track: MediaStreamTrack | null | undefined): boolean {
    if (!track || track.kind !== 'video') {
      return false;
    }
    const hint = track.contentHint?.toLowerCase();
    if (hint && (hint.includes('detail') || hint.includes('text'))) {
      return true;
    }
    const label = track.label.toLowerCase();
    return label.includes('screen') || label.includes('display') || label.includes('window');
  }

  private async applyScreenShareQualityToConnection(pc: RTCPeerConnection): Promise<void> {
    const bitrate = this.getScreenShareBitrate();
    const promises = pc
      .getSenders()
      .filter((sender) => this.isScreenShareTrack(sender.track))
      .map(async (sender) => {
        const parameters = sender.getParameters();
        const encodings = parameters.encodings && parameters.encodings.length
          ? parameters.encodings
          : [{}];
        if (bitrate) {
          encodings[0] = { ...encodings[0], maxBitrate: bitrate };
        } else if (encodings[0]?.maxBitrate) {
          encodings[0] = { ...encodings[0] };
          delete encodings[0].maxBitrate;
        }
        parameters.encodings = encodings;
        parameters.degradationPreference = parameters.degradationPreference ?? 'maintain-resolution';
        try {
          await sender.setParameters(parameters);
        } catch (error) {
          debugLog('Failed to apply screen share quality', error);
        }
      });
    await Promise.all(promises);
  }

  private async applyScreenShareQuality(): Promise<void> {
    await Promise.all(
      Array.from(this.peers.values()).map((entry) => this.applyScreenShareQualityToConnection(entry.pc)),
    );
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
