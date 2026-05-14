// Per-room media-key state shared by every peer in the room. The key is
// a raw 32-byte AES-GCM secret; each peer holds the same one and uses it
// to encrypt every encoded media frame they produce, and decrypt every
// frame they consume.
//
// Distribution piggy-backs on the existing chat ECDH per-pair channel:
//   - First peer in the room generates a key on first request.
//   - When a peer needs the key, they ask each known peer with a
//     `media-key-request` DC control message.
//   - The responder encrypts the raw key bytes under the per-pair AES-GCM
//     chat key (derived from the chat ECDH exchange) and replies with
//     `media-key-response`.
//
// This avoids any server-side support — the existing E2EE chat channel
// already authenticates and encrypts everything between two peers, and
// the SFU never sees the wrapped key bytes.
//
// Limitations (v1):
//   - No key rotation on member change. Past members keep the ability to
//     decrypt future frames until the room is recreated.
//   - No quorum / TOFU. The first peer to respond is trusted.

export interface MediaKeyState {
  keyId: number;
  rawKey: Uint8Array;
}

// Wire envelope for a media-key-response sent over a DC. The body is
// AES-GCM-encrypted under the chat per-pair shared key (chatCrypto's
// sharedKey for the {sender, recipient} pair). Layout matches
// chatCrypto's { iv, ct } so we reuse encrypt/decrypt helpers.
export interface MediaKeyEnvelope {
  type: 'media-key-enc';
  keyId: number;
  iv: string; // base64
  ct: string; // base64 — ciphertext of JSON.stringify({ rawKeyB64 })
}

export interface MediaKeyRequest {
  type: 'media-key-request';
}

// Generate a fresh state. Called by the first peer to need a media key.
export async function generateMediaKeyState(): Promise<MediaKeyState> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  // Random non-zero keyId; reduces accidental collisions if two peers
  // independently generate keys before exchanging.
  const id = (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0;
  return { keyId: id, rawKey };
}

// Wrap a media key under a per-pair AES-GCM shared key (from chatCrypto).
import { decryptText, encryptText } from '@/lib/chatCrypto';

export async function wrapMediaKey(
  state: MediaKeyState,
  pairKey: CryptoKey,
): Promise<MediaKeyEnvelope> {
  // Encode the raw key as base64 inside a JSON envelope so we can reuse
  // chatCrypto's text-oriented seal helpers — and so future versions can
  // add fields (e.g. epoch number) without breaking the wire shape.
  const rawKeyB64 = uint8ToB64(state.rawKey);
  const sealed = await encryptText(pairKey, JSON.stringify({ rawKeyB64 }));
  return { type: 'media-key-enc', keyId: state.keyId, iv: sealed.iv, ct: sealed.ct };
}

export async function unwrapMediaKey(
  env: MediaKeyEnvelope,
  pairKey: CryptoKey,
): Promise<MediaKeyState> {
  const json = await decryptText(pairKey, env.iv, env.ct);
  const { rawKeyB64 } = JSON.parse(json) as { rawKeyB64: string };
  if (typeof rawKeyB64 !== 'string') throw new Error('media key envelope: missing rawKeyB64');
  return { keyId: env.keyId, rawKey: b64ToUint8(rawKeyB64) };
}

function uint8ToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}

function b64ToUint8(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
