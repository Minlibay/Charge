import dotenv from 'dotenv';

dotenv.config();

const parsePort = (value: string | undefined, defaultPort: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return defaultPort;
  }
  return parsed;
};

const serverPort = parsePort(process.env.SFU_PORT, 3001);
const wsPort = parsePort(process.env.SFU_WS_PORT, serverPort);

export const config = {
  mediasoup: {
    numWorkers: parseInt(process.env.MEDIASOUP_NUM_WORKERS || '2', 10),
    // Don't specify workerBin - mediasoup will auto-detect it in node_modules
    // If MEDIASOUP_WORKER_BIN is set, use it; otherwise undefined (auto-detect)
    workerBin: process.env.MEDIASOUP_WORKER_BIN ? process.env.MEDIASOUP_WORKER_BIN : undefined,
    workerLogLevel: process.env.MEDIASOUP_WORKER_LOG_LEVEL || 'warn' as 'debug' | 'warn' | 'error' | 'none',
  },
  server: {
    host: process.env.SFU_HOST || '0.0.0.0',
    port: serverPort,
    announcedIp: process.env.SFU_ANNOUNCED_IP || '127.0.0.1',
  },
  rtc: {
    minPort: parseInt(process.env.SFU_RTC_MIN_PORT || '40000', 10),
    maxPort: parseInt(process.env.SFU_RTC_MAX_PORT || '49999', 10),
  },
  ws: {
    port: wsPort,
  },
  cors: {
    origin: (process.env.SFU_CORS_ORIGIN || 'http://localhost:80').split(','),
  },
  api: {
    key: process.env.SFU_API_KEY || 'default-key-change-in-production',
  },
  log: {
    level: process.env.SFU_LOG_LEVEL || 'info' as 'debug' | 'info' | 'warn' | 'error',
  },
};

