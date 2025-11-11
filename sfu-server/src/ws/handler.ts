import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { roomManager } from '../rooms/RoomManager';
import { Peer } from '../rooms/Peer';
import { config } from '../config';
import type {
  Transport,
  Producer,
  Consumer,
  RtpCapabilities,
  RtpParameters,
  DtlsParameters,
  IceCandidate,
} from 'mediasoup/node/lib/types';

interface WebSocketMessage {
  type: string;
  roomId?: string;
  peerId?: string;
  data?: any;
}

export function handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
  let currentRoom: any = null;
  let currentPeer: Peer | null = null;

  ws.on('message', async (message: Buffer) => {
    try {
      const msg: WebSocketMessage = JSON.parse(message.toString());

      switch (msg.type) {
        case 'join':
          await handleJoin(ws, msg, (room, peer) => {
            currentRoom = room;
            currentPeer = peer;
          });
          break;

        case 'getRouterRtpCapabilities':
          await handleGetRouterRtpCapabilities(ws, msg);
          break;

        case 'createWebRtcTransport':
          await handleCreateWebRtcTransport(ws, msg);
          break;

        case 'connectTransport':
          await handleConnectTransport(ws, msg);
          break;

        case 'produce':
          await handleProduce(ws, msg);
          break;

        case 'consume':
          await handleConsume(ws, msg);
          break;

        case 'resumeConsumer':
          await handleResumeConsumer(ws, msg);
          break;

        case 'closeProducer':
          await handleCloseProducer(ws, msg);
          break;

        case 'closeConsumer':
          await handleCloseConsumer(ws, msg);
          break;

        case 'leave':
          await handleLeave(ws, msg);
          currentRoom = null;
          currentPeer = null;
          break;

        default:
          sendError(ws, `Unknown message type: ${msg.type}`);
      }
    } catch (error: any) {
      console.error('[WebSocket] Error handling message:', error);
      sendError(ws, error.message || 'Internal server error');
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentPeer) {
      currentRoom.removePeer(currentPeer.getId());
    }
    console.log('[WebSocket] Connection closed');
  });

  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
  });
}

async function handleJoin(ws: WebSocket, msg: WebSocketMessage, setCurrent: (room: any, peer: Peer) => void): Promise<void> {
  if (!msg.roomId || !msg.peerId) {
    return sendError(ws, 'roomId and peerId are required');
  }

  const room = await roomManager.getOrCreateRoom(msg.roomId);
  const peer = new Peer(msg.peerId, room.getRouter());
  room.addPeer(msg.peerId, peer);

  setCurrent(room, peer);

  send(ws, {
    type: 'joined',
    roomId: msg.roomId,
    peerId: msg.peerId,
    rtpCapabilities: room.getRtpCapabilities(),
  });
}

async function handleGetRouterRtpCapabilities(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId) {
    return sendError(ws, 'roomId is required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  send(ws, {
    type: 'routerRtpCapabilities',
    rtpCapabilities: room.getRtpCapabilities(),
  });
}

