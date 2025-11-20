import * as mediasoup from 'mediasoup';
import type { Worker, WorkerSettings, WorkerLogLevel } from 'mediasoup/node/lib/types';
import { config } from './config.js';
import os from 'os';

let workers: Worker[] = [];
let currentWorkerIndex = 0;

export async function createWorker(): Promise<Worker> {
  const numWorkers = config.mediasoup.numWorkers || os.cpus().length;

  // Initialize workers if not already initialized
  if (workers.length === 0) {
    console.log(`[Worker] Creating ${numWorkers} Mediasoup workers...`);

    for (let i = 0; i < numWorkers; i++) {
      const workerSettings: WorkerSettings = {
        logLevel: config.mediasoup.workerLogLevel as WorkerLogLevel,
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort: config.rtc.minPort,
        rtcMaxPort: config.rtc.maxPort,
      };

      // Use custom worker binary if specified
      if (config.mediasoup.workerBin) {
        (workerSettings as any).workerBin = config.mediasoup.workerBin;
      }

      const worker = await mediasoup.createWorker(workerSettings);
      workers.push(worker);

      worker.on('died', () => {
        console.error(`[Worker ${worker.pid}] Died, exiting in 2 seconds...`);
        setTimeout(() => process.exit(1), 2000);
      });

      console.log(`[Worker ${worker.pid}] Created`);
    }
  }

  // Round-robin worker selection
  const worker = workers[currentWorkerIndex];
  currentWorkerIndex = (currentWorkerIndex + 1) % workers.length;

  return worker;
}

export function closeWorkers(): void {
  for (const worker of workers) {
    worker.close();
  }
  workers = [];
  currentWorkerIndex = 0;
}

