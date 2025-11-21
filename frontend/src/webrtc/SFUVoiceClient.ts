import * as mediasoupClient from 'mediasoup-client';
import type {
  VoiceParticipant,
  VoiceFeatureFlags,
  VoiceRoomStats,
  ScreenShareQuality,
} from '../types';
import type { VoiceClientHandlers, VoiceClientConnectionState } from './VoiceClient';
import { logger } from '../services/logger';
import type { IVoiceClient, ConnectParams } from './IVoiceClient';
import { AudioLevelMonitor } from './audioLevel';

const isDevelopment = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
const debugLog = (...args: unknown[]): void => {
  if (isDevelopment) {
    logger.debug(String(args[0]), args.length > 1 ? { args: args.slice(1) } : undefined);
  }
};

interface SFUConfig {
  serverUrl: string;
  wsUrl: string;
  iceServers: RTCIceServer[];
}

export class SFUVoiceClient implements IVoiceClient {
  private token: string;
  private roomSlug: string;
  private config: SFUConfig | null = null;
  private handlers: VoiceClientHandlers;
  private shouldReconnect: boolean;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectResolver: { resolve: () => void; reject: (error: Error) => void } | null = null;
  
  // WebSocket connection
  private ws: WebSocket | null = null;
  private lastWebSocketClose: CloseEvent | null = null;
  
  // Mediasoup components
  private device: mediasoupClient.types.Device | null = null;
  private sendTransport: mediasoupClient.types.Transport | null = null;
  private recvTransport: mediasoupClient.types.Transport | null = null;
  
  // Media
  private localStream: MediaStream | null = null;
  private localParticipant: VoiceParticipant | null = null;
  private userId: number | null = null;
  private localRole: string | null = null;
  private localFeatures: VoiceFeatureFlags | null = null;
  private localMuted = false;
  private localDeafened = false;
  private localVideoEnabled = false;
  private lastConnectParams: ConnectParams | null = null;
  
  // Producers and Consumers
  private producers = new Map<string, mediasoupClient.types.Producer>();
  private consumers = new Map<string, { consumer: mediasoupClient.types.Consumer; participantId: number; kind: string }>();
  private producerToParticipant = new Map<string, number>(); // Map producerId -> participantId
  
  // Audio monitoring
  private audioContext: AudioContext | null = null;
  private localMonitor: AudioLevelMonitor | null = null;
  private remoteMonitors = new Map<number, AudioLevelMonitor>();
  private activityLevels = new Map<number, { level: number; speaking: boolean }>();
  
  // State
  private rtpCapabilities: mediasoupClient.types.RtpCapabilities | null = null;
  private screenShareQuality: ScreenShareQuality = 'high';
  private keepAliveTimer: number | null = null;
  
  // Transport connect callbacks
  private transportConnectCallbacks = new Map<string, { callback: () => void; errback: (error: Error) => void }>();
  
  // Connection timeout
  private connectionTimeout: number | null = null;
  private readonly CONNECTION_TIMEOUT_MS = 30_000; // 30 seconds

  constructor(options: {
    roomSlug: string;
    sfuServerUrl: string;
    sfuWsUrl: string;
    token: string;
    iceServers: RTCIceServer[];
    reconnect?: boolean;
    handlers?: VoiceClientHandlers;
  }) {
    this.roomSlug = options.roomSlug;
    this.token = options.token;
    this.config = {
      serverUrl: options.sfuServerUrl,
      wsUrl: options.sfuWsUrl,
      iceServers: options.iceServers,
    };
    this.handlers = options.handlers ?? {};
    this.shouldReconnect = options.reconnect ?? true;
    this.userId = this.extractUserIdFromToken(options.token);
  }

