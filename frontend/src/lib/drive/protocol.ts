// Wire-level message types for the distributed drive. All control messages
// travel as JSON over whatever transport the caller provides — currently
// either an RTCDataChannel (in mesh mode) or the server-relay path (mesh
// fallback, or post-upgrade SFU). Shard bytes travel as base64-in-JSON for
// simplicity in v1; chunked binary is a Tier 3 follow-up.
//
// Every message carries `op` for routing. The Wire abstraction in
// driveClient.ts demultiplexes based on this field.

import type { SignedManifest } from './manifest.js';
import type { DhtMessage } from '../dht/protocol.js';

export type DriveMessage =
  // DHT messages share the chat DC with drive — we wrap them under one
  // discriminated union so the dispatcher in useDrive only has one
  // ingestRemote path. Internally the DhtMessage is forwarded to the
  // KademliaNode handler.
  | { op: 'drive:dht'; payload: DhtMessage }
  | LegacyDriveMessage;

type LegacyDriveMessage =
  // Uploader -> holder: "would you store shard X for me?"
  | { op: 'drive:offer'; fileId: string; index: number; size: number; hashB64: string }
  // Holder -> uploader: response to an offer.
  | { op: 'drive:offer-ack'; fileId: string; index: number; accept: boolean; reason?: string }
  // Uploader -> holder: shard bytes (base64). Sent only after offer-ack.
  | { op: 'drive:store'; fileId: string; index: number; dataB64: string }
  // Holder -> uploader: stored successfully (or with reason for failure).
  | { op: 'drive:store-ack'; fileId: string; index: number; ok: boolean; reason?: string }
  // Uploader -> everyone in room: signed manifest announcing the upload.
  | { op: 'drive:manifest'; manifest: SignedManifest }
  // Downloader -> holder: please send me a stored shard.
  | { op: 'drive:fetch'; fileId: string; index: number }
  // Holder -> downloader: the shard bytes (or not-found).
  | { op: 'drive:fetch-response'; fileId: string; index: number; dataB64: string | null; reason?: string }
  // Newly-joined peer -> existing peer: send me your known manifests so I
  // can discover what's on the drive.
  | { op: 'drive:manifest-sync-request' }
  | { op: 'drive:manifest-sync-response'; manifests: SignedManifest[] };

export interface Wire {
  // Send a directed message to a single peer (by socket id).
  send: (peerId: string, msg: DriveMessage) => void;
  // Broadcast to all peers in the current room.
  broadcast: (msg: DriveMessage) => void;
  // Register a handler. Returns an unsubscribe function. The wire delivers
  // every drive message it receives, regardless of which peer sent it.
  subscribe: (handler: (fromPeerId: string, msg: DriveMessage) => void) => () => void;
}
