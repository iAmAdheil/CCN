// GF(2^8) — Galois Field over 256 elements, used by AES and Reed-Solomon.
//
// Addition is XOR. Multiplication is polynomial multiplication modulo the
// primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1). We precompute
// log/antilog tables so multiplication and inversion both become table
// lookups: a * b = exp[ (log[a] + log[b]) mod 255 ].
//
// Generator α = 0x02. log[0] is undefined and never indexed.

const FIELD_SIZE = 256;
const PRIMITIVE = 0x11d;

const LOG = new Uint8Array(FIELD_SIZE);
const EXP = new Uint8Array(FIELD_SIZE * 2); // doubled so log+log doesn't need a modulo

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  // Mirror so EXP[i + 255] == EXP[i] for i in [0, 255).
  for (let i = 255; i < 510; i++) {
    EXP[i] = EXP[i - 255];
  }
})();

export function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function div(a: number, b: number): number {
  if (a === 0) return 0;
  if (b === 0) throw new Error('GF256: divide by zero');
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

export function inv(a: number): number {
  if (a === 0) throw new Error('GF256: inverse of zero');
  return EXP[255 - LOG[a]];
}

export function add(a: number, b: number): number {
  return a ^ b;
}

// Convenience for multiplying a byte by a constant across a whole buffer.
// Used as the inner loop of the Reed-Solomon encode/decode. Caller passes
// `acc` to accumulate the running XOR.
export function mulAddRow(c: number, src: Uint8Array, dst: Uint8Array): void {
  if (src.length !== dst.length) throw new Error('GF256: row length mismatch');
  if (c === 0) return;
  const logC = LOG[c];
  for (let i = 0; i < src.length; i++) {
    const s = src[i]!;
    if (s !== 0) dst[i] ^= EXP[logC + LOG[s]]!;
  }
}
