// Per-room state management: mode tracking (mesh ↔ sfu), the active-rooms
// roster query, and the room-mode reconcile that's called on every
// join/leave.
//
// State is kept in a module-level Map. The single io instance is captured
// once at install time so handlers can call `roomSize` / `getAllRooms`
// without threading io through every call path.

import type { Server } from 'socket.io';
import { modeForSize, type RoomMode } from '../sfu/mode.js';

export interface Room {
  id: string;
  name: string;
  hasPassword: boolean;
  activeUsers: { id: string; username: string }[];
}

export interface RoomUser {
  id: string;
  username: string;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
}

let ioRef: Server | null = null;
const roomMode = new Map<string, RoomMode>();
// Optional password gating per room. Set when a creator opts into a password
// on `create room`; cleared when the last peer leaves.
const roomPasswords = new Map<string, string>();

export function setRoomPassword(roomName: string, password: string): void {
  if (password.trim()) roomPasswords.set(roomName, password.trim());
}

export function checkRoomPassword(roomName: string, password: string | undefined): boolean {
  if (!roomPasswords.has(roomName)) return true;
  return roomPasswords.get(roomName) === password;
}

export function hasRoomPassword(roomName: string): boolean {
  return roomPasswords.has(roomName);
}

export function gcRoomPassword(roomName: string): void {
  if (roomSize(roomName) === 0) roomPasswords.delete(roomName);
}

export function bindRoomManager(io: Server): void {
  ioRef = io;
}

function requireIo(): Server {
  if (!ioRef) throw new Error('rooms/manager: bindRoomManager not called');
  return ioRef;
}

export function roomSize(roomName: string): number {
  return requireIo().sockets.adapter.rooms.get(roomName)?.size ?? 0;
}

// Mode is a one-way ratchet: once a room reaches SFU it stays SFU until
// the last peer leaves. Bidirectional downgrade doubles orchestration
// complexity (every peer rebuilds mesh PCs in lockstep) — first cut
// keeps the demo simple and the bandwidth-comparison story still holds
// because we measure at the up-crossing.
export function reconcileMode(roomName: string): RoomMode {
  const io = requireIo();
  const size = roomSize(roomName);
  const prev = roomMode.get(roomName);
  if (size === 0) {
    roomMode.delete(roomName);
    return 'mesh';
  }
  const naive = modeForSize(size);
  const next: RoomMode = prev === 'sfu' ? 'sfu' : naive;
  if (prev !== next) {
    roomMode.set(roomName, next);
    if (prev !== undefined) {
      io.to(roomName).emit('room-mode', { roomName, mode: next, size });
    }
  }
  return next;
}

export function currentMode(roomName: string): RoomMode {
  return roomMode.get(roomName) ?? 'mesh';
}

export async function getAllRooms(): Promise<Room[]> {
  const io = requireIo();
  const rooms: Room[] = [];
  const allRooms = io.of('/').adapter.rooms;
  for (const [roomName] of allRooms) {
    if (io.of('/').sockets.has(roomName)) continue;
    const sockets = await io.in(roomName).fetchSockets();
    rooms.push({
      id: roomName,
      name: roomName,
      hasPassword: roomPasswords.has(roomName),
      activeUsers: sockets.map((socket) => ({
        id: socket.id,
        username: socket.handshake.auth.username,
      })),
    });
  }
  return rooms;
}
