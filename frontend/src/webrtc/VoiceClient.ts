import { AudioLevelMonitor } from './audioLevel';
import type {
  ScreenShareQuality,
  VoiceFeatureFlags,
  VoiceParticipant,
  VoiceQualityMetrics,
  VoiceRoomStats,
} from '../types';

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
    payload:
      | ParticipantsStatePayload
      | ParticipantUpdatePayload
      | RecordingPayload
      | QualityUpdatePayload,
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

    if (payload.event === 'quality-update') {
      const track = typeof payload.track === 'string' ? payload.track : 'audio';
      this.handlers.onQualityUpdate?.(payload.userId, track, payload.metrics);
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
      entry.remoteDescriptionSet = false;
      try {
        // Check what the remote description contains
        const remoteHasAudio = description.sdp?.includes('m=audio') ?? false;
        const remoteHasVideo = description.sdp?.includes('m=video') ?? false;
        console.debug('Setting remote description for peer', from.id, {
          type: description.type,
          remoteHasAudio,
          remoteHasVideo,
          sdpPreview: description.sdp?.substring(0, 200) + '...',
        });
        
        await pc.setRemoteDescription(description);
        entry.remoteDescriptionSet = true;
        console.debug('Remote description set for peer', from.id, {
          signalingState: pc.signalingState,
          connectionState: pc.connectionState,
        });
        if (entry.pendingCandidates.length) {
          const queued = entry.pendingCandidates.splice(0);
          console.debug('Flushing', queued.length, 'pending ICE candidates for peer', from.id);
          for (const candidate of queued) {
            try {
              await pc.addIceCandidate(candidate);
              console.debug('Added queued ICE candidate for peer', from.id, candidate?.type);
            } catch (error) {
              console.warn('Failed to flush pending ICE candidate for peer', from.id, error);
            }
          }
        }
        entry.ignoreOffer = false;
        if (description.type === 'offer') {
          console.debug('Creating answer for peer', from.id);
          const answer = await pc.createAnswer();
          // Check if SDP includes media tracks
          const hasAudio = answer.sdp?.includes('m=audio') ?? false;
          const hasVideo = answer.sdp?.includes('m=video') ?? false;
          console.debug('Created answer for peer', from.id, {
            type: answer.type,
            hasAudio,
            hasVideo,
            sdpPreview: answer.sdp?.substring(0, 200) + '...',
          });
          await pc.setLocalDescription(answer);
          this.sendSignal('answer', { description: pc.localDescription });
          console.debug('Sent answer to peer', from.id);
        }
      } catch (error) {
        console.warn('Failed to handle SDP description', error);
      }
      return;
    }

    if (kind === 'candidate') {
      const candidate = signal.candidate as RTCIceCandidateInit | undefined;
      
      // Accept all candidates (including relay/TURN) to allow connection establishment
      // P2P will be preferred, but TURN will be used as fallback if needed
      if (!entry.remoteDescriptionSet) {
        entry.pendingCandidates.push(candidate ?? null);
        console.debug('Queued ICE candidate for peer', from.id, 'waiting for remote description');
        return;
      }
      try {
        await pc.addIceCandidate(candidate ?? null);
        console.debug('Added ICE candidate for peer', from.id, candidate?.type);
      } catch (error) {
        if (!entry.ignoreOffer) {
          console.warn('Failed to add ICE candidate for peer', from.id, error);
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

    const type = (candidate as RTCIceCandidateInit).type ?? (candidate as RTCIceCandidate).type;
    if (typeof type === 'string' && type.toLowerCase() === 'relay') {
      return true;
    }

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
    // Use all ICE servers (including TURN as fallback) for P2P WebRTC
    // TURN will be used only if direct connection fails
    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 0,
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
    };
    this.peers.set(remoteId, entry);

    pc.addEventListener('negotiationneeded', async () => {
      try {
        console.debug('Negotiation needed for peer', remoteId, {
          signalingState: pc.signalingState,
          localTracks: pc.getSenders().length,
        });
        entry!.makingOffer = true;
        const offer = await pc.createOffer();
        // Check if SDP includes media tracks
        const hasAudio = offer.sdp?.includes('m=audio') ?? false;
        const hasVideo = offer.sdp?.includes('m=video') ?? false;
        console.debug('Created offer for peer', remoteId, {
          type: offer.type,
          hasAudio,
          hasVideo,
          sdpPreview: offer.sdp?.substring(0, 200) + '...',
        });
        await pc.setLocalDescription(offer);
        this.sendSignal('offer', { description: pc.localDescription });
        console.debug('Sent offer to peer', remoteId);
      } catch (error) {
        console.error('Negotiation failed for peer', remoteId, error);
      } finally {
        entry!.makingOffer = false;
      }
    });

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        // Log candidate type for debugging
        const candidateType = event.candidate.type;
        console.debug('ICE candidate generated for peer', remoteId, {
          type: candidateType,
          isRelay: this.isRelayCandidate(event.candidate),
        });
        
        // Send all candidates (including relay/TURN) to allow fallback
        // The receiving side can still filter if needed, but we send everything
        this.sendSignal('candidate', { candidate: event.candidate });
      } else {
        console.debug('ICE candidate gathering completed for peer', remoteId);
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      console.debug('ICE connection state changed for peer', remoteId, state);
      if (state === 'connected' || state === 'completed') {
        this.clearPeerDisconnectTimer(entry!);
        console.debug('Peer connection established', remoteId);
        return;
      }
      if (state === 'disconnected') {
        console.warn('Peer connection disconnected', remoteId);
        this.schedulePeerDisconnect(remoteId, entry!);
        return;
      }
      if (state === 'failed' || state === 'closed') {
        console.error('Peer connection failed or closed', remoteId, state);
        this.clearPeerDisconnectTimer(entry!);
        this.closePeer(remoteId);
      }
    });
    
    pc.addEventListener('connectionstatechange', () => {
      console.debug('Peer connection state changed for peer', remoteId, pc.connectionState);
    });

    pc.addEventListener('track', (event) => {
      console.debug('Track received from peer', remoteId, event.track.kind, event.track.id);
      let stream: MediaStream | null = null;
      
      if (event.streams && event.streams.length > 0) {
        // Use the stream from the event if available
        stream = event.streams[0];
      } else {
        // Create or update stream with the new track
        const current = entry!.remoteStream;
        if (current) {
          // Check if track already exists in current stream
          const existingTracks = current.getTracks();
          const hasTrack = existingTracks.some((track) => track.id === event.track.id);
          
          if (!hasTrack) {
            // Add new track to existing stream
            current.addTrack(event.track);
            stream = current;
          } else {
            // Track already exists, use current stream
            stream = current;
          }
        } else {
          // Create new stream with the track
          stream = new MediaStream([event.track]);
        }
      }
      
      if (stream) {
        // Ensure the stream is properly set
        entry!.remoteStream = stream;
        
        // Only register if this is a new stream or if tracks were added
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        console.debug('Stream tracks:', { audio: audioTracks.length, video: videoTracks.length });
        
        // Always register to ensure handlers are called
        this.registerRemoteStream(remoteId, stream);
      }
    });

    // Add all local tracks to the peer connection BEFORE any negotiation
    // This ensures tracks are included in the SDP offer/answer
    const audioTracks = this.localStream.getAudioTracks();
    const videoTracks = this.localStream.getVideoTracks();
    console.debug('Adding local tracks to peer connection', remoteId, {
      audio: audioTracks.length,
      video: videoTracks.length,
    });
    
    for (const track of this.localStream.getTracks()) {
      try {
        const sender = pc.addTrack(track, this.localStream);
        console.debug('Added local track to peer connection', remoteId, {
          kind: track.kind,
          trackId: track.id,
          enabled: track.enabled,
          senderId: sender.id,
        });
      } catch (error) {
        console.error('Failed to add local track to peer connection', remoteId, {
          kind: track.kind,
          trackId: track.id,
          error,
        });
      }
    }
    
    // Verify tracks were added
    const senders = pc.getSenders();
    console.debug('Peer connection senders after adding tracks', remoteId, {
      total: senders.length,
      audio: senders.filter(s => s.track?.kind === 'audio').length,
      video: senders.filter(s => s.track?.kind === 'video').length,
    });

    void this.applyScreenShareQualityToConnection(pc);

    return entry;
  }

  private registerRemoteStream(participantId: number, stream: MediaStream): void {
    const entry = this.peers.get(participantId);
    if (entry) {
      entry.remoteStream = stream;
    }
    
    // Ensure all tracks are enabled
    stream.getAudioTracks().forEach((track) => {
      if (track.readyState === 'live') {
        track.enabled = true;
      }
    });
    
    console.debug('Registering remote stream for participant', participantId, {
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
    });
    
    this.handlers.onRemoteStream?.(participantId, stream);
    this.startRemoteMonitor(participantId, stream);
    
    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        console.debug('Track ended for participant', participantId, track.kind, track.id);
        const peerEntry = this.peers.get(participantId);
        if (peerEntry?.remoteStream) {
          const remaining = peerEntry.remoteStream
            .getTracks()
            .filter((candidate) => candidate.id !== track.id);
          if (remaining.length > 0) {
            const nextStream = new MediaStream(remaining);
            peerEntry.remoteStream = nextStream;
            this.handlers.onRemoteStream?.(participantId, nextStream);
            this.startRemoteMonitor(participantId, nextStream);
            return;
          }
          peerEntry.remoteStream = null;
        }
        this.removeRemoteStream(participantId);
      }, { once: true });
      
      // Also handle track mute/unmute
      track.addEventListener('mute', () => {
        console.debug('Track muted for participant', participantId, track.kind);
      });
      
      track.addEventListener('unmute', () => {
        console.debug('Track unmuted for participant', participantId, track.kind);
      });
    });
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
    this.peers.delete(participantId);
    entry.remoteStream = null;
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
                console.debug('Failed to replace track for sender', error);
              }
            }
          } else {
            try {
              pc.removeTrack(sender);
            } catch (error) {
              console.debug('Failed to remove sender', error);
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
          console.debug('Failed to apply screen share quality', error);
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
