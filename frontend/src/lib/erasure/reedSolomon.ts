// Reed-Solomon erasure coding over GF(2^8).
//
// Given k data shards of equal length, we produce m parity shards so that
// any k of the resulting (k + m) shards are sufficient to reconstruct the
// original data. This is the property the distributed drive relies on for
// peer-churn tolerance — a file survives the loss of up to m holders.
//
// Encoding matrix layout (rows × cols = (k + m) × k):
//   - top k rows: identity, so data shards are kept as-is
//   - bottom m rows: a Cauchy matrix, which guarantees that any k-row
//     subset of the full matrix is invertible (a property Vandermonde
//     matrices don't have for all subsets — important when arbitrary
//     shards go missing)
//
// Cauchy entries: C[i][j] = 1 / (x_i ⊕ y_j), with x_i = k + i and y_j = j
// so all (x_i ⊕ y_j) are nonzero.
import { add, div, inv, mul, mulAddRow } from './gf256.js';

export interface RsConfig {
  k: number; // data shards
  m: number; // parity shards
}

function buildEncodingMatrix(k: number, m: number): number[][] {
  const matrix: number[][] = [];
  // Identity rows for data shards.
  for (let i = 0; i < k; i++) {
    const row = new Array<number>(k).fill(0);
    row[i] = 1;
    matrix.push(row);
  }
  // Cauchy rows for parity shards. x_i = k + i, y_j = j.
  for (let i = 0; i < m; i++) {
    const xi = k + i;
    const row = new Array<number>(k);
    for (let j = 0; j < k; j++) {
      row[j] = inv(xi ^ j);
    }
    matrix.push(row);
  }
  return matrix;
}

export class ReedSolomon {
  private readonly k: number;
  private readonly m: number;
  private readonly encodingMatrix: number[][];

  constructor(config: RsConfig) {
    if (config.k < 1) throw new Error('k must be >= 1');
    if (config.m < 1) throw new Error('m must be >= 1');
    if (config.k + config.m > 256) throw new Error('k + m must be <= 256 for GF(256)');
    this.k = config.k;
    this.m = config.m;
    this.encodingMatrix = buildEncodingMatrix(config.k, config.m);
  }

  // Encode k equal-length data shards into m parity shards. Returns the m
  // parity shards (the original k data shards are unchanged and are the
  // first k of the (k + m) total).
  encode(data: Uint8Array[]): Uint8Array[] {
    if (data.length !== this.k) {
      throw new Error(`encode: expected ${this.k} data shards, got ${data.length}`);
    }
    const shardLen = data[0]!.length;
    for (const shard of data) {
      if (shard.length !== shardLen) throw new Error('encode: shards must be equal length');
    }
    const parity: Uint8Array[] = [];
    for (let i = 0; i < this.m; i++) {
      const out = new Uint8Array(shardLen);
      const row = this.encodingMatrix[this.k + i]!;
      for (let j = 0; j < this.k; j++) {
        mulAddRow(row[j]!, data[j]!, out);
      }
      parity.push(out);
    }
    return parity;
  }

