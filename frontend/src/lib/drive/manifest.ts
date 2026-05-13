// File manifest for the distributed drive. The manifest fully describes a
// file: encryption parameters, sharding parameters, per-shard hashes,
// uploader identity, and a detached ECDSA signature so any peer can verify
// the manifest came from the claimed uploader and hasn't been tampered with
// in transit.
//
// Wire encoding is canonical JSON (object keys lexicographically sorted) so
// signature verification is reproducible byte-for-byte.
import {
  b64ToBytes,
  bytesToB64,
  importSignPublicKey,
  signBytes,
  verifyBytes,
  type WrappedKey,
} from './fileCrypto.js';

export interface ShardDescriptor {
  index: number;     // position in the (k + m) shard layout
  size: number;      // shard byte length
  hashB64: string;   // base64 of SHA-256 of the shard contents
}

// Body of a manifest sans signature. We sign the canonical JSON of this
// object exactly; the signature wraps around it.
export interface ManifestBody {
  version: 1;
  fileId: string;                // random 16-byte id, base64-url
  name: string;
  size: number;                  // plaintext byte length before sealing
  sealedSize: number;            // ciphertext byte length (sealed.length)
  paddedShardSize: number;       // per-shard byte length after RS sharding
  contentType?: string;
  k: number;
  m: number;
  iv: string;                    // base64 of 12-byte AES-GCM IV
  fileKeyWrapped: WrappedKey;    // ECIES-wrapped AES-GCM file key
  shards: ShardDescriptor[];     // length k + m, ordered by index
  uploaderSignPubKeyB64: string; // spki(ECDSA P-256) of uploader, b64
  createdAt: number;             // unix millis
}

export interface SignedManifest extends ManifestBody {
  signatureB64: string; // ECDSA P1363 signature over canonicalJson(body)
}

export function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // base64url, strip padding.
  return (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64'))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Canonical JSON: keys sorted, no extra whitespace. Deep sort because the
// embedded `WrappedKey` and `ShardDescriptor[]` need to be deterministic
// too. We sort objects but preserve array order (array index is semantic).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = canonicalize(obj[k]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(body: ManifestBody): string {
  return JSON.stringify(canonicalize(body));
}

export async function signManifest(
  body: ManifestBody,
  signPrivateKey: CryptoKey,
): Promise<SignedManifest> {
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const sig = await signBytes(signPrivateKey, bytes);
  return { ...body, signatureB64: bytesToB64(sig) };
}

export async function verifyManifest(manifest: SignedManifest): Promise<boolean> {
  const { signatureB64, ...rest } = manifest;
  const body = rest as ManifestBody;
  if (body.uploaderSignPubKeyB64 == null) return false;
  let pub: CryptoKey;
  try {
    pub = await importSignPublicKey(body.uploaderSignPubKeyB64);
  } catch {
    return false;
  }
  const bytes = new TextEncoder().encode(canonicalJson(body));
  return verifyBytes(pub, bytes, b64ToBytes(signatureB64));
}
