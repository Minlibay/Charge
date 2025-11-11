import { Router } from 'mediasoup';
import type { Transport, Producer, Consumer, RtpCapabilities } from 'mediasoup/node/lib/types';

export class Peer {
  private id: string;
  private router: Router;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producers: Map<string, Producer> = new Map();
  private consumers: Map<string, Consumer> = new Map();

  constructor(id: string, router: Router) {
    this.id = id;
    this.router = router;
  }

  getId(): string {
    return this.id;
  }

  setSendTransport(transport: Transport): void {
    this.sendTransport = transport;
  }

  setRecvTransport(transport: Transport): void {
    this.recvTransport = transport;
  }

  getSendTransport(): Transport | null {
    return this.sendTransport;
  }

  getRecvTransport(): Transport | null {
    return this.recvTransport;
  }

  addProducer(producerId: string, producer: Producer): void {
    this.producers.set(producerId, producer);
    console.log(`[Peer ${this.id}] Producer ${producerId} added. Total producers: ${this.producers.size}`);
  }

  removeProducer(producerId: string): void {
    const producer = this.producers.get(producerId);
    if (producer) {
      producer.close();
      this.producers.delete(producerId);
      console.log(`[Peer ${this.id}] Producer ${producerId} removed. Total producers: ${this.producers.size}`);
    }
  }

  getProducer(producerId: string): Producer | undefined {
    return this.producers.get(producerId);
  }

  getProducers(): Producer[] {
    return Array.from(this.producers.values());
  }

  addConsumer(consumerId: string, consumer: Consumer): void {
    this.consumers.set(consumerId, consumer);
    console.log(`[Peer ${this.id}] Consumer ${consumerId} added. Total consumers: ${this.consumers.size}`);
  }

  removeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer) {
      consumer.close();
      this.consumers.delete(consumerId);
      console.log(`[Peer ${this.id}] Consumer ${consumerId} removed. Total consumers: ${this.consumers.size}`);
    }
  }

  getConsumer(consumerId: string): Consumer | undefined {
    return this.consumers.get(consumerId);
  }

  getConsumers(): Consumer[] {
    return Array.from(this.consumers.values());
  }

  close(): void {
    // Close all consumers
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    // Close all producers
    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

    // Close transports
    if (this.sendTransport) {
      this.sendTransport.close();
      this.sendTransport = null;
    }
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = null;
    }

    console.log(`[Peer ${this.id}] Closed`);
  }
}

