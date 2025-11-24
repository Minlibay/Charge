import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { roomManager } from './rooms/RoomManager.js';
import { handleWebSocket } from './ws/handler.js';
import { closeWorkers } from './worker.js';

const app = express();

// Middleware
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Authentication middleware
const authenticateApi = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (apiKey !== config.api.key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// REST API endpoints
app.post('/api/rooms/:roomId', authenticateApi, async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await roomManager.createRoom(roomId);
    res.json({ success: true, room: room.getStats() });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/rooms/:roomId', authenticateApi, async (req, res) => {
  try {
    const { roomId } = req.params;
    await roomManager.deleteRoom(roomId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/rooms/:roomId', authenticateApi, (req, res) => {
  const { roomId } = req.params;
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({ success: true, room: room.getStats() });
});

app.get('/api/rooms', authenticateApi, (req, res) => {
  const rooms = roomManager.getRoomStats();
  res.json({ success: true, rooms, total: rooms.length });
});

// Start HTTP server
const httpServer = app.listen(config.server.port, config.server.host, () => {
  console.log(`[HTTP] Server listening on ${config.server.host}:${config.server.port}`);
});

// WebSocket server (shares HTTP listener on SFU_PORT for compatibility)
const wss = new WebSocketServer({
  host: config.server.host,
  port: config.ws.port,
  path: '/ws',
});

wss.on('listening', () => {
  console.log(`[WebSocket] Server listening on ${config.server.host}:${config.server.port}/ws`);
});

wss.on('connection', (ws, req) => {
  console.log('[WebSocket] New connection');
  handleWebSocket(ws, req);
});

const shutdown = (signal: string) => {
  console.log(`[Server] ${signal} received, shutting down gracefully...`);
  wss.close(() => console.log('[WebSocket] Server closed'));
  httpServer.close(() => {
    console.log('[HTTP] Server closed');
    closeWorkers();
    process.exit(0);
  });
};

// Graceful shutdown
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