  private extractUserIdFromToken(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }
      const payload = JSON.parse(atob(parts[1]));
      const subject = payload.sub || payload.user_id;
      if (typeof subject === 'number' && Number.isFinite(subject)) {
        return subject;
      }
      if (typeof subject === 'string') {
        const numeric = Number(subject);
        if (Number.isFinite(numeric)) {
          return numeric;
        }
      }
    } catch (error) {
      debugLog('[SFU] Failed to extract user ID from token', error);
    }
    return null;
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
    
    // Update all audio producers
    for (const producer of this.producers.values()) {
      if (producer.kind === 'audio') {
        producer.pause();
        if (!muted) {
          producer.resume();
        }
      }
    }
    
    // Update local stream tracks
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    
    await this.updateAudioActivity(this.localParticipant?.id ?? null, 0, false);
  }

  setDeafened(deafened: boolean): void {
    this.localDeafened = deafened;
    // Mute all consumers when deafened
    for (const { consumer } of this.consumers.values()) {
      if (consumer.kind === 'audio') {
        if (deafened) {
          consumer.pause();
        } else {
          consumer.resume();
        }
      }
    }
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    this.localVideoEnabled = enabled;
    
    // Update video producer tracks
    for (const producer of this.producers.values()) {
      if (producer.kind === 'video') {
        if (enabled) {
          producer.resume();
        } else {
          producer.pause();
        }
      }
    }
    
    // Update local stream tracks
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
  }

  setScreenShareQuality(quality: 'low' | 'medium' | 'high'): void {
    this.screenShareQuality = quality;
    // TODO: Implement quality adjustment for screen share
  }

  async replaceLocalStream(stream: MediaStream, params: { muted: boolean; videoEnabled: boolean }): Promise<void> {
    const previous = this.localStream;
    this.localStream = stream;
    this.lastConnectParams = { ...params, localStream: stream };
    this.localMuted = params.muted;
    this.localVideoEnabled = params.videoEnabled;

    stream.getAudioTracks().forEach((track) => {
      track.enabled = !params.muted;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = params.videoEnabled;
    });

    // Restart connection to apply new tracks
    if (this.sendTransport) {
      await this.retry();
    }

    previous?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (error) {
        // ignore
      }
    });
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  setHandRaised(raised: boolean): void {
    // TODO: Integrate with SFU signaling once supported
    debugLog('[SFU] setHandRaised', raised);
  }

  setStageStatus(participantId: number, status: string): void {
    // TODO: Integrate with SFU signaling once supported
    debugLog('[SFU] setStageStatus', participantId, status);
  }

  private async startConnection(): Promise<void> {
    if (!this.config) {
      throw new Error('SFU config not initialized');
    }

    return new Promise((resolve, reject) => {
      this.connectResolver = { resolve, reject };
      this.handlers.onConnectionStateChange?.('connecting');
      
      // Set connection timeout
      this.clearConnectionTimeout();
      this.connectionTimeout = window.setTimeout(() => {
        if (this.connectResolver) {
          const error = new Error('Connection timeout: failed to establish connection within 30 seconds');
          this.connectResolver.reject(error);
          this.connectResolver = null;
          this.handlers.onError?.(error.message);
          this.handlers.onConnectionStateChange?.('disconnected');
        }
      }, this.CONNECTION_TIMEOUT_MS);
      
      this.connectWebSocket();
    });
  }
  
  private clearConnectionTimeout(): void {
    if (this.connectionTimeout !== null) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  private connectWebSocket(): void {
    if (!this.config) {
      return;
    }

    // Clean up existing connection if any
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        // ignore
      }
      this.ws = null;
    }

    try {
      let wsUrl = this.config.wsUrl;
      try {
        const parsed = new URL(wsUrl);
        if (!parsed.pathname || parsed.pathname === '/') {
          parsed.pathname = '/ws';
        }
        wsUrl = parsed.toString();
      } catch (error) {
        debugLog('[SFU] Failed to parse wsUrl, falling back to raw string', error);
      }

      this.ws = new WebSocket(wsUrl);
      this.lastWebSocketClose = null;
      
      // Set up resolver if not already set (for reconnections)
      if (!this.connectResolver) {
        this.connectResolver = {
          resolve: () => {
            this.connectResolver = null;
          },
          reject: (error: Error) => {
            this.connectResolver = null;
            this.handlers.onError?.(error.message);
          },
        };
      }

      this.ws.onopen = () => {
        debugLog('[SFU] WebSocket connected');
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        this.joinRoom();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleWebSocketMessage(message);
        } catch (error) {
          logger.error('Failed to parse WebSocket message', error instanceof Error ? error : new Error(String(error)));
          this.connectResolver?.reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      this.ws.onerror = (event) => {
        const error = this.createWebSocketError(event, wsUrl);
        logger.error('WebSocket error', error, {
          type: event.type,
          readyState: this.formatReadyState((event.target as WebSocket | null)?.readyState),
          url: (event.target as WebSocket | null)?.url ?? wsUrl,
        });
        // Reject resolver if it exists
        if (this.connectResolver) {
          this.connectResolver.reject(error);
          this.connectResolver = null;
        }
        // Don't change state here - let onclose handle it
      };

      this.ws.onclose = (event) => {
        this.lastWebSocketClose = event;
        const readyState = this.formatReadyState((event.target as WebSocket | null)?.readyState);
        debugLog('[SFU] WebSocket closed', { code: event.code, reason: event.reason, readyState });
        this.handleWebSocketClose();
      };
    } catch (error) {
      logger.error('Failed to connect WebSocket', error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    }
  }

  private async joinRoom(): Promise<void> {
    if (!this.ws) {
      return;
    }

    const peerId = this.userId ?? this.localParticipant?.id;
    if (!peerId) {
      debugLog('[SFU] Cannot join room: no user ID available');
      return;
    }

    this.sendWebSocketMessage({
      type: 'join',
      roomId: this.roomSlug,
      peerId: String(peerId),
    });
  }

  private handleWebSocketMessage(message: any): void {
    debugLog('[SFU] Received message', message.type, message);

    switch (message.type) {
      case 'joined':
        this.handleJoined(message);
        break;
      case 'routerRtpCapabilities':
        this.handleRouterRtpCapabilities(message);
        break;
      case 'transportCreated':
        this.handleTransportCreated(message);
        break;
      case 'transportConnected':
        this.handleTransportConnected(message);
        break;
      case 'produced':
        this.handleProduced(message);
        break;
      case 'consumed':
        this.handleConsumed(message);
        break;
      case 'consumerResumed':
        this.handleConsumerResumed(message);
        break;
      case 'newProducer':
        this.handleNewProducer(message);
        break;
      case 'error':
        logger.error('SFU error', new Error(message.error));
        this.clearConnectionTimeout();
        if (this.connectResolver) {
          this.connectResolver.reject(new Error(message.error));
          this.connectResolver = null;
        }
        this.handlers.onError?.(message.error);
        this.handlers.onConnectionStateChange?.('disconnected');
        break;
      default:
        debugLog('[SFU] Unknown message type', message.type);
    }
  }

  private async handleJoined(message: any): Promise<void> {
    debugLog('[SFU] Joined room', message);
    this.rtpCapabilities = message.rtpCapabilities;
    
    if (!this.rtpCapabilities) {
      this.sendWebSocketMessage({
        type: 'getRouterRtpCapabilities',
        roomId: this.roomSlug,
      });
      return;
    }

    try {
      // Create mediasoup device
      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities: this.rtpCapabilities });
      debugLog('[SFU] Device loaded', this.device.rtpCapabilities);

      // Create transports
      await this.createTransports();

      // Store existing producers to consume after transports are ready
      if (message.existingProducers && Array.isArray(message.existingProducers) && message.existingProducers.length > 0) {
        debugLog('[SFU] Found existing producers, will create consumers after transports are ready', message.existingProducers);
        (this as any).pendingConsumers = message.existingProducers;
      }
    } catch (error) {
      logger.error('Failed to handle joined', error instanceof Error ? error : new Error(String(error)));
      this.clearConnectionTimeout();
      if (this.connectResolver) {
        this.connectResolver.reject(error instanceof Error ? error : new Error(String(error)));
        this.connectResolver = null;
      }
      this.handlers.onError?.(error instanceof Error ? error.message : String(error));
      this.handlers.onConnectionStateChange?.('disconnected');
    }
  }

  private async handleRouterRtpCapabilities(message: any): Promise<void> {
    this.rtpCapabilities = message.rtpCapabilities;
    try {
      if (!this.device) {
        this.device = new mediasoupClient.Device();
      }
      await this.device.load({ routerRtpCapabilities: this.rtpCapabilities });
      await this.createTransports();
    } catch (error) {
      logger.error('Failed to handle router RTP capabilities', error instanceof Error ? error : new Error(String(error)));
      this.clearConnectionTimeout();
      if (this.connectResolver) {
        this.connectResolver.reject(error instanceof Error ? error : new Error(String(error)));
        this.connectResolver = null;
      }
      this.handlers.onError?.(error instanceof Error ? error.message : String(error));
      this.handlers.onConnectionStateChange?.('disconnected');
    }
  }

  private async createTransports(): Promise<void> {
    if (!this.device || !this.config) {
      return;
    }

    const peerId = this.userId ?? this.localParticipant?.id;
    if (!peerId) {
      debugLog('[SFU] Cannot create transports: no user ID available');
      return;
    }

    // Create send transport
    this.sendWebSocketMessage({
      type: 'createWebRtcTransport',
      roomId: this.roomSlug,
      peerId: String(peerId),
      data: { direction: 'send' },
    });

    // Create recv transport
    this.sendWebSocketMessage({
      type: 'createWebRtcTransport',
      roomId: this.roomSlug,
      peerId: String(peerId),
      data: { direction: 'recv' },
    });
  }

  private async handleTransportCreated(message: any): Promise<void> {
    const { transportId, direction, iceParameters, iceCandidates, dtlsParameters } = message;

    if (!this.device || !this.config) {
      return;
    }

    try {
      const transportOptions: mediasoupClient.types.TransportOptions = {
        id: transportId,
        iceParameters,
        iceCandidates,
        dtlsParameters,
      };

      let transport: mediasoupClient.types.Transport;
      if (direction === 'send') {
        transport = this.device.createSendTransport(transportOptions);
        this.sendTransport = transport;
      } else {
        transport = this.device.createRecvTransport(transportOptions);
        this.recvTransport = transport;
      }

      // Set up transport event handlers
      // Note: In mediasoup-client, the 'connect' event is fired immediately when transport is created
      // We need to handle it and call callback/errback appropriately
      transport.on('connect', ({ dtlsParameters }: { dtlsParameters: mediasoupClient.types.DtlsParameters }, callback: () => void, errback: (error: Error) => void) => {
        debugLog(`[SFU] Transport ${direction} connect event triggered`);
        const peerId = this.userId ?? this.localParticipant?.id;
        if (!peerId) {
          errback(new Error('No user ID available'));
          return;
        }

        // Store callback to call after server confirms connection
        this.transportConnectCallbacks.set(transport.id, { callback, errback });

        // Send connect request to server
        this.sendWebSocketMessage({
          type: 'connectTransport',
          roomId: this.roomSlug,
          peerId: String(peerId),
          data: {
            transportId: transport.id,
            direction,
            dtlsParameters,
          },
        });

        // Call callback immediately - mediasoup-client expects callback to be called synchronously
        // The actual connection happens asynchronously, but we need to confirm to mediasoup
        // that we've initiated the connection process
        callback();
      });

      transport.on('connectionstatechange', (state: mediasoupClient.types.TransportConnectionState) => {
        debugLog(`[SFU] Transport ${direction} connection state:`, state);
        if (state === 'failed' || state === 'disconnected') {
          this.handlers.onError?.(`Transport ${direction} ${state}`);
        }
      });

      debugLog(`[SFU] Transport ${direction} created`, transportId);
    } catch (error) {
      logger.error(`Failed to create ${direction} transport`, error instanceof Error ? error : new Error(String(error)));
      this.clearConnectionTimeout();
      if (this.connectResolver) {
        this.connectResolver.reject(error instanceof Error ? error : new Error(String(error)));
        this.connectResolver = null;
      }
      this.handlers.onError?.(error instanceof Error ? error.message : String(error));
      this.handlers.onConnectionStateChange?.('disconnected');
    }
  }

  private async handleTransportConnected(message: any): Promise<void> {
    debugLog('[SFU] Transport connected (server confirmed)', message);
    
    const { transportId } = message;
    
    // Remove callback from map (already called during connect event)
    this.transportConnectCallbacks.delete(transportId);
    
    // Track connected transports
    if (!(this as any).connectedTransports) {
      (this as any).connectedTransports = new Set<string>();
    }
    (this as any).connectedTransports.add(transportId);
    
    // After both transports are connected, create producers and consumers
    const connectedTransports = (this as any).connectedTransports as Set<string>;
    if (this.sendTransport && this.recvTransport && 
        connectedTransports.has(this.sendTransport.id) && 
        connectedTransports.has(this.recvTransport.id)) {
      
      // Prevent duplicate initialization
      if ((this as any).producersCreated) {
        debugLog('[SFU] Producers already created, skipping');
        return;
      }
      (this as any).producersCreated = true;
      
      debugLog('[SFU] Both transports connected, creating producers');
      await this.createProducers();
      
      // Create consumers for existing producers
      const pendingConsumers = (this as any).pendingConsumers as Array<{ producerId: string; kind: string; peerId: string }> | undefined;
      if (pendingConsumers && pendingConsumers.length > 0) {
        debugLog('[SFU] Creating consumers for existing producers', pendingConsumers);
        for (const producerInfo of pendingConsumers) {
          await this.createConsumer(producerInfo.producerId, producerInfo.kind, producerInfo.peerId);
        }
        (this as any).pendingConsumers = undefined;
      }

      // Mark connection as complete
      debugLog('[SFU] Connection process complete');
      this.clearConnectionTimeout();
      this.handlers.onConnectionStateChange?.('connected');
      if (this.connectResolver) {
        this.connectResolver.resolve();
        this.connectResolver = null;
      }
    }
  }

  private async createProducers(): Promise<void> {
    if (!this.localStream || !this.sendTransport || !this.device) {
      debugLog('[SFU] Cannot create producers: missing requirements', {
        hasLocalStream: !!this.localStream,
        hasSendTransport: !!this.sendTransport,
        hasDevice: !!this.device,
      });
      return;
    }

    debugLog('[SFU] Creating producers', {
      hasAudio: this.localStream.getAudioTracks().length > 0,
      hasVideo: this.localStream.getVideoTracks().length > 0,
      videoEnabled: this.localVideoEnabled,
    });

    // Create audio producer
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      await this.createProducer('audio', audioTrack);
    } else {
      debugLog('[SFU] No audio track available for producer');
    }

    // Create video producer if enabled
    if (this.localVideoEnabled) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        await this.createProducer('video', videoTrack);
      } else {
        debugLog('[SFU] Video enabled but no video track available');
      }
    }
  }

  private async createProducer(kind: 'audio' | 'video', track: MediaStreamTrack): Promise<void> {
    if (!this.sendTransport || !this.device) {
      return;
    }

    try {
      const producer = await this.sendTransport.produce({
        track,
        codecOptions: kind === 'audio' ? {
          opusStereo: true,
          opusFec: true,
          opusDtx: true,
        } : undefined,
      });

      this.producers.set(producer.id, producer);
      debugLog(`[SFU] Producer created: ${producer.id} (${kind})`);

      // Set muted state
      if (kind === 'audio' && this.localMuted) {
        producer.pause();
      }
      if (kind === 'video' && !this.localVideoEnabled) {
        producer.pause();
      }

      // Monitor audio levels for local producer
      if (kind === 'audio') {
        this.startLocalMonitor(track);
      }

      // Notify server about producer
      const peerId = this.userId ?? this.localParticipant?.id;
      if (!peerId) {
        debugLog('[SFU] Cannot notify server about producer: no user ID available');
        return;
      }

      this.sendWebSocketMessage({
        type: 'produce',
        roomId: this.roomSlug,
        peerId: String(peerId),
        data: {
          transportId: this.sendTransport.id,
          kind,
          rtpParameters: producer.rtpParameters,
        },
      });
    } catch (error) {
      logger.error(`Failed to create ${kind} producer`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleProduced(message: any): void {
    debugLog('[SFU] Producer confirmed by server', message);
    // Producer is already created on client via transport.produce()
    // Server just confirms with producerId - we already have it from transport.produce()
    // No action needed, producer is already in this.producers map
  }

  private async createConsumer(producerId: string, kind: string, peerId: string): Promise<void> {
    if (!this.recvTransport || !this.device) {
      debugLog('[SFU] Cannot create consumer: transports not ready');
      return;
    }

    const participantId = parseInt(peerId, 10);
    if (isNaN(participantId)) {
      debugLog('[SFU] Invalid participant ID', peerId);
      return;
    }

    // Store mapping for when we receive consumer response
    this.producerToParticipant.set(producerId, participantId);

    try {
      const currentPeerId = this.userId ?? this.localParticipant?.id;
      if (!currentPeerId) {
        debugLog('[SFU] Cannot create consumer: no user ID available');
        return;
      }

      debugLog(`[SFU] Requesting consumer for producer ${producerId} (participant ${participantId}, kind ${kind})`);

      this.sendWebSocketMessage({
        type: 'consume',
        roomId: this.roomSlug,
        peerId: String(currentPeerId),
        data: {
          transportId: this.recvTransport.id,
          producerId,
          rtpCapabilities: this.device.rtpCapabilities,
        },
      });
    } catch (error) {
      logger.error('Failed to request consumer', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleConsumed(message: any): Promise<void> {
    const { consumerId, producerId, kind, rtpParameters } = message;
    
    if (!this.recvTransport || !this.device) {
      debugLog('[SFU] Cannot handle consumed: transports not ready');
      return;
    }

    try {
      // Get participantId from stored mapping (set when creating consumer)
      let finalParticipantId = this.producerToParticipant.get(producerId);
      
      // Fallback to peerId from message if not in mapping
      if (!finalParticipantId && message.peerId) {
        const peerIdNum = parseInt(message.peerId, 10);
        if (!isNaN(peerIdNum)) {
          finalParticipantId = peerIdNum;
          // Store for future reference
          this.producerToParticipant.set(producerId, finalParticipantId);
        }
      }
      
      if (!finalParticipantId) {
        debugLog('[SFU] Cannot find participant ID for producer', producerId, message);
        return;
      }

      // Create consumer
      const consumer = await this.recvTransport.consume({
        id: consumerId,
        producerId,
        kind,
        rtpParameters,
      });

      this.consumers.set(consumerId, { consumer, participantId: finalParticipantId, kind });
      debugLog(`[SFU] Consumer created: ${consumerId} for participant ${finalParticipantId} (${kind})`);

      // Get track from consumer
      const track = consumer.track;
      
      // Get or create stream for this participant
      // We need to handle multiple tracks (audio + video) for the same participant
      const existingStreams = Array.from(this.consumers.values())
        .filter(c => c.participantId === finalParticipantId && c.consumer.id !== consumerId)
        .map(c => {
          // Get track from existing consumer
          const existingTrack = c.consumer.track;
          if (existingTrack) {
            return existingTrack;
          }
          return null;
        })
        .filter((t): t is MediaStreamTrack => t !== null);
      
      // Combine with new track
      const allTracks = [...existingStreams, track];
      const stream = new MediaStream(allTracks);
      
      // Set muted state if deafened
      if (kind === 'audio' && this.localDeafened) {
        track.enabled = false;
      }

      // Notify handlers about new/updated remote stream
      this.handlers.onRemoteStream?.(finalParticipantId, stream);

      // Start monitoring audio levels for remote producer
      if (kind === 'audio' && track.kind === 'audio') {
        this.startRemoteMonitor(finalParticipantId, track);
      }

      // Resume consumer
      this.sendWebSocketMessage({
        type: 'resumeConsumer',
        roomId: this.roomSlug,
        peerId: String(this.userId ?? this.localParticipant?.id),
        data: { consumerId },
      });
    } catch (error) {
      logger.error('Failed to handle consumed', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleConsumerResumed(message: any): void {
    debugLog('[SFU] Consumer resumed', message);
  }

  private async handleNewProducer(message: any): Promise<void> {
    debugLog('[SFU] New producer notification', message);
    
    // When we receive notification about existing producers, create consumers
    if (message.existingProducers && Array.isArray(message.existingProducers) && this.recvTransport) {
      const peerId = this.userId ?? this.localParticipant?.id;
      if (!peerId || !this.device) {
        debugLog('[SFU] Cannot create consumers: missing peerId or device');
        return;
      }

      // Create consumers for all existing producers
      for (const producerInfo of message.existingProducers) {
        await this.createConsumer(producerInfo.producerId, producerInfo.kind, producerInfo.peerId);
      }
    }
    
    // Handle single new producer
    if (message.producer && this.recvTransport) {
      await this.createConsumer(message.producer.producerId, message.producer.kind, message.producer.peerId);
    }
  }

  private startLocalMonitor(track: MediaStreamTrack): void {
    if (!track || track.kind !== 'audio') {
      return;
    }
    
    if (this.localMonitor) {
      this.localMonitor.stop();
    }
    
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    
    const stream = new MediaStream([track]);
    this.localMonitor = new AudioLevelMonitor(this.audioContext, stream, (level) => {
      const speaking = level > 0.05; // Threshold for speaking detection
      this.updateAudioActivity(this.localParticipant?.id ?? null, level, speaking);
    });
    this.localMonitor.start();
  }

  private startRemoteMonitor(participantId: number, track: MediaStreamTrack): void {
    if (!track || track.kind !== 'audio') {
      return;
    }
    
    if (this.remoteMonitors.has(participantId)) {
      this.remoteMonitors.get(participantId)?.stop();
    }
    
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    
    const stream = new MediaStream([track]);
    const monitor = new AudioLevelMonitor(this.audioContext, stream, (level) => {
      const speaking = level > 0.05; // Threshold for speaking detection
      this.updateAudioActivity(participantId, level, speaking);
    });
    monitor.start();
    this.remoteMonitors.set(participantId, monitor);
  }

  private async updateAudioActivity(
    participantId: number | null,
    level: number,
    speaking: boolean,
  ): Promise<void> {
    if (participantId !== null) {
      this.activityLevels.set(participantId, { level, speaking });
      this.handlers.onAudioActivity?.(participantId, level, speaking);
    }
  }

  private handleWebSocketClose(): void {
    // Clear connection timeout
    this.clearConnectionTimeout();
    
    // Clear connection resolver if still pending
    if (this.connectResolver) {
      const error = new Error('WebSocket connection closed');
      this.connectResolver.reject(error);
      this.connectResolver = null;
    }
    
    // Reset connection state flags
    (this as any).producersCreated = false;
    (this as any).connectedTransports = new Set<string>();
    
    this.cleanup();
    if (this.shouldReconnect && this.localStream) {
      this.scheduleReconnect();
    } else {
      this.handlers.onConnectionStateChange?.('disconnected');
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      // Reset connection state before reconnecting
      this.handlers.onConnectionStateChange?.('connecting');
      // Reset producersCreated flag to allow re-initialization
      (this as any).producersCreated = false;
      (this as any).connectedTransports = new Set<string>();
      this.connectWebSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendWebSocketMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      logger.warn('[SFU] Cannot send message, WebSocket not open', message);
    }
  }

  private createWebSocketError(event: Event | Error, fallbackUrl: string): Error {
    if (event instanceof Error) {
      return event;
    }

    const target = event.target as WebSocket | null;
    const url = target?.url ?? fallbackUrl;
    const readyState = this.formatReadyState(target?.readyState);
    const reasonHint = this.describeCloseReason(url, target);

    return new Error(
      `WebSocket error: ${event.type} (url=${url}, readyState=${readyState}). ${reasonHint}`,
    );
  }

  private describeCloseReason(url: string, target: WebSocket | null): string {
    const isClosed = target?.readyState === WebSocket.CLOSED;
    const close = this.lastWebSocketClose;

    if (isClosed && close) {
      const codePart = close.code ? ` (code ${close.code})` : '';
      const reasonPart = close.reason ? ` Причина: ${close.reason}.` : '';

      if (close.code === 1006) {
        return `Соединение с ${url} не установлено${codePart}: сервер не отвечает, URL неверный или браузер отклонил TLS-сертификат.${reasonPart}`;
      }

      return `Соединение закрыто при установлении с ${url}${codePart}.${reasonPart}`.trim();
    }

    if (isClosed) {
      return `Соединение с ${url} не установлено: сервер недоступен, URL неверный или TLS-сертификат отклонён браузером.`;
    }

    return 'Ошибка WebSocket при установлении соединения.';
  }

  private formatReadyState(state?: number): string {
    switch (state) {
      case WebSocket.CONNECTING:
        return 'connecting (0)';
      case WebSocket.OPEN:
        return 'open (1)';
      case WebSocket.CLOSING:
        return 'closing (2)';
      case WebSocket.CLOSED:
        return 'closed (3)';
      default:
        return 'unknown';
    }
  }

  private cleanup(): void {
    // Clear connection timeout
    this.clearConnectionTimeout();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Close all producers
    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

    // Close all consumers
    for (const { consumer } of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();
    this.producerToParticipant.clear();

    // Close transports
    if (this.sendTransport) {
      this.sendTransport.close();
      this.sendTransport = null;
    }
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = null;
    }

    // Close device
    if (this.device) {
      this.device = null;
    }

    this.stopLocalMonitor();
    this.stopRemoteMonitors();
    this.cleanupAudioContext();
    
    // Clear transport callbacks
    this.transportConnectCallbacks.clear();
    
    // Reset connection state flags
    (this as any).producersCreated = false;
    (this as any).connectedTransports = new Set<string>();
    (this as any).pendingConsumers = undefined;
  }

  private stopLocalStream(): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
    }
  }

  private stopLocalMonitor(): void {
    if (this.localMonitor) {
      this.localMonitor.stop();
      this.localMonitor = null;
    }
  }

  private stopRemoteMonitors(): void {
    for (const monitor of this.remoteMonitors.values()) {
      monitor.stop();
    }
    this.remoteMonitors.clear();
  }
  
  private cleanupAudioContext(): void {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {
        // ignore close errors
      });
      this.audioContext = null;
    }
  }
}

const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
