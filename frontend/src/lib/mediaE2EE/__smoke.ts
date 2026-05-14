// Smoke test for the frame cipher. Run via:
//   npx tsx src/lib/mediaE2EE/__smoke.ts
import { FrameCipher, generateRawMediaKey, importMediaKey } from './frameCipher.ts';

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

const KEY_ID = 0x12345678;
const raw = await generateRawMediaKey();
const key = await importMediaKey(raw);

// 1. Round-trip a single frame
{
  const enc = new FrameCipher();
  const dec = new FrameCipher();
  enc.setKey({ keyId: KEY_ID, cryptoKey: key });
  dec.setKey({ keyId: KEY_ID, cryptoKey: key });
  const payload = new TextEncoder().encode('frame body x'.repeat(50));
  const wire = await enc.encrypt(payload);
  // Expected wire size: 12 IV + payload + 16 tag
  assert(wire.length === payload.length + 28, `wire size ${wire.length} expected ${payload.length + 28}`);
  const out = await dec.decrypt(wire, KEY_ID);
  assert(buffersEqual(payload, out), 'round-trip mismatch');
  console.log('frame round-trip: OK');
}

// 2. Multiple frames advance the counter
{
  const enc = new FrameCipher();
  enc.setKey({ keyId: KEY_ID, cryptoKey: key });
  const a = await enc.encrypt(new Uint8Array([1, 2, 3]));
  const b = await enc.encrypt(new Uint8Array([1, 2, 3]));
  // Same plaintext + same key, different counter → different ciphertext
  let differs = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { differs = true; break; }
  }
  assert(differs, 'counter not advancing — IV reuse risk');
  console.log('counter advance: OK');
}

// 3. Tamper detection
{
  const enc = new FrameCipher();
  const dec = new FrameCipher();
  enc.setKey({ keyId: KEY_ID, cryptoKey: key });
  dec.setKey({ keyId: KEY_ID, cryptoKey: key });
  const wire = await enc.encrypt(new Uint8Array([7, 7, 7, 7]));
  // Flip a byte in the ciphertext (after the IV)
  wire[14]! ^= 0x01;
  let threw = false;
  try {
    await dec.decrypt(wire, KEY_ID);
  } catch {
    threw = true;
  }
  assert(threw, 'tampered frame accepted');
  console.log('tamper detect: OK');
}

// 4. Wrong key id rejected
{
  const enc = new FrameCipher();
  const dec = new FrameCipher();
  enc.setKey({ keyId: 0xAAAAAAAA, cryptoKey: key });
  dec.setKey({ keyId: KEY_ID, cryptoKey: key });
  const wire = await enc.encrypt(new Uint8Array([1, 2, 3]));
  let threw = false;
  try {
    await dec.decrypt(wire, KEY_ID);
  } catch {
    threw = true;
  }
  assert(threw, 'wrong key id accepted');
  console.log('key id mismatch rejected: OK');
}

// 5. Wrong key (different bytes) fails GCM tag
{
  const enc = new FrameCipher();
  const dec = new FrameCipher();
  enc.setKey({ keyId: KEY_ID, cryptoKey: key });
  const otherRaw = await generateRawMediaKey();
  const otherKey = await importMediaKey(otherRaw);
  dec.setKey({ keyId: KEY_ID, cryptoKey: otherKey });
  const wire = await enc.encrypt(new Uint8Array([9, 9, 9]));
  let threw = false;
  try {
    await dec.decrypt(wire, KEY_ID);
  } catch {
    threw = true;
  }
  assert(threw, 'wrong key accepted');
  console.log('wrong key rejected: OK');
}

console.log('ALL OK');
