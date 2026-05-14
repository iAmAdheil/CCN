// Per-connection WebRTC signaling: join/leave room, offer/answer/candidate
// relay, media-state changes, presence broadcasts. Pure courier — never
// touches media bytes.

import type { Server, Socket } from 'socket.io';
import {
  checkRoomPassword,
  gcRoomPassword,
  getAllRooms,
  reconcileMode,
  roomSize,
  setRoomPassword,
  type RoomUser,
} from '../rooms/manager.js';
import {
  AnswerPayload,
  CandidatePayload,
  CreateRoomPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  MediaStateChangePayload,
  OfferPayload,
} from '../validate/socket.js';
import { counterSocketEvents } from '../observability/metrics.js';

interface MediaState {
  videoEnabled: boolean;
  audioEnabled: boolean;
}

async function emitRoomRoster(io: Server, socket: Socket, roomName: string): Promise<void> {
  const mediaState = (socket.data as { mediaState: MediaState }).mediaState;
  const newUser: RoomUser = {
    id: socket.id,
    username: socket.handshake.auth.username,
    isVideoEnabled: mediaState?.videoEnabled ?? true,
    isAudioEnabled: mediaState?.audioEnabled ?? true,
  };
  io.to(roomName).except(socket.id).emit('add new room user', JSON.stringify(newUser));

  const clientIDs = io.sockets.adapter.rooms.get(roomName) || new Set();
  const peers: RoomUser[] = [];
  for (const clientID of clientIDs) {
    if (clientID === socket.id) continue;
    const s = io.sockets.sockets.get(clientID);
    if (!s) continue;
    const peerMedia = (s.data as { mediaState?: MediaState }).mediaState;
    peers.push({
      id: clientID,
      username: s.handshake.auth.username,
      isVideoEnabled: peerMedia?.videoEnabled ?? true,
      isAudioEnabled: peerMedia?.audioEnabled ?? true,
    });
  }
  socket.emit('fetch room users', JSON.stringify(peers));
}

export function registerRoomHandlers(io: Server, socket: Socket): void {
  // Initialize per-socket media state. Mutated via media-state-change.
  (socket.data as { mediaState?: MediaState }).mediaState = {
    videoEnabled: true,
    audioEnabled: true,
  };

  // join room — accepts either a bare string (legacy guest path) or a
  // { roomName, password? } object. Password-protected rooms reject the
  // join with `join room error` if the password is missing or wrong.
  socket.on('join room', async (raw: unknown) => {
    counterSocketEvents.inc({ event: 'join_room' });
    const parsed = JoinRoomPayload.safeParse(raw);
    if (!parsed.success) return;
    const roomName = typeof parsed.data === 'string' ? parsed.data : parsed.data.roomName;
    const password = typeof parsed.data === 'string' ? undefined : parsed.data.password;

    if (!checkRoomPassword(roomName, password)) {
      socket.emit('join room error', { message: 'Incorrect password' });
      return;
    }

    await socket.join(roomName);
    const mode = reconcileMode(roomName);
    socket.emit('room-mode', { roomName, mode, size: roomSize(roomName) });
    const rooms = await getAllRooms();
    io.except(roomName).emit('fetch active rooms', JSON.stringify(rooms));

    await emitRoomRoster(io, socket, roomName);
  });

  // create room — same as join, but the creator can set a password that
  // future joiners must present. The password lives in memory and is
  // garbage-collected when the room empties.
  socket.on('create room', async (raw: unknown) => {
    const parsed = CreateRoomPayload.safeParse(raw);
    if (!parsed.success) return;
    const { roomName, password } = parsed.data;
    if (password) setRoomPassword(roomName, password);

    await socket.join(roomName);
    const mode = reconcileMode(roomName);
    socket.emit('room-mode', { roomName, mode, size: roomSize(roomName) });
    const rooms = await getAllRooms();
    io.emit('fetch active rooms', JSON.stringify(rooms));

    await emitRoomRoster(io, socket, roomName);
  });

  socket.on('media state change', (raw: unknown) => {
    const parsed = MediaStateChangePayload.safeParse(raw);
    if (!parsed.success) return;
    const { roomName, kind, enabled } = parsed.data;
    const data = (socket.data as { mediaState: MediaState }).mediaState;
    if (kind === 'video') data.videoEnabled = enabled;
    else data.audioEnabled = enabled;
    socket.to(roomName).emit('media state change', { userId: socket.id, kind, enabled });
  });

  socket.on('offer', (raw: unknown) => {
    const parsed = OfferPayload.safeParse(raw);
    if (!parsed.success) return;
    const target = io.sockets.sockets.get(parsed.data.to);
    if (!target) return;
    target.emit('offer', { from: socket.id, offer: parsed.data.offer });
  });

  socket.on('answer', (raw: unknown) => {
    const parsed = AnswerPayload.safeParse(raw);
    if (!parsed.success) return;
    io.to(parsed.data.to).emit('answer', { from: socket.id, answer: parsed.data.answer });
  });

  socket.on('candidate', (raw: unknown) => {
    const parsed = CandidatePayload.safeParse(raw);
    if (!parsed.success) return;
    io.to(parsed.data.to).emit('candidate', {
      from: socket.id,
      candidate: parsed.data.candidate,
    });
  });

  socket.on('leave room', async (raw: unknown) => {
    const parsed = LeaveRoomPayload.safeParse(raw);
    if (!parsed.success) return;
    const roomName = parsed.data;
    if (!roomName) return;
    if (socket.rooms.has(roomName)) {
      socket.to(roomName).emit('remove room user', socket.id);
      await socket.leave(roomName);
      reconcileMode(roomName);
      gcRoomPassword(roomName);
    }
    const rooms = await getAllRooms();
    io.emit('fetch active rooms', JSON.stringify(rooms));
  });

  socket.on('disconnecting', () => {
    for (const roomName of socket.rooms) {
      if (roomName === socket.id) continue;
      socket.to(roomName).emit('remove room user', socket.id);
      // Recompute *after* the socket is removed from the room. Socket.io
      // performs the actual removal between disconnecting and disconnect,
      // so defer the reconcile by a tick.
      setImmediate(() => {
        reconcileMode(roomName);
        gcRoomPassword(roomName);
      });
    }
  });

  socket.on('disconnect', async () => {
    const rooms = await getAllRooms();
    io.emit('fetch active rooms', JSON.stringify(rooms));
  });
}
