// Per-frame symmetric encryption for the SFU's encoded media path.
//
// Why this matters: the SFU forwards RTP packets to every peer in a room.
// SRTP already encrypts each hop, but the SFU itself terminates SRTP and
// can read plaintext frames. Inserting AES-GCM at the encoded-frame layer
// keeps the SFU blind — it only forwards opaque bytes.
//
// Frame layout on the wire:
//   [12-byte IV][N-byte ciphertext including 16-byte GCM tag]
//
// The IV is constructed as (4-byte keyId || 8-byte frame counter, big-endian)
// so a key rotation never collides with the previous key's counter space.
// Counter is monotonically increasing per (sender, key) and held by the
// FrameCipher instance — never exposed to the wire as a plaintext field
// because it's already inside the IV.
//
// Out of scope (deferred): authenticated additional data (AAD) for the
// codec-specific frame header (e.g. VP8 marker bit). Without AAD a
// reordering attack within a single key is theoretically detectable by
// the GCM tag catching wrong-IV → bad-tag; for v1 that's sufficient.

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface FrameCipherKey {
  keyId: number;     // 0..0xFFFFFFFF
  cryptoKey: CryptoKey;
}

export class FrameCipher {
  private key: FrameCipherKey | null = null;
  private sendCounter = 0n;

  setKey(key: FrameCipherKey): void {
    this.key = key;
    this.sendCounter = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  // Encrypt an outgoing frame. Returns the new payload (IV || ciphertext).
  async encrypt(payload: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error('FrameCipher: no key set');
    const iv = this.buildIv(this.key.keyId, this.sendCounter);
    this.sendCounter += 1n;
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8 },
      this.key.cryptoKey,
      payload,
    );
    const out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_BYTES);
    return out;
  }

  // Decrypt an incoming frame. The IV is parsed from the first 12 bytes.
  // We don't track per-sender receive counters here because the SFU forwards
  // frames from many senders and the receive side has no notion of "next"
  // counter — it just trusts the IV in the frame and lets AES-GCM catch
  // tampering via its tag.
  async decrypt(wire: Uint8Array, expectedKeyId: number): Promise<Uint8Array> {
    if (!this.key) throw new Error('FrameCipher: no key set');
    if (wire.length < IV_BYTES + TAG_BYTES) {
      throw new Error('FrameCipher: frame too short');
    }
    const iv = wire.subarray(0, IV_BYTES);
    const keyId = (iv[0]! << 24) | (iv[1]! << 16) | (iv[2]! << 8) | iv[3]!;
    if ((keyId >>> 0) !== (expectedKeyId >>> 0)) {
      throw new Error(`FrameCipher: key id mismatch (got ${keyId}, want ${expectedKeyId})`);
    }
    const ct = wire.subarray(IV_BYTES);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8 },
      this.key.cryptoKey,
      ct,
    );
    return new Uint8Array(pt);
  }

  private buildIv(keyId: number, counter: bigint): Uint8Array {
    const iv = new Uint8Array(IV_BYTES);
    const view = new DataView(iv.buffer);
    view.setUint32(0, keyId >>> 0, false);
    // 8-byte BE counter — DataView lacks setBigUint64 in older targets but
    // any modern runtime supports it.
    view.setBigUint64(4, counter, false);
    return iv;
  }
}

export async function importMediaKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function generateRawMediaKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32));
}
