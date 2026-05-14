// One mediasoup Router per signaling room. Routers are cheap; we lazy-create
// on first request and tear down when the room empties (handled by the
// session cleanup path in index.ts).
import type { Router } from 'mediasoup/types';
import { getWorker } from './worker.js';
import { mediaCodecs } from './codecs.js';

const routers = new Map<string, Router>();
const pending = new Map<string, Promise<Router>>();

export async function getOrCreateRouter(roomId: string): Promise<Router> {
  const existing = routers.get(roomId);
  if (existing && !existing.closed) return existing;

  const inflight = pending.get(roomId);
  if (inflight) return inflight;

  const p = (async () => {
    const worker = await getWorker();
    const router = await worker.createRouter({ mediaCodecs });
    router.observer.once('close', () => {
      routers.delete(roomId);
    });
    routers.set(roomId, router);
    return router;
  })();

  pending.set(roomId, p);
  try {
    return await p;
  } finally {
    pending.delete(roomId);
  }
}

export function getRouter(roomId: string): Router | undefined {
  const r = routers.get(roomId);
  return r && !r.closed ? r : undefined;
}

export async function closeRouterIfEmpty(roomId: string, isEmpty: () => boolean): Promise<void> {
  const router = routers.get(roomId);
  if (!router || router.closed) return;
  if (!isEmpty()) return;
  await router.close();
}
