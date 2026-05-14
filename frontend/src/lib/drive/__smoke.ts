// Smoke test for fileCrypto. Run via:
//   npx tsx src/lib/drive/__smoke.ts
import {
  generateFileKey,
  generateUserKeypair,
  importPublicKey,
  openFile,
  sealFile,
  sha256,
  unwrapFileKey,
  wrapFileKey,
} from './fileCrypto.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 1. AES-GCM seal/open round-trip
{
  const key = await generateFileKey();
  const pt = new TextEncoder().encode('hello distributed drive');
  const sealed = await sealFile(key, pt);
  const opened = await openFile(key, sealed.iv, sealed.ciphertext);
  assert(buffersEqual(pt, opened), 'seal/open round-trip');
  console.log('seal/open: OK');
}

// 2. Tampering detection
{
  const key = await generateFileKey();
  const pt = new TextEncoder().encode('important data');
  const sealed = await sealFile(key, pt);
  sealed.ciphertext[0]! ^= 0x01;
  let threw = false;
  try {
    await openFile(key, sealed.iv, sealed.ciphertext);
  } catch {
    threw = true;
  }
  assert(threw, 'tamper-detect');
  console.log('tamper-detect: OK');
}

// 3. ECIES key wrap/unwrap
{
  const owner = await generateUserKeypair();
  const fileKey = await generateFileKey();
  const wrapped = await wrapFileKey(fileKey, owner.publicKey);
  const unwrapped = await unwrapFileKey(wrapped, owner);

  // Verify the unwrapped key decrypts ciphertext sealed under fileKey.
  const pt = new TextEncoder().encode('plaintext under file key');
  const sealed = await sealFile(fileKey, pt);
  const opened = await openFile(unwrapped, sealed.iv, sealed.ciphertext);
  assert(buffersEqual(pt, opened), 'unwrapped-key decrypts seal');
  console.log('ECIES wrap/unwrap: OK');
}

// 4. Public-key portability via spki re-import (simulates manifest hop)
{
  const owner = await generateUserKeypair();
  const reimported = await importPublicKey(owner.publicKeyB64);
  const fileKey = await generateFileKey();
  const wrapped = await wrapFileKey(fileKey, reimported);
  const unwrapped = await unwrapFileKey(wrapped, owner);
  const pt = new TextEncoder().encode('portable');
  const sealed = await sealFile(fileKey, pt);
  const opened = await openFile(unwrapped, sealed.iv, sealed.ciphertext);
  assert(buffersEqual(pt, opened), 'spki-roundtrip wrap+unwrap');
  console.log('spki portability: OK');
}

// 5. SHA-256 sanity
{
  const empty = await sha256(new Uint8Array(0));
  // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const hex = Array.from(empty).map((b) => b.toString(16).padStart(2, '0')).join('');
  assert(hex === expected, `sha256-empty got ${hex}`);
  console.log('sha256 known-vector: OK');
}

// 6. Manifest sign / verify
{
  const { generateUserIdentity } = await import('./fileCrypto.ts');
  const { newFileId, signManifest, verifyManifest, canonicalJson } = await import('./manifest.ts');
  const owner = await generateUserIdentity();
  const fileKey = await generateFileKey();
  const wrapped = await wrapFileKey(fileKey, owner.ecdh.publicKey);
  const body = {
    version: 1 as const,
    fileId: newFileId(),
    name: 'hello.txt',
    size: 1000,
    sealedSize: 1016,
    paddedShardSize: 102,
    contentType: 'text/plain',
    k: 10,
    m: 4,
    iv: 'AAAAAAAAAAAAAAAA',
    fileKeyWrapped: wrapped,
    shards: Array.from({ length: 14 }, (_, i) => ({
      index: i,
      size: 102,
      hashB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    })),
    uploaderSignPubKeyB64: owner.sign.publicKeyB64,
    createdAt: Date.now(),
  };
  const signed = await signManifest(body, owner.sign.privateKey);
  assert(await verifyManifest(signed), 'verify-ok');
  // Tamper detection
  const tampered = { ...signed, name: 'pwned.txt' };
  assert(!(await verifyManifest(tampered)), 'tamper-rejected');
  // Canonical-JSON determinism
  const c1 = canonicalJson(body);
  const c2 = canonicalJson({ ...body });
  assert(c1 === c2, 'canonical-deterministic');
  console.log('manifest sign/verify: OK');
}

console.log('ALL OK');