  // Reconstruct missing data shards from any k surviving shards. `shards`
  // is a sparse array of length (k + m): present shards are Uint8Arrays,
  // missing slots are null. Returns the full reconstructed data array of
  // length k.
  reconstruct(shards: Array<Uint8Array | null>): Uint8Array[] {
    if (shards.length !== this.k + this.m) {
      throw new Error(`reconstruct: expected ${this.k + this.m} slots`);
    }

    // Find which shards we have.
    const presentIdx: number[] = [];
    let shardLen = 0;
    for (let i = 0; i < shards.length; i++) {
      const s = shards[i];
      if (s) {
        presentIdx.push(i);
        if (shardLen === 0) shardLen = s.length;
        else if (s.length !== shardLen) throw new Error('reconstruct: shards must be equal length');
      }
    }
    if (presentIdx.length < this.k) {
      throw new Error(`reconstruct: need ${this.k} shards, have ${presentIdx.length}`);
    }

    // Fast path: every data shard is already present.
    let needsRecovery = false;
    for (let i = 0; i < this.k; i++) {
      if (!shards[i]) { needsRecovery = true; break; }
    }
    if (!needsRecovery) {
      return shards.slice(0, this.k) as Uint8Array[];
    }

    // Build a k×k submatrix using the first k present rows of the encoding
    // matrix, then invert it. The inverse maps (received shards) back to
    // (original data shards).
    const chosen = presentIdx.slice(0, this.k);
    const sub: number[][] = chosen.map((idx) => this.encodingMatrix[idx]!.slice());
    const inverse = invertMatrix(sub);

    // For each original data shard d_j, walk the j-th row of inverse and
    // compute d_j = sum_i inverse[j][i] * received[chosen[i]].
    const out: Uint8Array[] = [];
    for (let j = 0; j < this.k; j++) {
      if (shards[j]) {
        out.push(shards[j]!);
        continue;
      }
      const buf = new Uint8Array(shardLen);
      const row = inverse[j]!;
      for (let i = 0; i < this.k; i++) {
        const coef = row[i]!;
        if (coef === 0) continue;
        const src = shards[chosen[i]!];
        if (src) mulAddRow(coef, src, buf);
      }
      out.push(buf);
    }
    return out;
  }
}

// Gauss-Jordan over GF(2^8). Mutates a copy of `matrix` and returns its
// inverse. Cauchy submatrices are always invertible, so we shouldn't hit
// a zero pivot in normal operation — but defensive code: if we do, swap
// rows. If after swapping the pivot is still zero, the matrix is singular.
function invertMatrix(matrix: number[][]): number[][] {
  const n = matrix.length;
  const a: number[][] = matrix.map((r) => r.slice());
  const inverse: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    row[i] = 1;
    inverse.push(row);
  }
  for (let col = 0; col < n; col++) {
    if (a[col]![col] === 0) {
      // Find a row below with a nonzero entry in this column and swap.
      let swap = -1;
      for (let r = col + 1; r < n; r++) {
        if (a[r]![col] !== 0) { swap = r; break; }
      }
      if (swap === -1) throw new Error('invertMatrix: singular');
      [a[col], a[swap]] = [a[swap]!, a[col]!];
      [inverse[col], inverse[swap]] = [inverse[swap]!, inverse[col]!];
    }
    // Normalize pivot row.
    const pivot = a[col]![col]!;
    if (pivot !== 1) {
      const invPivot = inv(pivot);
      for (let c = 0; c < n; c++) {
        a[col]![c] = mul(a[col]![c]!, invPivot);
        inverse[col]![c] = mul(inverse[col]![c]!, invPivot);
      }
    }
    // Eliminate other rows.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let c = 0; c < n; c++) {
        a[r]![c] = add(a[r]![c]!, mul(factor, a[col]![c]!));
        inverse[r]![c] = add(inverse[r]![c]!, mul(factor, inverse[col]![c]!));
      }
    }
  }
  return inverse;
}

// Split a buffer into k equal-length shards, padding the last with zeros.
// Returns shards plus the original byte length so the caller can trim on
// recombine.
export function splitIntoShards(data: Uint8Array, k: number): { shards: Uint8Array[]; originalLength: number } {
  const shardLen = Math.ceil(data.length / k);
  const padded = shardLen * k;
  const buf = new Uint8Array(padded);
  buf.set(data);
  const shards: Uint8Array[] = [];
  for (let i = 0; i < k; i++) {
    shards.push(buf.subarray(i * shardLen, (i + 1) * shardLen));
  }
  return { shards, originalLength: data.length };
}

export function recombineShards(shards: Uint8Array[], originalLength: number): Uint8Array {
  const shardLen = shards[0]?.length ?? 0;
  const out = new Uint8Array(shardLen * shards.length);
  for (let i = 0; i < shards.length; i++) {
    out.set(shards[i]!, i * shardLen);
  }
  return out.subarray(0, originalLength);
}
