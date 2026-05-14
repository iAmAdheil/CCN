// Periodic sampler that updates room/SFU gauges. Runs every `intervalMs`,
// reads the in-memory state of room manager + SFU sessions, and publishes
// to the Prom registry. Bitrate is computed by diffing producer/consumer
// byte counters between samples.

import type { Server } from 'socket.io';
import { sessionsInRoom } from '../sfu/session.js';
import { currentMode } from '../rooms/manager.js';
import {
  gaugeConsumers,
  gaugePeers,
  gaugeProducers,
  gaugeRoomMode,
  gaugeRoomSize,
  gaugeRooms,
  gaugeRouters,
  gaugeSfuEgressBps,
  gaugeSfuIngressBps,
} from './metrics.js';

interface ByteSample {
  bytes: number;
  t: number;
}

let prevEgress: ByteSample | null = null;
let prevIngress: ByteSample | null = null;

// Across mediasoup's internal stat shapes the byte counters live under
// different field names depending on the worker version. We probe a
// handful so the metric stays accurate even if mediasoup tweaks the
// schema in a minor.
function readBytes(stat: unknown): number {
  if (!stat || typeof stat !== 'object') return 0;
  const obj = stat as Record<string, unknown>;
  const candidates = ['bytesSent', 'byteCount', 'rtpBytes', 'bytes'];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === 'number') return v;
  }
  return 0;
}

async function sampleSfuBytes(): Promise<{ egress: number; ingress: number; producers: number; consumers: number; routers: Set<string> }> {
  let egress = 0;
  let ingress = 0;
  let producers = 0;
  let consumers = 0;
  const routers = new Set<string>();

  // Walk every active session.
  for (const [, { session }] of allSessions().entries()) {
    routers.add(session.roomId);
    for (const producer of session.producers.values()) {
      producers++;
      try {
        const stats = await producer.getStats();
        for (const s of stats) ingress += readBytes(s);
      } catch {
        /* worker race; skip */
      }
    }
    for (const consumer of session.consumers.values()) {
      consumers++;
      try {
        const stats = await consumer.getStats();
        for (const s of stats) egress += readBytes(s);
      } catch {
        /* worker race; skip */
      }
    }
  }

  return { egress, ingress, producers, consumers, routers };
}

function allSessions(): Map<string, { session: ReturnType<typeof sessionsInRoom>[number]['session'] }> {
  // sessionsInRoom is per-room — we don't have a global "all sessions"
  // helper, so iterate across the rooms that currently host any session.
  // The session module's storage is module-private so we collect via a
  // best-effort scan over io.sockets if needed; for now we read from the
  // public `sessionsInRoom` indirection.
  // To avoid a dedicated cross-module API, we attach the info here by
  // walking via a side channel: the gauge exporter calls back into this
  // file with the active room set discovered through socket.io.
  return _allSessionsCache;
}

let _allSessionsCache: Map<string, { session: ReturnType<typeof sessionsInRoom>[number]['session'] }> = new Map();

function refreshAllSessionsCache(io: Server): void {
  _allSessionsCache = new Map();
  const allRooms = io.of('/').adapter.rooms;
  for (const [roomName] of allRooms) {
    if (io.of('/').sockets.has(roomName)) continue;
    for (const { socketId, session } of sessionsInRoom(roomName)) {
      _allSessionsCache.set(socketId, { session });
    }
  }
}

export function startMetricsSampler(io: Server, intervalMs = 5000): () => void {
  const tick = async () => {
    try {
      // Room state.
      const allRooms = io.of('/').adapter.rooms;
      let roomCount = 0;
      gaugeRoomSize.reset();
      gaugeRoomMode.reset();
      for (const [roomName, sockets] of allRooms) {
        if (io.of('/').sockets.has(roomName)) continue;
        roomCount++;
        gaugeRoomSize.set({ room: roomName }, sockets.size);
        const mode = currentMode(roomName);
        gaugeRoomMode.set({ room: roomName, mode: 'mesh' }, mode === 'mesh' ? 1 : 0);
        gaugeRoomMode.set({ room: roomName, mode: 'sfu' }, mode === 'sfu' ? 1 : 0);
      }
      gaugeRooms.set(roomCount);
      gaugePeers.set(io.of('/').sockets.size);

      // SFU byte counters → bitrate.
      refreshAllSessionsCache(io);
      const { egress, ingress, producers, consumers, routers } = await sampleSfuBytes();
      gaugeProducers.set(producers);
      gaugeConsumers.set(consumers);
      gaugeRouters.set(routers.size);
      const now = Date.now();
      if (prevEgress) {
        const dt = (now - prevEgress.t) / 1000;
        if (dt > 0) gaugeSfuEgressBps.set(Math.max(0, ((egress - prevEgress.bytes) * 8) / dt));
      }
      if (prevIngress) {
        const dt = (now - prevIngress.t) / 1000;
        if (dt > 0) gaugeSfuIngressBps.set(Math.max(0, ((ingress - prevIngress.bytes) * 8) / dt));
      }
      prevEgress = { bytes: egress, t: now };
      prevIngress = { bytes: ingress, t: now };
    } catch (err) {
      // Sampling shouldn't crash the process; log and continue.
      console.warn('[metrics] sampler tick failed:', err);
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(handle);
}
