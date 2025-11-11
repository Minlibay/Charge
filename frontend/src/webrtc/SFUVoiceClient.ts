import type {
  VoiceClientHandlers,
  VoiceClientConnectionState,
  VoiceParticipant,
  VoiceFeatureFlags,
  VoiceRoomStats,
  ScreenShareQuality,
} from '../types';
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

interface ProducerInfo {
  id: string;
  kind: 'audio' | 'video';
  track: MediaStreamTrack;
  producer: RTCRtpSender;
}

interface ConsumerInfo {
  id: string;
  participantId: number;
  kind: 'audio' | 'video';
  track: MediaStreamTrack;
  consumer: RTCRtpReceiver;
  stream: MediaStream;
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
  
  // WebRTC connection to SFU
  private pc: RTCPeerConnection | null = null;
  private sendTransport: RTCDtlsTransport | null = null;
  private recvTransport: RTCDtlsTransport | null = null;
  
  // Media
  private localStream: MediaStream | null = null;
  private localParticipant: VoiceParticipant | null = null;
  private localRole: string | null = null;
  private localFeatures: VoiceFeatureFlags | null = null;
  private localMuted = false;
  private localDeafened = false;
  private localVideoEnabled = false;
  private lastConnectParams: ConnectParams | null = null;
  
  // Producers and Consumers
  private producers = new Map<string, ProducerInfo>();
  private consumers = new Map<string, ConsumerInfo>();
  
  // Audio monitoring
  private localMonitor: AudioLevelMonitor | null = null;
  private remoteMonitors = new Map<number, AudioLevelMonitor>();
  private activityLevels = new Map<number, { level: number; speaking: boolean }>();
  
