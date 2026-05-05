// Per-pair end-to-end chat encryption.
//
// Threat model
// ------------
// Goal: the signaling server (and anyone watching the wire between client and
// server) cannot read chat plaintext. ECDH gives us a shared symmetric key that
// neither side ever transmits.
//
// What this protects against:
//   - Passive surveillance by the signaling server or any network observer.
//   - Server logs and crash dumps containing plaintext.
//
// What this does NOT protect against:
//   - Active MITM by the signaling server during pubkey exchange. The server
//     could substitute its own keys and decrypt + re-encrypt in flight. This
//     is unavoidable without out-of-band verification — see safetyNumber()
//     below, which two users can compare in person / by phone to detect MITM.
//   - Compromised endpoints (browser extensions, malware). Web Crypto keys
//     never leave SubtleCrypto, but JavaScript still runs in the same origin.
//   - A peer impersonating another's username. We don't sign messages.
//
// Algorithms
//   - Key agreement: ECDH on P-256 (NIST curve, broadly supported).
//   - Key derivation: HKDF-SHA-256 with a per-protocol info tag.
//   - Bulk encryption: AES-GCM-256 with a fresh 12-byte IV per message.

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;
const HKDF_INFO = new TextEncoder().encode("socket-webrtc-chat-v1");

export interface ChatKeypair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string;
}

export interface EncryptedBlob {
  iv: string; // base64
  ct: string; // base64
}

export async function generateChatKeypair(): Promise<ChatKeypair> {
  const kp = await crypto.subtle.generateKey(
    ECDH_PARAMS,
    true, // extractable so we can export the public key — private is never exported in code
    ["deriveBits", "deriveKey"]
  );
  const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyB64: bufToB64(rawPub),
  };
}

export async function deriveSharedKey(
  myPrivKey: CryptoKey,
  theirPubKeyB64: string
): Promise<CryptoKey> {
  const theirPub = await crypto.subtle.importKey(
    "raw",
    b64ToBuf(theirPubKeyB64),
    ECDH_PARAMS,
    true,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: theirPub },
    myPrivKey,
    256
  );
  const ikm = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    iv: bufToB64(iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength)),
    ct: bufToB64(ct),
  };
}

export async function decryptText(key: CryptoKey, ivB64: string, ctB64: string): Promise<string> {
  const iv = new Uint8Array(b64ToBuf(ivB64));
  const ctBuf = b64ToBuf(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ctBuf);
  return new TextDecoder().decode(pt);
}

// Verifiable identity string for a pair of public keys. Two users in different
// browser sessions of the same room compute the same number — if they read it
// out to each other and they match, no MITM is replacing keys.
export async function safetyNumber(pubA: string, pubB: string): Promise<string> {
  const ordered = pubA < pubB ? `${pubA}|${pubB}` : `${pubB}|${pubA}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ordered));
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex.match(/.{4}/g)!.join(" ");
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
