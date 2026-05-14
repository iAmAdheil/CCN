// Standalone smoke test for Reed-Solomon. Run with:
//   node --experimental-strip-types frontend/src/lib/erasure/__smoke.ts
// Asserts encoding + reconstruction across multiple shard-loss patterns.
import { ReedSolomon, splitIntoShards, recombineShards } from './reedSolomon.ts';
import { mul, inv } from './gf256.ts';

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

function rand(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

// 1. GF(256) sanity
assert(mul(0, 5) === 0, 'mul-zero');
assert(mul(1, 173) === 173, 'mul-identity');
assert(mul(inv(173), 173) === 1, 'inverse-product');

// 2. Round-trip with no loss
{
  const k = 10, m = 4;
  const rs = new ReedSolomon({ k, m });
  const data = Array.from({ length: k }, () => rand(1024));
  const parity = rs.encode(data);
  assert(parity.length === m, 'parity-count');

  const all = [...data, ...parity];
  const recovered = rs.reconstruct(all);
  for (let i = 0; i < k; i++) {
    assert(buffersEqual(data[i], recovered[i]), `noloss-shard-${i}`);
  }
  console.log('round-trip 10+4 no-loss: OK');
}

// 3. Drop random m shards, verify reconstruction
{
  const k = 10, m = 4;
  const rs = new ReedSolomon({ k, m });
  for (let trial = 0; trial < 20; trial++) {
    const data = Array.from({ length: k }, () => rand(512 + trial * 8));
    const parity = rs.encode(data);
    const all: Array<Uint8Array | null> = [...data, ...parity];
    // Drop m random distinct indices
    const drop = new Set<number>();
    while (drop.size < m) drop.add(Math.floor(Math.random() * (k + m)));
    for (const i of drop) all[i] = null;
    const recovered = rs.reconstruct(all);
    for (let i = 0; i < k; i++) {
      assert(buffersEqual(data[i], recovered[i]), `trial-${trial} shard-${i} dropped=${[...drop].join(',')}`);
    }
  }
  console.log('round-trip 10+4 random-drop-4 × 20 trials: OK');
}

// 4. Drop all data shards (worst case — keep only parity)
{
  const k = 4, m = 4;
  const rs = new ReedSolomon({ k, m });
  const data = Array.from({ length: k }, () => rand(2048));
  const parity = rs.encode(data);
  const all: Array<Uint8Array | null> = [null, null, null, null, ...parity];
  const recovered = rs.reconstruct(all);
  for (let i = 0; i < k; i++) {
    assert(buffersEqual(data[i], recovered[i]), `all-data-dropped-shard-${i}`);
  }
  console.log('round-trip 4+4 drop-all-data: OK');
}

// 5. splitIntoShards / recombineShards
{
  const k = 10;
  const original = rand(7777);
  const { shards, originalLength } = splitIntoShards(original, k);
  assert(shards.length === k, 'split-count');
  assert(originalLength === 7777, 'split-len');
  const merged = recombineShards(shards, originalLength);
  assert(buffersEqual(original, merged), 'split-recombine-roundtrip');
  console.log('split/recombine: OK');
}

// 6. End-to-end: split → encode → drop → reconstruct → recombine
{
  const k = 10, m = 4;
  const rs = new ReedSolomon({ k, m });
  const original = rand(50_000);
  const { shards, originalLength } = splitIntoShards(original, k);
  const parity = rs.encode(shards);
  const all: Array<Uint8Array | null> = [...shards, ...parity];
  // Drop indices 0, 3, 7, 12 (mix of data and parity)
  for (const i of [0, 3, 7, 12]) all[i] = null;
  const recovered = rs.reconstruct(all);
  const merged = recombineShards(recovered, originalLength);
  assert(buffersEqual(original, merged), 'end-to-end mismatch');
  console.log('end-to-end 50KB drop 4 of 14 (mixed): OK');
}

console.log('ALL OK');
