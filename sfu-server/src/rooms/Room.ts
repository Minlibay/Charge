import type { Router, Worker, RtpCapabilities, MediaKind, RtpParameters } from 'mediasoup/node/lib/types';
import { createWorker } from '../worker.js';
import { Peer } from './Peer.js';

export class Room {
  private id: string;
  private router: Router | null = null;
  private peers: Map<string, Peer> = new Map();
  private worker: Worker | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async initialize(): Promise<void> {
    // Get or create worker
    this.worker = await createWorker();

    // Create router
    this.router = await this.worker.createRouter({
      mediaCodecs: [
        {
          kind: 'audio' as MediaKind,
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
      ],
    });

    if (this.router) {
      console.log(`[Room ${this.id}] Router created with RTP capabilities:`, this.router.rtpCapabilities);
    }
  }

  getRouter(): Router {
    if (!this.router) {
      throw new Error('Room not initialized');
    }
    return this.router;
  }

  getRtpCapabilities(): RtpCapabilities {
    return this.getRouter().rtpCapabilities;
  }

  addPeer(peerId: string, peer: Peer): void {
    this.peers.set(peerId, peer);
    console.log(`[Room ${this.id}] Peer ${peerId} added. Total peers: ${this.peers.size}`);
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
      console.log(`[Room ${this.id}] Peer ${peerId} removed. Total peers: ${this.peers.size}`);
    }
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  getPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  getPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  async close(): Promise<void> {
    // Close all peers
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();

    // Close router
    if (this.router) {
      this.router.close();
      this.router = null;
    }

    console.log(`[Room ${this.id}] Closed`);
  }

  getId(): string {
    return this.id;
  }

  getStats(): {
    id: string;
    peersCount: number;
    peerIds: string[];
  } {
    return {
      id: this.id,
      peersCount: this.peers.size,
      peerIds: this.getPeerIds(),
    };
  }
}

