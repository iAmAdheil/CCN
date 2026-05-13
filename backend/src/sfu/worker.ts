// Singleton mediasoup Worker. A Worker is a separate C++ process; one worker
// can host many Routers. For a single-machine demo we run exactly one.
import * as mediasoup from 'mediasoup';
import type { Worker } from 'mediasoup/types';

let workerPromise: Promise<Worker> | null = null;

export function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  workerPromise = createWorker();
  return workerPromise;
}

async function createWorker(): Promise<Worker> {
  const rtcMinPort = Number(process.env.MEDIASOUP_MIN_PORT ?? 40000);
  const rtcMaxPort = Number(process.env.MEDIASOUP_MAX_PORT ?? 40100);
  const logLevel = (process.env.MEDIASOUP_LOG_LEVEL ?? 'warn') as 'debug' | 'warn' | 'error' | 'none';

  const worker = await mediasoup.createWorker({
    logLevel,
    rtcMinPort,
    rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('[mediasoup] worker died, exiting');
    process.exit(1);
  });

  console.log(`[mediasoup] worker pid=${worker.pid} ports=${rtcMinPort}-${rtcMaxPort}`);
  return worker;
}
