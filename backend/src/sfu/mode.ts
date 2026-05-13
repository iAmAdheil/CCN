// Per-room mode coordination. Below the threshold the app runs as a pure
// mesh (every peer maintains an RTCPeerConnection with every other peer).
// At/above the threshold it flips to SFU mode so each peer only uplinks one
// stream and downlinks from the SFU.
//
// The threshold sits at MESH_MAX (default 4). Crossing it in either
// direction emits a `room-mode` event so clients can tear down or rebuild
// their media paths.
export type RoomMode = 'mesh' | 'sfu';

export const MESH_MAX = Number(process.env.SFU_MESH_MAX ?? 4);

export function modeForSize(size: number): RoomMode {
  return size > MESH_MAX ? 'sfu' : 'mesh';
}