  // State
  private rtpCapabilities: RTCRtpCapabilities | null = null;
  private screenShareQuality: ScreenShareQuality = 'high';
  private keepAliveTimer: number | null = null;

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
    // Update producer tracks
    for (const producer of this.producers.values()) {
      if (producer.kind === 'audio') {
        producer.track.enabled = !muted;
      }
    }
    await this.updateAudioActivity(this.localParticipant?.id ?? null, 0, false);
  }

  setDeafened(deafened: boolean): void {
    this.localDeafened = deafened;
    // Mute all consumers when deafened
    for (const consumer of this.consumers.values()) {
      if (consumer.kind === 'audio') {
        consumer.track.enabled = !deafened;
      }
    }
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    this.localVideoEnabled = enabled;
    // Update video producer tracks
    for (const producer of this.producers.values()) {
      if (producer.kind === 'video') {
        producer.track.enabled = enabled;
      }
    }
  }

  setScreenShareQuality(quality: 'low' | 'medium' | 'high'): void {
    this.screenShareQuality = quality;
    // TODO: Implement quality adjustment for screen share
  }

  private async startConnection(): Promise<void> {
    if (!this.config) {
      throw new Error('SFU config not initialized');
    }

    return new Promise((resolve, reject) => {
      this.connectResolver = { resolve, reject };
      this.connectWebSocket();
    });
  }

  private connectWebSocket(): void {
    if (!this.config) {
      return;
    }

    try {
      const wsUrl = `${this.config.wsUrl}/ws`;
      this.ws = new WebSocket(wsUrl);

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
        }
      };

      this.ws.onerror = (error) => {
        logger.error('WebSocket error', error instanceof Error ? error : new Error(String(error)));
      };

      this.ws.onclose = () => {
        debugLog('[SFU] WebSocket closed');
        this.handleWebSocketClose();
      };
    } catch (error) {
      logger.error('Failed to connect WebSocket', error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    }
  }

  private async joinRoom(): Promise<void> {
    if (!this.ws || !this.localParticipant) {
      return;
    }

    this.sendWebSocketMessage({
      type: 'join',
      roomId: this.roomSlug,
      peerId: String(this.localParticipant.id),
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
      case 'error':
        logger.error('SFU error', new Error(message.error));
        this.handlers.onError?.(message.error);
        break;
      default:
        debugLog('[SFU] Unknown message type', message.type);
    }
  }

  private async handleJoined(message: any): Promise<void> {
    debugLog('[SFU] Joined room', message);
    this.rtpCapabilities = message.rtpCapabilities;
    
    // Request router RTP capabilities if not provided
    if (!this.rtpCapabilities) {
      this.sendWebSocketMessage({
        type: 'getRouterRtpCapabilities',
        roomId: this.roomSlug,
      });
    } else {
      await this.createTransports();
    }
  }

  private async handleRouterRtpCapabilities(message: any): Promise<void> {
    this.rtpCapabilities = message.rtpCapabilities;
    await this.createTransports();
  }

  private async createTransports(): Promise<void> {
    if (!this.rtpCapabilities) {
      return;
    }

    // Create send transport
    this.sendWebSocketMessage({
      type: 'createWebRtcTransport',
      roomId: this.roomSlug,
      peerId: String(this.localParticipant?.id),
      data: { direction: 'send' },
    });

    // Create recv transport
    this.sendWebSocketMessage({
      type: 'createWebRtcTransport',
      roomId: this.roomSlug,
      peerId: String(this.localParticipant?.id),
      data: { direction: 'recv' },
    });
  }

  private async handleTransportCreated(message: any): Promise<void> {
    const { transportId, direction, iceParameters, iceCandidates, dtlsParameters } = message;

    if (!this.config) {
      return;
    }

    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      iceTransportPolicy: 'all',
    });

    if (direction === 'send') {
      this.sendTransport = pc.sctp as any; // Type workaround
      // Store transport info for later connection
      (this as any).sendTransportInfo = { transportId, iceParameters, dtlsParameters };
    } else {
      this.recvTransport = pc.sctp as any; // Type workaround
      (this as any).recvTransportInfo = { transportId, iceParameters, dtlsParameters };
    }

    // Connect transport
    this.sendWebSocketMessage({
      type: 'connectTransport',
      roomId: this.roomSlug,
      peerId: String(this.localParticipant?.id),
      data: {
        transportId,
        direction,
        dtlsParameters,
      },
    });
  }

  private handleTransportConnected(message: any): void {
    debugLog('[SFU] Transport connected', message);
    
    // After both transports are connected, create producers
    if (this.sendTransport && this.recvTransport) {
      this.createProducers();
    }
  }

  private async createProducers(): Promise<void> {
    if (!this.localStream || !this.rtpCapabilities) {
      return;
    }

    // Create audio producer
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      await this.createProducer('audio', audioTrack);
    }

    // Create video producer if enabled
    if (this.localVideoEnabled) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        await this.createProducer('video', videoTrack);
      }
    }
  }

  private async createProducer(kind: 'audio' | 'video', track: MediaStreamTrack): Promise<void> {
    if (!this.pc || !this.rtpCapabilities) {
      return;
    }

    const sender = this.pc.addTrack(track, this.localStream!);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const rtpParameters = this.getRtpParameters(sender, kind);

    this.sendWebSocketMessage({
      type: 'produce',
      roomId: this.roomSlug,
      peerId: String(this.localParticipant?.id),
      data: {
        transportId: (this as any).sendTransportInfo?.transportId,
        kind,
        rtpParameters,
      },
    });
  }

  private getRtpParameters(sender: RTCRtpSender, kind: 'audio' | 'video'): RTCRtpSendParameters {
    // Get parameters from sender
    const params = sender.getParameters();
    return params as RTCRtpSendParameters;
  }

  private handleProduced(message: any): void {
    debugLog('[SFU] Producer created', message);
    // Producer is created, track is already added to PC
  }

  private async handleConsumed(message: any): Promise<void> {
    const { consumerId, producerId, kind, rtpParameters } = message;
    
    // Consumer track will be available via track event
    // For now, we'll need to handle it when track is received
    debugLog('[SFU] Consumer created', message);
  }

  private handleConsumerResumed(message: any): void {
    debugLog('[SFU] Consumer resumed', message);
  }

  private handleWebSocketClose(): void {
    this.cleanup();
    if (this.shouldReconnect && this.localStream) {
      this.scheduleReconnect();
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

  private cleanup(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // Close all producers
    for (const producer of this.producers.values()) {
      producer.track.stop();
    }
    this.producers.clear();

    // Close all consumers
    for (const consumer of this.consumers.values()) {
      consumer.track.stop();
    }
    this.consumers.clear();

    this.stopLocalMonitor();
    this.stopRemoteMonitors();
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
      this.localMonitor.dispose();
      this.localMonitor = null;
    }
  }

  private stopRemoteMonitors(): void {
    for (const monitor of this.remoteMonitors.values()) {
      monitor.dispose();
    }
    this.remoteMonitors.clear();
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
}

const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;