async function handleCreateWebRtcTransport(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.direction) {
    return sendError(ws, 'roomId, peerId, and direction are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  const router = room.getRouter();
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: config.server.announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  if (msg.data.direction === 'send') {
    peer.setSendTransport(transport);
  } else {
    peer.setRecvTransport(transport);
  }

  transport.on('dtlsstatechange', (dtlsState: string) => {
    if (dtlsState === 'closed') {
      transport.close();
    }
  });

  transport.on('icestatechange', (iceState: string) => {
    console.log(`[Transport ${transport.id}] ICE state: ${iceState}`);
  });

  send(ws, {
    type: 'transportCreated',
    transportId: transport.id,
    direction: msg.data.direction,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  });
}

async function handleConnectTransport(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.transportId || !msg.data.dtlsParameters) {
    return sendError(ws, 'roomId, peerId, transportId, and dtlsParameters are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  const transport = msg.data.direction === 'send'
    ? peer.getSendTransport()
    : peer.getRecvTransport();

  if (!transport || transport.id !== msg.data.transportId) {
    return sendError(ws, 'Transport not found');
  }

  await transport.connect({ dtlsParameters: msg.data.dtlsParameters });

  send(ws, {
    type: 'transportConnected',
    transportId: transport.id,
  });
}

async function handleProduce(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.transportId || !msg.data.rtpParameters || !msg.data.kind) {
    return sendError(ws, 'roomId, peerId, transportId, rtpParameters, and kind are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  const transport = peer.getSendTransport();
  if (!transport || transport.id !== msg.data.transportId) {
    return sendError(ws, 'Send transport not found');
  }

  const producer = await transport.produce({
    kind: msg.data.kind,
    rtpParameters: msg.data.rtpParameters,
  });

  peer.addProducer(producer.id, producer);

  // Notify other peers about new producer
  const otherPeers = room.getPeers().filter(p => p.getId() !== msg.peerId);
  for (const otherPeer of otherPeers) {
    // This will be handled by client requesting consumers
  }

  send(ws, {
    type: 'produced',
    producerId: producer.id,
    kind: producer.kind,
  });
}

async function handleConsume(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.transportId || !msg.data.producerId || !msg.data.rtpCapabilities) {
    return sendError(ws, 'roomId, peerId, transportId, producerId, and rtpCapabilities are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  const transport = peer.getRecvTransport();
  if (!transport || transport.id !== msg.data.transportId) {
    return sendError(ws, 'Recv transport not found');
  }

  // Find producer from other peer
  let producer: Producer | null = null;
  for (const otherPeer of room.getPeers()) {
    const p = otherPeer.getProducer(msg.data.producerId);
    if (p) {
      producer = p;
      break;
    }
  }

  if (!producer) {
    return sendError(ws, 'Producer not found');
  }

  const router = room.getRouter();
  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: msg.data.rtpCapabilities })) {
    return sendError(ws, 'Cannot consume this producer');
  }

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: msg.data.rtpCapabilities,
  });

  peer.addConsumer(consumer.id, consumer);

  send(ws, {
    type: 'consumed',
    consumerId: consumer.id,
    producerId: producer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  });
}

async function handleResumeConsumer(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.consumerId) {
    return sendError(ws, 'roomId, peerId, and consumerId are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  const consumer = peer.getConsumer(msg.data.consumerId);
  if (!consumer) {
    return sendError(ws, 'Consumer not found');
  }

  await consumer.resume();

  send(ws, {
    type: 'consumerResumed',
    consumerId: consumer.id,
  });
}

async function handleCloseProducer(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.producerId) {
    return sendError(ws, 'roomId, peerId, and producerId are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  peer.removeProducer(msg.data.producerId);

  send(ws, {
    type: 'producerClosed',
    producerId: msg.data.producerId,
  });
}

async function handleCloseConsumer(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId || !msg.data?.consumerId) {
    return sendError(ws, 'roomId, peerId, and consumerId are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  const peer = room.getPeer(msg.peerId);
  if (!peer) {
    return sendError(ws, 'Peer not found');
  }

  peer.removeConsumer(msg.data.consumerId);

  send(ws, {
    type: 'consumerClosed',
    consumerId: msg.data.consumerId,
  });
}

async function handleLeave(ws: WebSocket, msg: WebSocketMessage): Promise<void> {
  if (!msg.roomId || !msg.peerId) {
    return sendError(ws, 'roomId and peerId are required');
  }

  const room = roomManager.getRoom(msg.roomId);
  if (!room) {
    return sendError(ws, 'Room not found');
  }

  room.removePeer(msg.peerId);

  send(ws, {
    type: 'left',
    roomId: msg.roomId,
    peerId: msg.peerId,
  });
}

function send(ws: WebSocket, data: any): void {
  ws.send(JSON.stringify(data));
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, {
    type: 'error',
    error: message,
  });
}

