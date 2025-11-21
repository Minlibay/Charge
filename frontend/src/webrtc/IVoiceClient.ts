import type { VoiceClientHandlers, VoiceClientConnectionState } from './VoiceClient';

export interface ConnectParams {
  localStream: MediaStream;
  muted: boolean;
  videoEnabled: boolean;
}

export interface IVoiceClient {
  setHandlers(handlers: VoiceClientHandlers): void;
  setToken(token: string): void;
  connect(params: ConnectParams): Promise<void>;
  retry(): Promise<void>;
  disconnect(): void;
  destroy(): void;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): void;
  setVideoEnabled(enabled: boolean): Promise<void>;
  setScreenShareQuality(quality: 'low' | 'medium' | 'high'): void;
  replaceLocalStream(stream: MediaStream, params: { muted: boolean; videoEnabled: boolean }): Promise<void>;
  getLocalStream(): MediaStream | null;
  setHandRaised(raised: boolean): void;
  setStageStatus(participantId: number, status: string): void;
}

