// Per-socket SFU session: tracks the send/recv WebRtcTransports the client
// has open against the room's Router, plus its Producers and the Consumers
// it has bound to other peers' Producers. Cleaned up on socket disconnect.
import type { Consumer, Producer, WebRtcTransport } from 'mediasoup/types';

export interface SfuSession {
  roomId: string;
  sendTransport?: WebRtcTransport;
  recvTransport?: WebRtcTransport;
  producers: Map<string, Producer>; // producer.id -> Producer
  consumers: Map<string, Consumer>; // consumer.id -> Consumer
}

const sessions = new Map<string, SfuSession>(); // socket.id -> session

export function getSession(socketId: string): SfuSession | undefined {
  return sessions.get(socketId);
}

export function ensureSession(socketId: string, roomId: string): SfuSession {
  const existing = sessions.get(socketId);
  if (existing) {
    if (existing.roomId !== roomId) {
      // Socket switched rooms — tear down old state before re-creating.
      closeSession(socketId);
    } else {
      return existing;
    }
  }
  const session: SfuSession = {
    roomId,
    producers: new Map(),
    consumers: new Map(),
  };
  sessions.set(socketId, session);
  return session;
}

export function closeSession(socketId: string): void {
  const session = sessions.get(socketId);
  if (!session) return;
  for (const consumer of session.consumers.values()) {
    try { consumer.close(); } catch { /* already closed */ }
  }
  for (const producer of session.producers.values()) {
    try { producer.close(); } catch { /* already closed */ }
  }
  try { session.sendTransport?.close(); } catch { /* already closed */ }
  try { session.recvTransport?.close(); } catch { /* already closed */ }
  sessions.delete(socketId);
}

export function sessionsInRoom(roomId: string): Array<{ socketId: string; session: SfuSession }> {
  const result: Array<{ socketId: string; session: SfuSession }> = [];
  for (const [socketId, session] of sessions) {
    if (session.roomId === roomId) result.push({ socketId, session });
  }
  return result;
}

export function roomHasSessions(roomId: string): boolean {
  for (const s of sessions.values()) {
    if (s.roomId === roomId) return true;
  }
  return false;
}
