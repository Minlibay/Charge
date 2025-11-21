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
  isInitializing: boolean; // Track if connection is being set up
  pendingSignals: Array<{ payload: SignalPayload; resolve: () => void }>; // Queue signals during initialization
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
    await this.publishLocalStream();
    // Only send if connected
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.localParticipant) {
      this.safeSend({ type: 'set-muted', muted });
    }
    await this.updateAudioActivity(this.localParticipant?.id ?? null, 0, false);
  }

  setDeafened(deafened: boolean): void {
    this.localDeafened = deafened;
    // Only send if connected
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.localParticipant) {
      this.safeSend({ type: 'set-deafened', deafened });
    }
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    this.localVideoEnabled = enabled;
    if (this.lastConnectParams) {
      this.lastConnectParams.videoEnabled = enabled;
    }
    this.applyLocalMediaState(this.localMuted, enabled);
    // Only send if connected
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.localParticipant) {
      this.safeSend({ type: 'media', videoEnabled: enabled });
    }
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
    // Only send if connected
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.localParticipant) {
      this.safeSend({ type: 'state', event: 'stage', action: 'hand', raised });
    }
  }

  setStageStatus(participantId: number, status: string): void {
    // Only send if connected
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.localParticipant) {
      this.safeSend({
        type: 'state',
        event: 'stage',
        action: 'set-status',
        target: participantId,
        status,
      });
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
        debugLog('New participant joined, creating peer connection', payload.user.id, {
          localParticipantId: this.localParticipant.id,
          remoteParticipantId: payload.user.id,
          existingPeers: Array.from(this.peers.keys()),
        });
        void this.ensurePeerConnection(payload.user.id);
      }
    } else if (payload.event === 'peer-left') {
      debugLog('Participant left, closing peer connection', payload.user.id);
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
        
        debugLog('Received participants snapshot, ensuring peer connections', {
          localParticipantId: this.localParticipant.id,
          remoteParticipantIds: remoteIds,
          existingPeerIds: Array.from(this.peers.keys()),
          totalParticipants: payload.participants.length,
        });
        
        // Create peer connections for all remote participants
        // Process sequentially with small delay to avoid simultaneous offer creation
        // This helps prevent offer collisions when multiple participants join at once
        const createConnectionsSequentially = async () => {
          for (let i = 0; i < remoteIds.length; i++) {
            const id = remoteIds[i];
            // Small delay between connections to stagger offer creation
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            await this.ensurePeerConnection(id);
          }
        };
        
        void createConnectionsSequentially();
        for (const peerId of this.peers.keys()) {
          if (!remoteIds.includes(peerId)) {
            debugLog('Closing peer connection for participant not in snapshot', peerId);
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
    
    // If connection is still initializing, queue the signal
    if (entry.isInitializing) {
      debugLog('Connection still initializing, queueing signal', from.id, {
        signalKind: payload.signal?.kind,
      });
      return new Promise<void>((resolve) => {
        entry.pendingSignals.push({ payload, resolve });
      });
    }
    
    const { pc } = entry;
    const signal = payload.signal ?? {};
    const kind = signal.kind;

    if (kind === 'offer' || kind === 'answer') {
      const description = signal.description as RTCSessionDescriptionInit | undefined;
      if (!description) {
        return;
      }
      // Improved offer collision detection for multiple peers scenario
      // When 3rd participant joins, multiple offers can arrive simultaneously
      // Offer collision occurs when we receive an offer while we're making our own offer
      const offerCollision =
        description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
      
      // Handle offer collision based on polite/impolite role
      if (offerCollision && description.type === 'offer') {
        if (entry.isPolite) {
          // We're polite - we should cancel our offer and accept the incoming offer
          // Reset ignoreOffer to allow processing the incoming offer
          debugLog('Offer collision detected - polite peer will accept incoming offer', from.id, {
            makingOffer: entry.makingOffer,
            signalingState: pc.signalingState,
            isPolite: entry.isPolite,
            note: 'Will cancel our offer and accept incoming offer',
          });
          entry.ignoreOffer = false;
          // Don't return - continue processing the incoming offer
          // The makingOffer flag will be reset when our offer creation completes
        } else {
          // We're impolite - we should continue with our offer and ignore the incoming one
          // BUT: if we haven't sent our offer yet, we should queue this offer to process after
          // This is important for multiple participants joining simultaneously
          debugLog('Offer collision detected - impolite peer will continue with own offer', from.id, {
            makingOffer: entry.makingOffer,
            signalingState: pc.signalingState,
            isPolite: entry.isPolite,
            note: 'Will continue with own offer, incoming offer will be queued if not sent yet',
          });
          
          // If we're still making offer (haven't sent it yet), we should ignore this offer
          // because we're impolite and will continue with our own offer
          // Once our offer is sent, we'll be in have-local-offer state and can't accept another offer
          if (entry.makingOffer) {
            debugLog('Ignoring incoming offer during own offer creation (impolite peer)', from.id);
            entry.ignoreOffer = true;
            return;
          } else if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-local-pranswer') {
            // We've already sent our offer and are waiting for answer
            // As impolite peer, we should ignore incoming offers
            debugLog('Ignoring incoming offer - already sent own offer (impolite peer)', from.id, {
              signalingState: pc.signalingState,
            });
            entry.ignoreOffer = true;
            return;
          } else {
            // We're in stable state but makingOffer was true (race condition)
            // This shouldn't happen, but if it does, process the offer normally
            debugLog('Processing offer despite collision flag (state is stable)', from.id, {
              signalingState: pc.signalingState,
              makingOffer: entry.makingOffer,
            });
            entry.ignoreOffer = false;
            // Continue processing
          }
        }
      }
      
      // Reset ignoreOffer if we're processing a valid offer and we're polite
      if (description.type === 'offer' && entry.ignoreOffer && entry.isPolite) {
        debugLog('Resetting ignoreOffer flag for polite peer', from.id);
        entry.ignoreOffer = false;
      }
      // Guard against duplicate or invalid SDP descriptions that can arrive from the signalling
      // server when multiple participants join at the same time. Applying the
      // same description twice or setting a description in wrong state causes 
      // `setRemoteDescription` to throw because the connection is already in a stable state, 
      // which surfaces as `InvalidStateError: Called in wrong state: stable`.
      
      // Check if we're trying to set a remote description when already in stable state
      if (pc.signalingState === 'stable' && pc.currentRemoteDescription) {
        const currentSdp = pc.currentRemoteDescription.sdp ?? '';
        const incomingSdp = description.sdp ?? '';
        
        // If it's the same SDP, ignore it
        if (currentSdp === incomingSdp && pc.currentRemoteDescription.type === description.type) {
          debugLog('Ignoring duplicate remote description for peer', from.id, {
            type: description.type,
          });
          entry.remoteDescriptionSet = true;
          return;
        }
        
        // If state is stable and we have a remote description, check if answer is valid
        if (description.type === 'answer') {
          // Special case: if we have a remote offer but state is stable,
          // it means the offer was set but state didn't transition properly
          // This can happen if setRemoteDescription failed silently or state changed
          const hasRemoteOffer = pc.currentRemoteDescription?.type === 'offer';
          const hasLocalOffer = pc.localDescription?.type === 'offer';
          const hasRemoteAnswer = pc.currentRemoteDescription?.type === 'answer';
          
          // If we already have a remote answer that matches, ignore duplicate
          if (hasRemoteAnswer) {
            const currentSdp = pc.currentRemoteDescription?.sdp ?? '';
            const incomingSdp = description.sdp ?? '';
            if (currentSdp === incomingSdp) {
              debugLog('Ignoring duplicate answer (same SDP, already set)', from.id);
              entry.remoteDescriptionSet = true;
              return;
            }
          }
          
          // If we have a remote offer but state is stable, we're in an invalid state
          // This should not happen - if we set a remote offer, state should be 'have-remote-offer'
          // The only way to be in stable with a remote offer is if:
          // 1. The offer was set but state didn't transition (bug in browser?)
          // 2. We're receiving a duplicate/late answer
          // In this case, we should NOT try to set the answer - it will fail
          if (hasRemoteOffer && !hasLocalOffer && pc.signalingState === 'stable') {
            // This is an invalid state - we can't set an answer when we're in stable with a remote offer
            // The connection might already be established with a different answer, or there's a state mismatch
            logger.warn('Cannot set remote answer - in stable state with remote offer (invalid state, connection may already be established)', {
              peerId: from.id,
              signalingState: pc.signalingState,
              currentRemoteType: pc.currentRemoteDescription?.type,
              hasLocalOffer,
              localDescriptionType: pc.localDescription?.type,
              note: 'This may indicate a state synchronization issue or duplicate answer',
            });
            entry.remoteDescriptionSet = true;
            // Don't try to set the description - it will fail with InvalidStateError
            return;
          }
          
          // If we have a local offer, we expect a remote answer
          // But if we're in stable state, the answer might have already been set
          if (hasLocalOffer && pc.signalingState === 'stable') {
            // We have a local offer and we're in stable state
            // This means we already have a remote answer, or the connection is established
            const currentSdp = pc.currentRemoteDescription?.sdp ?? '';
            const incomingSdp = description.sdp ?? '';
            
            // If SDPs match, it's a duplicate - ignore it
            if (currentSdp === incomingSdp && pc.currentRemoteDescription?.type === 'answer') {
              debugLog('Ignoring duplicate answer (same SDP, connection already established)', from.id);
              entry.remoteDescriptionSet = true;
              return;
            }
            
            // If SDPs differ, this might be a renegotiation or duplicate from a different negotiation
            // Log it but don't try to set it - the connection is already established
            logger.warn('Received answer in stable state with different SDP - connection may already be established', {
              peerId: from.id,
              signalingState: pc.signalingState,
              currentRemoteType: pc.currentRemoteDescription?.type,
              hasLocalOffer,
              localDescriptionType: pc.localDescription?.type,
              note: 'This may be a duplicate answer or renegotiation attempt',
            });
            entry.remoteDescriptionSet = true;
            return;
          }
          
          // If we don't have a local offer and we're in stable state, this answer is invalid
          if (!hasLocalOffer && !hasRemoteOffer && pc.signalingState === 'stable') {
            logger.warn('Received answer in stable state without local or remote offer - ignoring', {
              peerId: from.id,
              signalingState: pc.signalingState,
              currentRemoteType: pc.currentRemoteDescription?.type,
              note: 'Answer received without corresponding offer',
            });
            entry.remoteDescriptionSet = true;
            return;
          }
        }
        
        // For offers in stable state, we can proceed (this transitions to 'have-remote-offer')
        // But log it for debugging
        if (description.type === 'offer') {
          debugLog('Received new remote offer while in stable state, will replace existing remote description', {
            peerId: from.id,
            currentRemoteType: pc.currentRemoteDescription.type,
          });
        }
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
        
        try {
          await pc.setRemoteDescription(description);
          entry.remoteDescriptionSet = true;
        } catch (sdpError) {
          const errorMessage = sdpError instanceof Error ? sdpError.message : String(sdpError);
          const errorName = sdpError instanceof Error ? sdpError.name : '';
          
          // Handle InvalidStateError - trying to set description in wrong state
          // This should rarely happen now due to pre-checks above, but handle it gracefully
          if (errorName === 'InvalidStateError' || errorMessage.includes('wrong state') || errorMessage.includes('InvalidStateError')) {
            logger.warn('InvalidStateError when setting remote description (should have been prevented by pre-checks)', {
              peerId: from.id,
              signalingState: pc.signalingState,
              descriptionType: description.type,
              hasCurrentRemote: !!pc.currentRemoteDescription,
              currentRemoteType: pc.currentRemoteDescription?.type,
              hasLocalDescription: !!pc.localDescription,
              localDescriptionType: pc.localDescription?.type,
            }, sdpError instanceof Error ? sdpError : new Error(String(sdpError)));
            
            // If we're in stable state, the connection is likely already established
            // Mark as set and don't retry
            if (pc.signalingState === 'stable') {
              entry.remoteDescriptionSet = true;
              debugLog('Marked remote description as set despite InvalidStateError (connection already established)', from.id);
              // Don't continue processing - connection is already in stable state
              return;
            }
            
            // For other invalid states, this is unexpected - log and don't retry
            entry.remoteDescriptionSet = true;
            debugLog('InvalidStateError in non-stable state - marking as set and not retrying', from.id);
            return;
          }
          // Handle "Unsupported payload type" error specifically
          else if (errorMessage.includes('payload type') || errorMessage.includes('Unsupported')) {
            logger.warn('Unsupported payload type in SDP - attempting to filter codecs', { peerId: from.id }, sdpError instanceof Error ? sdpError : new Error(String(sdpError)));
            // Try to modify SDP to remove unsupported codecs
            try {
              const modifiedDescription = await this.filterUnsupportedCodecs(description);
              await pc.setRemoteDescription(modifiedDescription);
              entry.remoteDescriptionSet = true;
            } catch (filterError) {
              logger.error('Failed to set remote description even after filtering codecs', filterError instanceof Error ? filterError : new Error(String(filterError)), { peerId: from.id });
              this.handlers.onError?.('Unsupported payload type: unable to establish connection');
              return;
            }
          } else {
            throw sdpError;
          }
        }
        
        // Log codec information from SDP for debugging
        if (description.sdp) {
          const audioCodecs = this.extractCodecsFromSDP(description.sdp, 'audio');
          const videoCodecs = this.extractCodecsFromSDP(description.sdp, 'video');
          debugLog('SDP codec information (remote description)', from.id, {
            audioCodecs,
            videoCodecs,
            sdpType: description.type,
          });
        }
        
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
          // Verify we're in the correct state to create an answer
          if (pc.signalingState !== 'have-remote-offer' && pc.signalingState !== 'have-local-pranswer') {
            logger.warn('Cannot create answer - wrong signaling state', {
              peerId: from.id,
              signalingState: pc.signalingState,
              expectedState: 'have-remote-offer',
            });
            return;
          }
          
          debugLog('Creating answer for peer', from.id, {
            signalingState: pc.signalingState,
          });
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
          
          // Double-check state before setting local description
          // State might have changed between createAnswer and setLocalDescription
          if (pc.signalingState !== 'have-remote-offer' && pc.signalingState !== 'have-local-pranswer') {
            logger.warn('State changed during answer creation, skipping setLocalDescription', {
              peerId: from.id,
              signalingState: pc.signalingState,
              expectedState: 'have-remote-offer',
            });
            return;
          }
          
          await pc.setLocalDescription(answer);
          
          // Log codec information from answer SDP
          if (answer.sdp) {
            const audioCodecs = this.extractCodecsFromSDP(answer.sdp, 'audio');
            const videoCodecs = this.extractCodecsFromSDP(answer.sdp, 'video');
            debugLog('SDP codec information (answer)', from.id, {
              audioCodecs,
              videoCodecs,
              sdpType: answer.type,
            });
          }
          
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
      isInitializing: true,
      pendingSignals: [],
    };
    this.peers.set(remoteId, entry);

    await this.publishLocalStream(entry);

    pc.addEventListener('negotiationneeded', async () => {
      try {
        debugLog('Negotiation needed for peer', remoteId, {
          signalingState: pc.signalingState,
          localTracks: pc.getSenders().length,
        });
        
        // Don't create offer if we're already in have-remote-offer state
        // This can happen when we receive an offer while negotiationneeded fires
        if (pc.signalingState === 'have-remote-offer' || pc.signalingState === 'have-local-pranswer') {
          debugLog('Skipping offer creation - already have remote offer', remoteId, {
            signalingState: pc.signalingState,
          });
          return;
        }
        
        // Don't create offer if we're making one or not in stable state
        if (entry!.makingOffer || pc.signalingState !== 'stable') {
          debugLog('Skipping offer creation - already making offer or not stable', remoteId, {
            makingOffer: entry!.makingOffer,
            signalingState: pc.signalingState,
          });
          return;
        }
        
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
        
        // Double-check state before setting local description
        // State might have changed between createOffer and setLocalDescription
        if (pc.signalingState !== 'stable') {
          debugLog('State changed during offer creation, skipping setLocalDescription', remoteId, {
            signalingState: pc.signalingState,
          });
          entry!.makingOffer = false;
          return;
        }
        
        await pc.setLocalDescription(offer);
        
        // Log codec information from offer SDP
        if (offer.sdp) {
          const audioCodecs = this.extractCodecsFromSDP(offer.sdp, 'audio');
          const videoCodecs = this.extractCodecsFromSDP(offer.sdp, 'video');
          debugLog('SDP codec information (offer)', remoteId, {
            audioCodecs,
            videoCodecs,
            sdpType: offer.type,
          });
        }
        
        this.sendSignal('offer', { description: pc.localDescription });
        debugLog('Sent offer to peer', remoteId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        // If it's an InvalidStateError, the state might have changed
        // (e.g., we received an offer while creating our own)
        if (errorName === 'InvalidStateError' || errorMessage.includes('wrong state')) {
          logger.warn('Negotiation failed due to state change - connection may already be established', {
            peerId: remoteId,
            signalingState: pc.signalingState,
            error: errorMessage,
          });
        } else {
          logger.error('Negotiation failed for peer', error instanceof Error ? error : new Error(String(error)), { peerId: remoteId });
        }
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
        // This ensures audio tracks start receiving data and UI is updated
        if (entry!.remoteStream) {
          debugLog('Re-registering remote stream after connection established', remoteId, {
            streamId: entry!.remoteStream.id,
            audioTracks: entry!.remoteStream.getAudioTracks().length,
          });
          // Trigger stream update to ensure tracks are active
          updateStreamFromTracks();
          // Also re-register the stream to ensure handler is called
          this.registerRemoteStream(remoteId, entry!.remoteStream);
        }
        return;
      }
      if (state === 'disconnected') {
        logger.warn('Peer connection disconnected', { peerId: remoteId, connectionState });
        this.schedulePeerDisconnect(remoteId, entry!);
        return;
      }
      if (state === 'failed') {
        logger.warn('Peer connection failed, attempting to reconnect', { 
          peerId: remoteId, 
          state,
          connectionState,
          localCandidates: pc.localDescription?.sdp?.match(/a=candidate:/g)?.length ?? 0,
          remoteCandidates: pc.remoteDescription?.sdp?.match(/a=candidate:/g)?.length ?? 0,
        });
        this.clearPeerDisconnectTimer(entry!);
        
        // Attempt to reconnect: close old connection and create new one
        // Only if we still have local stream and participant info
        if (this.localStream && this.localParticipant) {
          const oldEntry = entry!;
          // Close old connection
          try {
            oldEntry.pc.close();
          } catch (error) {
            // ignore close errors
          }
          // Remove from peers map temporarily
          this.peers.delete(remoteId);
          // Clear remote stream
          this.removeRemoteStream(remoteId);
          
          // Attempt to recreate connection after a short delay
          setTimeout(() => {
            if (this.localStream && this.localParticipant) {
              debugLog('Attempting to reconnect to peer after failure', remoteId);
              void this.ensurePeerConnection(remoteId);
            }
          }, 1000);
        } else {
          // No local stream, just close the peer
          this.closePeer(remoteId);
        }
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
      
      // Check if we need to create a new stream
      // Only create new stream if tracks have actually changed
      const currentStream = entry!.remoteStream;
      const currentTrackIds = currentStream 
        ? new Set(currentStream.getTracks().map(t => t.id))
        : new Set<string>();
      const newTrackIds = new Set(activeTracks.map(t => t.id));
      
      // Check if track sets are different
      const tracksChanged = 
        currentTrackIds.size !== newTrackIds.size ||
        !Array.from(newTrackIds).every(id => currentTrackIds.has(id)) ||
        !Array.from(currentTrackIds).every(id => newTrackIds.has(id));
      
      // If tracks haven't changed and stream exists, just update track states
      if (!tracksChanged && currentStream) {
        debugLog('Tracks unchanged, updating existing stream track states', remoteId, {
          streamId: currentStream.id,
          trackCount: activeTracks.length,
        });
        
        // Ensure all audio tracks in existing stream are enabled
        const audioTracks = currentStream.getAudioTracks();
        audioTracks.forEach((track) => {
          if (!track.enabled) {
            track.enabled = true;
            debugLog('Re-enabled audio track in existing stream', remoteId, {
              trackId: track.id,
            });
          }
        });
        
        // Don't call registerRemoteStream again - stream reference hasn't changed
        return;
      }
      
      // Tracks have changed - create new stream
      const newStream = new MediaStream(activeTracks);
      
      debugLog('New MediaStream created (tracks changed)', remoteId, {
        streamId: newStream.id,
        previousStreamId: currentStream?.id,
        tracksInStream: newStream.getTracks().length,
        audioTracksInStream: newStream.getAudioTracks().length,
        tracksChanged,
        previousTrackIds: Array.from(currentTrackIds),
        newTrackIds: Array.from(newTrackIds),
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
      
      // Only register stream if it actually changed
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
      
      // Check receiver statistics to verify RTP data is being received (debug only)
      if (receiver && track.kind === 'audio') {
        // Check once after delay to see if data starts flowing
        setTimeout(() => {
          receiver.getStats().then((stats) => {
            const statsArray = Array.from(stats.values());
            const inboundRtpStats = statsArray.filter((s: RTCStats) => s.type === 'inbound-rtp');
            if (inboundRtpStats.length > 0) {
              const rtpStats = inboundRtpStats[0] as any;
              const hasData = (rtpStats.bytesReceived ?? 0) > 0 || (rtpStats.packetsReceived ?? 0) > 0;
              
              debugLog('Receiver statistics after delay', remoteId, {
                trackId: track.id,
                bytesReceived: rtpStats.bytesReceived,
                packetsReceived: rtpStats.packetsReceived,
                packetsLost: rtpStats.packetsLost,
                audioLevel: rtpStats.audioLevel,
                totalAudioEnergy: rtpStats.totalAudioEnergy,
                hasData,
                note: 'If audioLevel is 0, remote participant may not be speaking or microphone is muted.',
              });
              
              // If data is flowing but track is not receiving it, trigger stream update
              if (hasData && track.readyState === 'live' && rtpStats.audioLevel === 0 && rtpStats.totalAudioEnergy === 0) {
                debugLog('RTP data is flowing but no audio detected - triggering stream update', remoteId, {
                  trackId: track.id,
                  bytesReceived: rtpStats.bytesReceived,
                  packetsReceived: rtpStats.packetsReceived,
                });
                // Force track to be enabled
                track.enabled = true;
                // Trigger stream update to ensure track is properly connected
                updateStreamFromTracks();
              }
            }
          }).catch(() => {
            // ignore errors
          });
        }, 2000);
      }
      
      // Immediately enable audio tracks
      if (track.kind === 'audio') {
        track.enabled = true;
        
        // CRITICAL: Verify track is properly connected to receiver
        // Sometimes the track may not be producing audio even if RTP data is flowing
        // This can happen if the track is not properly associated with the receiver
        debugLog('Enabling audio track and verifying receiver connection', remoteId, {
          trackId: track.id,
          trackEnabled: track.enabled,
          trackMuted: track.muted,
          trackReadyState: track.readyState,
          hasReceiver: receiver !== undefined,
          receiverId: receiver?.track?.id,
          receiverTrackMatches: receiver?.track?.id === track.id,
        });
        
        // Force track to be enabled and verify it's connected to receiver
        if (receiver && receiver.track && receiver.track.id !== track.id) {
          logger.warn('Track ID mismatch between event track and receiver track', {
            participantId: remoteId,
            eventTrackId: track.id,
            receiverTrackId: receiver.track.id,
            note: 'This may indicate a track/receiver association issue',
          });
        }
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

    void this.applyScreenShareQualityToConnection(pc);

    // Mark connection as ready and process any pending signals
    entry.isInitializing = false;
    const pendingSignals = entry.pendingSignals.splice(0);
    debugLog('Connection initialized, processing pending signals', remoteId, {
      pendingCount: pendingSignals.length,
      signalKinds: pendingSignals.map(s => s.payload.signal?.kind),
    });
    
    // Process pending signals sequentially with small delays to avoid race conditions
    // This is especially important when multiple participants join simultaneously
    const processPendingSignals = async () => {
      for (let i = 0; i < pendingSignals.length; i++) {
        const { payload, resolve } = pendingSignals[i];
        // Small delay between signals to allow state to stabilize
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        try {
          await this.handleSignalPayload(payload);
          resolve();
        } catch (error) {
          logger.warn('Failed to process pending signal', {
            peerId: remoteId,
            signalKind: payload.signal?.kind,
          }, error instanceof Error ? error : new Error(String(error)));
          resolve();
        }
      }
    };
    
    void processPendingSignals();

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
    
    debugLog('=== CALLING onRemoteStream HANDLER ===', participantId, {
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
    
    // Always register stream immediately to ensure UI is updated
    // The stream will be re-registered when connection is fully established
    if (iceConnectionState !== 'connected' && iceConnectionState !== 'completed') {
      debugLog('WebRTC connection not fully established when stream received - registering anyway, will re-register when connected', participantId, {
        iceConnectionState,
        connectionState,
        streamId: stream.id,
        audioTracksCount: audioTracks.length,
        note: 'Stream registered immediately, will be re-registered when connection is established',
      });
    } else {
      debugLog('WebRTC connection established - registering stream', participantId, {
        iceConnectionState,
        connectionState,
        streamId: stream.id,
        audioTracksCount: audioTracks.length,
      });
    }
    
    // Check WebRTC statistics to verify data transmission (debug only)
    if (pc) {
      // Check stats once after a delay to see if data starts flowing
      setTimeout(() => {
        pc.getStats().then((stats) => {
          const statsArray = Array.from(stats.values());
          const inboundAudioStats = statsArray.filter((s: RTCStats) => 
            s.type === 'inbound-rtp' && (s as any).kind === 'audio'
          );
          
          if (inboundAudioStats.length > 0) {
            const stats = inboundAudioStats[0] as any;
            debugLog('WebRTC statistics check after delay', participantId, {
              bytesReceived: stats.bytesReceived,
              packetsReceived: stats.packetsReceived,
              packetsLost: stats.packetsLost,
              audioLevel: stats.audioLevel,
              totalAudioEnergy: stats.totalAudioEnergy,
              hasData: (stats.bytesReceived ?? 0) > 0 || (stats.packetsReceived ?? 0) > 0,
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
    // Clear pending signals queue
    entry.pendingSignals = [];
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
      const shouldEnable = !muted;
      if (track.enabled !== shouldEnable && track.readyState !== 'ended') {
        track.enabled = shouldEnable;
      }
    }
    for (const track of this.localStream.getVideoTracks()) {
      track.enabled = videoEnabled;
    }
  }

  private async refreshLocalSenders(): Promise<void> {
    await this.publishLocalStream();
  }

  private async publishLocalStream(target?: PeerEntry): Promise<void> {
    if (!this.localStream) {
      return;
    }

    const targets = target ? [target] : Array.from(this.peers.values());

    for (const entry of targets) {
      await this.syncLocalSendersForPeer(entry);
      await this.applyScreenShareQualityToConnection(entry.pc);
    }

    this.startLocalMonitor();
  }

  private async syncLocalSendersForPeer(entry: PeerEntry): Promise<void> {
    if (!this.localStream) {
      return;
    }

    const pc = entry.pc;
    const senders = pc.getSenders();
    const localTracks = this.localStream.getTracks();

    await Promise.all(
      senders.map(async (sender) => {
        const track = sender.track;
        if (!track) {
          return;
        }

        const replacement =
          localTracks.find((local) => local.id === track.id) ||
          localTracks.find((local) => local.kind === track.kind && local.readyState === 'live');

        if (replacement) {
          const needsReplacement = replacement !== track || track.readyState === 'ended';
          if (needsReplacement) {
            try {
              await sender.replaceTrack(replacement);
            } catch (error) {
              debugLog('Failed to replace track for sender', error);
            }
          } else if (replacement.kind === 'audio' && !replacement.enabled && !this.localMuted) {
            replacement.enabled = true;
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
      const hasSender = pc.getSenders().some((sender) => sender.track?.id === track.id);
      if (!hasSender && track.readyState === 'live') {
        try {
          pc.addTrack(track, this.localStream);
        } catch (error) {
          if (error instanceof DOMException && error.name === 'InvalidAccessError') {
            debugLog('Track already has a sender for peer, skipping addTrack', entry.id, {
              trackId: track.id,
              senderCount: pc.getSenders().length,
            });
            continue;
          }
          throw error;
        }
      }
    }

    const finalSenders = pc.getSenders();
    const audioSenders = finalSenders.filter(sender => sender.track?.kind === 'audio').length;
    const videoSenders = finalSenders.filter(sender => sender.track?.kind === 'video').length;
    debugLog('Synced local senders for peer', entry.id, {
      totalSenders: finalSenders.length,
      audioSenders,
      videoSenders,
      localAudioTracks: this.localStream.getAudioTracks().length,
      localVideoTracks: this.localStream.getVideoTracks().length,
    });
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

  /**
   * Extract codec information from SDP string
   * Returns array of codec objects with payload type, name, and clock rate
   */
  private extractCodecsFromSDP(sdp: string, mediaType: 'audio' | 'video'): Array<{
    payloadType: string;
    name: string;
    clockRate?: string;
    channels?: string;
    fmtp?: string;
  }> {
    const codecs: Array<{
      payloadType: string;
      name: string;
      clockRate?: string;
      channels?: string;
      fmtp?: string;
    }> = [];
    
    // Find the media line for the specified type
    const mediaLineRegex = new RegExp(`m=${mediaType}\\s+(\\d+)\\s+([^\\s]+)\\s+([^\\r\\n]+)`, 'i');
    const mediaMatch = sdp.match(mediaLineRegex);
    
    if (!mediaMatch) {
      return codecs;
    }
    
    // Extract payload types from the media line
    const payloadTypes = mediaMatch[3].split(' ').filter(pt => pt.trim());
    
    // Find codec definitions (rtpmap lines)
    for (const payloadType of payloadTypes) {
      const rtpmapRegex = new RegExp(`a=rtpmap:${payloadType}\\s+([^/]+)(?:/(\\d+)(?:/(\\d+))?)?`, 'i');
      const rtpmapMatch = sdp.match(rtpmapRegex);
      
      if (rtpmapMatch) {
        const codecName = rtpmapMatch[1];
        const clockRate = rtpmapMatch[2];
        const channels = rtpmapMatch[3];
        
        // Find fmtp line if it exists
        const fmtpRegex = new RegExp(`a=fmtp:${payloadType}\\s+([^\\r\\n]+)`, 'i');
        const fmtpMatch = sdp.match(fmtpRegex);
        
        codecs.push({
          payloadType,
          name: codecName,
          clockRate,
          channels,
          fmtp: fmtpMatch ? fmtpMatch[1] : undefined,
        });
      } else {
        // Codec without rtpmap (shouldn't happen, but handle it)
        codecs.push({
          payloadType,
          name: 'unknown',
        });
      }
    }
    
    return codecs;
  }

  /**
   * Filter unsupported codecs from SDP to avoid "Unsupported payload type" errors
   * This method attempts to keep only commonly supported codecs (Opus for audio, VP8/VP9/H264 for video)
   */
  private async filterUnsupportedCodecs(description: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!description.sdp) {
      return description;
    }

    const sdp = description.sdp;
    const lines = sdp.split('\r\n');
    const filteredLines: string[] = [];
    let inAudioSection = false;
    let inVideoSection = false;
    const supportedAudioCodecs = ['opus', 'pcmu', 'pcma'];
    const supportedVideoCodecs = ['vp8', 'vp9', 'h264', 'av1'];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Detect media sections
      if (line.startsWith('m=audio')) {
        inAudioSection = true;
        inVideoSection = false;
        // Extract payload types from media line
        const parts = line.split(' ');
        if (parts.length >= 4) {
          const payloadTypes = parts.slice(3);
          // Keep the line but we'll filter rtpmap lines later
          filteredLines.push(line);
          continue;
        }
      } else if (line.startsWith('m=video')) {
        inAudioSection = false;
        inVideoSection = true;
        const parts = line.split(' ');
        if (parts.length >= 4) {
          filteredLines.push(line);
          continue;
        }
      } else if (line.startsWith('m=')) {
        inAudioSection = false;
        inVideoSection = false;
      }

      // Filter rtpmap lines for unsupported codecs
      if (line.startsWith('a=rtpmap:')) {
        const rtpmapMatch = line.match(/a=rtpmap:(\d+)\s+([^/\s]+)/i);
        if (rtpmapMatch) {
          const payloadType = rtpmapMatch[1];
          const codecName = rtpmapMatch[2].toLowerCase();
          
          let shouldKeep = true;
          if (inAudioSection) {
            shouldKeep = supportedAudioCodecs.some(c => codecName.includes(c));
          } else if (inVideoSection) {
            shouldKeep = supportedVideoCodecs.some(c => codecName.includes(c));
          }
          
          if (shouldKeep) {
            filteredLines.push(line);
            // Also keep associated fmtp line if it exists
            if (i + 1 < lines.length && lines[i + 1].startsWith(`a=fmtp:${payloadType}`)) {
              filteredLines.push(lines[i + 1]);
              i++; // Skip the fmtp line in next iteration
            }
          }
          continue;
        }
      }

      // Keep all other lines
      filteredLines.push(line);
    }

    const filteredSdp = filteredLines.join('\r\n');
    return {
      type: description.type,
      sdp: filteredSdp,
    };
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
