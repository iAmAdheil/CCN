// 160-bit node identifiers (Kademlia uses SHA-1's 160 bits historically; we
// derive ours from SHA-256 truncated to 20 bytes for the same bit width but
// without depending on a SHA-1 implementation).
//
// All distance/comparison ops use big-endian byte order. The XOR distance is
// itself a NodeId; comparing two distances is just lexicographic byte
// comparison.

export const NODE_ID_BYTES = 20;
export const NODE_ID_BITS = NODE_ID_BYTES * 8;

export type NodeId = Uint8Array; // length === NODE_ID_BYTES

export function isNodeId(v: unknown): v is NodeId {
  return v instanceof Uint8Array && v.length === NODE_ID_BYTES;
}

// Derive a node id from an arbitrary string handle (typically a socket id).
// SHA-256, truncated to 20 bytes. SubtleCrypto in browsers; node:crypto in
// Node tests.
export async function nodeIdFromString(handle: string): Promise<NodeId> {
  const enc = new TextEncoder().encode(handle);
  const subtle = (globalThis.crypto && (globalThis.crypto as Crypto).subtle) ?? null;
  let digest: ArrayBuffer;
  if (subtle) {
    digest = await subtle.digest("SHA-256", enc);
  } else {
    // Tests under bare Node may not surface SubtleCrypto; fall back to
    // node:crypto via dynamic import.
    const { createHash } = await import("node:crypto");
    digest = createHash("sha256").update(enc).digest().buffer;
  }
  return new Uint8Array(digest).slice(0, NODE_ID_BYTES);
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must be even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// XOR distance — Kademlia's metric. Symmetric and the triangle inequality
// holds (it's a valid metric on the 160-bit hypercube).
export function xorDistance(a: NodeId, b: NodeId): NodeId {
  if (a.length !== b.length) throw new Error("xorDistance: length mismatch");
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

// Compare two distances (or any two equal-length byte strings). Returns
// negative/zero/positive to fit Array.prototype.sort's contract.
export function compareDistance(a: NodeId, b: NodeId): number {
  if (a.length !== b.length) throw new Error("compareDistance: length mismatch");
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// Index of the bucket that `target` belongs in relative to `self`.
// Bucket i covers nodes whose XOR distance has its highest set bit at
// position i (counting from the LSB end). Returns -1 for the special case
// where target === self (XOR is all-zero).
export function bucketIndex(self: NodeId, target: NodeId): number {
  const dist = xorDistance(self, target);
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] === 0) continue;
    // Highest set bit in dist[i], counting from MSB.
    let msb = 0;
    for (let bit = 7; bit >= 0; bit--) {
      if (dist[i] & (1 << bit)) {
        msb = bit;
        break;
      }
    }
    // Buckets are numbered from the *least* significant bit so that the
    // highest bucket holds the most-distant nodes. Convert.
    const byteFromTop = i;
    const bitsFromTop = byteFromTop * 8 + (7 - msb);
    return NODE_ID_BITS - 1 - bitsFromTop;
  }
  return -1;
}

// Convenience: hash an arbitrary value (e.g. "fileId/index") into a NodeId.
// Same algorithm as nodeIdFromString.
export const keyFromString = nodeIdFromString;
