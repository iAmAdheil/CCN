// Per-file confidentiality for the distributed drive.
//
// Each file is sealed once with a fresh random AES-GCM-256 key ("file key").
// The file key is then wrapped using ECIES: the wrapper generates an
// ephemeral ECDH P-256 keypair, derives a shared secret against the owner's
// long-lived public key, runs HKDF-SHA-256 to produce a key-encryption-key
// (KEK), and AES-GCM-encrypts the file key under the KEK.
//
// Peers holding shards see only the AES-GCM ciphertext and the wrapped key;
// without the owner's private key they cannot recover the file. The shard
// distribution is therefore zero-knowledge to holders.
//
// Threat model out of scope: a malicious holder can refuse to serve their
// shards or serve garbage. The Reed-Solomon layer tolerates up to m shard
// losses; manifest hashes detect tampering and force the requester to
// reconstruct from a different subset.

const TEXT_ENCODER = new TextEncoder();

export type UserKeypair = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string; // base64(spki) — what gets put in manifests and signed
};

export interface UserIdentity {
  ecdh: UserKeypair;  // for ECIES key-wrapping
  sign: UserKeypair;  // for manifest signing (ECDSA P-256)
}

export async function generateUserKeypair(): Promise<UserKeypair> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    /* extractable */ true,
    ['deriveKey', 'deriveBits'],
  );
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyB64: bytesToB64(new Uint8Array(spki)),
  };
}

export async function generateSignKeypair(): Promise<UserKeypair> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    /* extractable */ true,
    ['sign', 'verify'],
  );
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyB64: bytesToB64(new Uint8Array(spki)),
  };
}

export async function generateUserIdentity(): Promise<UserIdentity> {
  const [ecdh, sign] = await Promise.all([generateUserKeypair(), generateSignKeypair()]);
  return { ecdh, sign };
}

export async function importPublicKey(spkiB64: string): Promise<CryptoKey> {
  const bytes = b64ToBytes(spkiB64);
  return crypto.subtle.importKey(
    'spki',
    bytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    /* extractable */ true,
    [],
  );
}

export async function importSignPublicKey(spkiB64: string): Promise<CryptoKey> {
  const bytes = b64ToBytes(spkiB64);
  return crypto.subtle.importKey(
    'spki',
    bytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    /* extractable */ true,
    ['verify'],
  );
}

// ECDSA P-256 detached signature over arbitrary bytes. The signature is the
// raw IEEE P1363 format (r || s), 64 bytes.
export async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  return new Uint8Array(sig);
}

export async function verifyBytes(
  publicKey: CryptoKey,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, data);
}

export async function generateFileKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, /* extractable */ true, [
    'encrypt',
    'decrypt',
  ]);
}

export interface SealedFile {
  iv: Uint8Array;        // 12 bytes
  ciphertext: Uint8Array; // includes 16-byte GCM tag at end
}

export async function sealFile(key: CryptoKey, plaintext: Uint8Array): Promise<SealedFile> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv, ciphertext: new Uint8Array(ct) };
}

export async function openFile(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(pt);
}

// --- ECIES key wrapping --------------------------------------------------

export interface WrappedKey {
  ephemeralPubKeyB64: string; // sender's one-shot ECDH public key (spki, b64)
  iv: string;                 // base64 of 12-byte AES-GCM IV
  ct: string;                 // base64 of AES-GCM ciphertext (file key + tag)
}

async function deriveKek(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  info: string,
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );
  // HKDF salt is empty for this protocol — the ephemeral pub identifies the
  // session and binds the salt context. `info` separates KEK derivations
  // from other ECDH uses (e.g. chatCrypto's per-pair key).
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: TEXT_ENCODER.encode(info),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapFileKey(
  fileKey: CryptoKey,
  ownerPublicKey: CryptoKey,
): Promise<WrappedKey> {
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    /* extractable */ true,
    ['deriveBits'],
  );
  const ephSpki = await crypto.subtle.exportKey('spki', eph.publicKey);
  const kek = await deriveKek(eph.privateKey, ownerPublicKey, 'socket-webrtc/drive/file-key-wrap');
  const raw = await crypto.subtle.exportKey('raw', fileKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
  return {
    ephemeralPubKeyB64: bytesToB64(new Uint8Array(ephSpki)),
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
}

export async function unwrapFileKey(
  wrapped: WrappedKey,
  ownerKeypair: UserKeypair,
): Promise<CryptoKey> {
  const ephPub = await importPublicKey(wrapped.ephemeralPubKeyB64);
  const kek = await deriveKek(ownerKeypair.privateKey, ephPub, 'socket-webrtc/drive/file-key-wrap');
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(wrapped.iv) },
    kek,
    b64ToBytes(wrapped.ct),
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

// --- helpers -------------------------------------------------------------

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

export function sha256Hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}
