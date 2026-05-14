// Socket.io event handlers for the mediasoup SFU. Wired per-connection from
// server.ts. All handlers gate on `socket.rooms.has(roomId)` so clients can't
// poke at routers for rooms they haven't joined.
import type { Server, Socket } from 'socket.io';
import type {
  DtlsParameters,
  MediaKind,
  RtpCapabilities,
  RtpParameters,
} from 'mediasoup/types';
import { getOrCreateRouter, getRouter, closeRouterIfEmpty } from './rooms.js';
import {
  closeSession,
  ensureSession,
  getSession,
  roomHasSessions,
  sessionsInRoom,
} from './session.js';
import { createWebRtcTransport, describeTransport } from './transport.js';

type Ack<T> = (response: { ok: true; data: T } | { ok: false; error: string }) => void;

function inRoom(socket: Socket, roomId: string): boolean {
  return typeof roomId === 'string' && roomId.length > 0 && socket.rooms.has(roomId);
}

export function registerSfuHandlers(io: Server, socket: Socket): void {
  socket.on(
    'sfu:get-rtp-capabilities',
    async (data: { roomId: string }, ack: Ack<{ rtpCapabilities: RtpCapabilities }>) => {
      try {
        if (!inRoom(socket, data?.roomId)) return ack({ ok: false, error: 'not in room' });
        const router = await getOrCreateRouter(data.roomId);
        ack({ ok: true, data: { rtpCapabilities: router.rtpCapabilities } });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  socket.on(
    'sfu:create-transport',
    async (
      data: { roomId: string; direction: 'send' | 'recv' },
      ack: Ack<ReturnType<typeof describeTransport>>,
    ) => {
      try {
        if (!inRoom(socket, data?.roomId)) return ack({ ok: false, error: 'not in room' });
        if (data.direction !== 'send' && data.direction !== 'recv') {
          return ack({ ok: false, error: 'bad direction' });
        }
        const router = await getOrCreateRouter(data.roomId);
        const transport = await createWebRtcTransport(router);
        const session = ensureSession(socket.id, data.roomId);
        if (data.direction === 'send') {
          session.sendTransport?.close();
          session.sendTransport = transport;
        } else {
          session.recvTransport?.close();
          session.recvTransport = transport;
        }
        ack({ ok: true, data: describeTransport(transport) });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  socket.on(
    'sfu:connect-transport',
    async (
      data: { transportId: string; dtlsParameters: DtlsParameters },
      ack: Ack<{ connected: true }>,
    ) => {
      try {
        const session = getSession(socket.id);
        if (!session) return ack({ ok: false, error: 'no session' });
        const transport =
          session.sendTransport?.id === data.transportId
            ? session.sendTransport
            : session.recvTransport?.id === data.transportId
              ? session.recvTransport
              : undefined;
        if (!transport) return ack({ ok: false, error: 'unknown transport' });
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        ack({ ok: true, data: { connected: true } });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  socket.on(
    'sfu:produce',
    async (
      data: { transportId: string; kind: MediaKind; rtpParameters: RtpParameters },
      ack: Ack<{ id: string }>,
    ) => {
      try {
        const session = getSession(socket.id);
        if (!session) return ack({ ok: false, error: 'no session' });
        if (session.sendTransport?.id !== data.transportId) {
          return ack({ ok: false, error: 'not a send transport' });
        }
        const producer = await session.sendTransport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });
        session.producers.set(producer.id, producer);
        producer.observer.once('close', () => {
          session.producers.delete(producer.id);
        });
        // Tell every other peer in the room about the new producer so they
        // can call sfu:consume for it.
        socket.to(session.roomId).emit('sfu:new-producer', {
          producerSocketId: socket.id,
          producerId: producer.id,
          kind: producer.kind,
        });
        ack({ ok: true, data: { id: producer.id } });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  socket.on(
    'sfu:consume',
    async (
      data: { roomId: string; producerId: string; rtpCapabilities: RtpCapabilities },
      ack: Ack<{
        id: string;
        producerId: string;
        kind: MediaKind;
        rtpParameters: RtpParameters;
      }>,
    ) => {
      try {
        if (!inRoom(socket, data?.roomId)) return ack({ ok: false, error: 'not in room' });
        const router = getRouter(data.roomId);
        if (!router) return ack({ ok: false, error: 'no router' });
        if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
          return ack({ ok: false, error: 'cannot consume' });
        }
        const session = getSession(socket.id);
        if (!session?.recvTransport) return ack({ ok: false, error: 'no recv transport' });
        const consumer = await session.recvTransport.consume({
          producerId: data.producerId,
          rtpCapabilities: data.rtpCapabilities,
          paused: true, // start paused; client resumes after binding
        });
        session.consumers.set(consumer.id, consumer);
        consumer.observer.once('close', () => {
          session.consumers.delete(consumer.id);
        });
        consumer.on('producerclose', () => {
          session.consumers.delete(consumer.id);
          socket.emit('sfu:consumer-closed', { consumerId: consumer.id });
        });
        ack({
          ok: true,
          data: {
            id: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  socket.on(
    'sfu:resume-consumer',
    async (data: { consumerId: string }, ack: Ack<{ resumed: true }>) => {
      try {
        const session = getSession(socket.id);
        const consumer = session?.consumers.get(data.consumerId);
        if (!consumer) return ack({ ok: false, error: 'unknown consumer' });
        await consumer.resume();
        ack({ ok: true, data: { resumed: true } });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  socket.on(
    'sfu:close-producer',
    async (data: { producerId: string }, ack: Ack<{ closed: true }>) => {
      try {
        const session = getSession(socket.id);
        const producer = session?.producers.get(data.producerId);
        if (!producer) return ack({ ok: false, error: 'unknown producer' });
        producer.close();
        socket.to(session!.roomId).emit('sfu:producer-closed', {
          producerSocketId: socket.id,
          producerId: data.producerId,
        });
        ack({ ok: true, data: { closed: true } });
      } catch (err) {
        ack({ ok: false, error: (err as Error).message });
      }
    },
  );

  // Allow a freshly-joined peer to discover all existing producers in the
  // room without waiting for someone to publish again.
  socket.on(
    'sfu:list-producers',
    (
      data: { roomId: string },
      ack: Ack<{ producers: Array<{ producerSocketId: string; producerId: string; kind: MediaKind }> }>,
    ) => {
      if (!inRoom(socket, data?.roomId)) return ack({ ok: false, error: 'not in room' });
      const producers: Array<{ producerSocketId: string; producerId: string; kind: MediaKind }> = [];
      for (const { socketId, session } of sessionsInRoom(data.roomId)) {
        if (socketId === socket.id) continue;
        for (const producer of session.producers.values()) {
          producers.push({
            producerSocketId: socketId,
            producerId: producer.id,
            kind: producer.kind,
          });
        }
      }
      ack({ ok: true, data: { producers } });
    },
  );

  socket.on('leave room', async (roomName: string) => {
    const session = getSession(socket.id);
    if (session?.roomId === roomName) {
      closeSession(socket.id);
      await closeRouterIfEmpty(roomName, () => !roomHasSessions(roomName));
    }
  });

  socket.on('disconnect', async () => {
    const session = getSession(socket.id);
    const roomId = session?.roomId;
    closeSession(socket.id);
    if (roomId) {
      await closeRouterIfEmpty(roomId, () => !roomHasSessions(roomId));
    }
  });
}
