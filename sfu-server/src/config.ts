import dotenv from 'dotenv';

dotenv.config();

export const config = {
  mediasoup: {
    numWorkers: parseInt(process.env.MEDIASOUP_NUM_WORKERS || '2', 10),
    workerBin: process.env.MEDIASOUP_WORKER_BIN || '/usr/local/bin/mediasoup-worker',
    workerLogLevel: process.env.MEDIASOUP_WORKER_LOG_LEVEL || 'warn' as 'debug' | 'warn' | 'error' | 'none',
  },
  server: {
    host: process.env.SFU_HOST || '0.0.0.0',
    port: parseInt(process.env.SFU_PORT || '3000', 10),
    announcedIp: process.env.SFU_ANNOUNCED_IP || '127.0.0.1',
  },
  rtc: {
    minPort: parseInt(process.env.SFU_RTC_MIN_PORT || '40000', 10),
    maxPort: parseInt(process.env.SFU_RTC_MAX_PORT || '49999', 10),
  },
  ws: {
    port: parseInt(process.env.SFU_WS_PORT || '3001', 10),
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

