// Top-level distributed-drive orchestration. uploadFile and downloadFile
// implement the network-side of the storage protocol on top of a Wire
// abstraction so they can run over RTCDataChannel meshes, server relay, or
// in the future an SCTP-on-SFU path without coupling to the transport.

import {
  ReedSolomon,
  recombineShards,
  splitIntoShards,
} from '../erasure/reedSolomon.js';
import {
  bytesToB64,
  b64ToBytes,
  generateFileKey,
  openFile,
  sealFile,
  sha256,
  unwrapFileKey,
  wrapFileKey,
  type UserIdentity,
} from './fileCrypto.js';
import { newFileId, signManifest, verifyManifest, type ManifestBody, type SignedManifest, type ShardDescriptor } from './manifest.js';
import type { DriveMessage, Wire } from './protocol.js';
import { PeerDriveStore } from './peerStore.js';

const DEFAULT_K = 10;
const DEFAULT_M = 4;
const OFFER_TIMEOUT_MS = 6000;
const STORE_TIMEOUT_MS = 12000;
const FETCH_TIMEOUT_MS = 8000;

export interface UploadProgress {
  phase: 'sealing' | 'sharding' | 'distributing' | 'publishing' | 'done';
  shardsAccepted: number;
  shardsStored: number;
  totalShards: number;
}

export interface UploadOptions {
  file: { name: string; type?: string; bytes: Uint8Array };
  identity: UserIdentity;
  selfPeerId: string;
  peers: string[]; // other connected peer ids; uploader is `selfPeerId`
  wire: Wire;
  store: PeerDriveStore;
  k?: number;
  m?: number;
  onProgress?: (p: UploadProgress) => void;
  // Optional: invoked once per shard *after* it's been stored (locally or
  // remotely). useDrive uses this to publish the shard into the DHT so
  // downloaders can find it without a broadcast.
  onShardStored?: (fileId: string, index: number, data: Uint8Array) => void;
}

export interface DownloadOptions {
  manifest: SignedManifest;
  identity: UserIdentity;
  wire: Wire;
  store: PeerDriveStore;
  // Optional: peers known to be connected. If undefined the broadcast still
  // works, but downloader will time out faster if no one responds.
  peers?: string[];
  onProgress?: (shardsCollected: number, total: number) => void;
  // Optional DHT lookup. If provided, called BEFORE the broadcast fallback
  // for each missing shard. Resolving non-null short-circuits the
  // broadcast.
  dhtFetch?: (fileId: string, index: number) => Promise<Uint8Array | null>;
}

// ---------- helpers ----------

// Round-robin allocation of shard indices to peers. If `peers` is empty
// the uploader holds everything (degenerate single-peer case — file
// survives but is undistributed).
function allocateShards(totalShards: number, peerIds: string[]): string[] {
  if (peerIds.length === 0) return new Array(totalShards).fill('');
  const out: string[] = [];
  for (let i = 0; i < totalShards; i++) {
    out.push(peerIds[i % peerIds.length]!);
  }
  return out;
}

// ---------- upload ----------

export async function uploadFile(opts: UploadOptions): Promise<SignedManifest> {
  const k = opts.k ?? DEFAULT_K;
  const m = opts.m ?? DEFAULT_M;
  const rs = new ReedSolomon({ k, m });
  const totalShards = k + m;
  const fileId = newFileId();

  opts.onProgress?.({ phase: 'sealing', shardsAccepted: 0, shardsStored: 0, totalShards });
  const fileKey = await generateFileKey();
  const sealed = await sealFile(fileKey, opts.file.bytes);

  opts.onProgress?.({ phase: 'sharding', shardsAccepted: 0, shardsStored: 0, totalShards });
  const { shards, originalLength: sealedSize } = splitIntoShards(sealed.ciphertext, k);
  const paddedShardSize = shards[0]?.length ?? 0;
  // Materialize each shard as its own Uint8Array (splitIntoShards returns
  // subarrays; we need owned buffers because we'll send and hash them).
  const dataShards = shards.map((s) => new Uint8Array(s));
  const parityShards = rs.encode(dataShards);
  const allShards = [...dataShards, ...parityShards];

  const shardDescs: ShardDescriptor[] = await Promise.all(
    allShards.map(async (data, index) => ({
      index,
      size: data.length,
      hashB64: bytesToB64(await sha256(data)),
    })),
  );

  // Distribute. Include self in the allocation pool so a small room (e.g.
  // 2 peers) can still survive without overloading either side.
  opts.onProgress?.({ phase: 'distributing', shardsAccepted: 0, shardsStored: 0, totalShards });
  const allocationPool = [opts.selfPeerId, ...opts.peers];
  const allocations = allocateShards(totalShards, allocationPool);

  let accepted = 0;
  let stored = 0;
  const distribTasks = allShards.map(async (data, index) => {
    const holder = allocations[index]!;
    if (holder === opts.selfPeerId) {
      // Self-store, no wire roundtrip needed.
      opts.store.putShard({
        fileId,
        index,
        data,
        hashB64: shardDescs[index]!.hashB64,
        receivedAt: Date.now(),
      });
      accepted++;
      stored++;
      opts.onShardStored?.(fileId, index, data);
      opts.onProgress?.({ phase: 'distributing', shardsAccepted: accepted, shardsStored: stored, totalShards });
      return;
    }

    // Offer / accept
    const offerAck = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`offer ${index} -> ${holder}: timeout`));
      }, OFFER_TIMEOUT_MS);
      const unsub = opts.wire.subscribe((from, msg) => {
        if (from !== holder) return;
        if (msg.op !== 'drive:offer-ack') return;
        if (msg.fileId !== fileId || msg.index !== index) return;
        clearTimeout(timer);
        unsub();
        resolve(msg.accept);
      });
      opts.wire.send(holder, {
        op: 'drive:offer',
        fileId,
        index,
        size: data.length,
        hashB64: shardDescs[index]!.hashB64,
      });
    });
    if (!offerAck) throw new Error(`peer ${holder} declined shard ${index}`);
    accepted++;
    opts.onProgress?.({ phase: 'distributing', shardsAccepted: accepted, shardsStored: stored, totalShards });

    // Send the shard, await store-ack
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`store ${index} -> ${holder}: timeout`));
      }, STORE_TIMEOUT_MS);
      const unsub = opts.wire.subscribe((from, msg) => {
        if (from !== holder) return;
        if (msg.op !== 'drive:store-ack') return;
        if (msg.fileId !== fileId || msg.index !== index) return;
        clearTimeout(timer);
        unsub();
        if (msg.ok) {
          stored++;
          opts.onShardStored?.(fileId, index, data);
          opts.onProgress?.({ phase: 'distributing', shardsAccepted: accepted, shardsStored: stored, totalShards });
          resolve();
        } else {
          reject(new Error(`peer ${holder} failed to store shard ${index}: ${msg.reason ?? 'no reason'}`));
        }
      });
      opts.wire.send(holder, {
        op: 'drive:store',
        fileId,
        index,
        dataB64: bytesToB64(data),
      });
    });
  });

  // We need k of the k+m shards to survive. Use Promise.allSettled so a
  // single offline peer doesn't doom the whole upload.
  const results = await Promise.allSettled(distribTasks);
  const successes = results.filter((r) => r.status === 'fulfilled').length;
  if (successes < k) {
    throw new Error(`upload: only ${successes}/${totalShards} shards stored, need ${k}`);
  }

  // Build + sign manifest
  opts.onProgress?.({ phase: 'publishing', shardsAccepted: accepted, shardsStored: stored, totalShards });
  const body: ManifestBody = {
    version: 1,
    fileId,
    name: opts.file.name,
    size: opts.file.bytes.length,
    sealedSize,
    paddedShardSize,
    contentType: opts.file.type,
    k,
    m,
    iv: bytesToB64(sealed.iv),
    fileKeyWrapped: await wrapFileKey(fileKey, opts.identity.ecdh.publicKey),
    shards: shardDescs,
    uploaderSignPubKeyB64: opts.identity.sign.publicKeyB64,
    createdAt: Date.now(),
  };
  const manifest = await signManifest(body, opts.identity.sign.privateKey);

  // Also store the manifest locally so subsequent downloads have a copy.
  opts.store.putManifest(manifest);
  opts.wire.broadcast({ op: 'drive:manifest', manifest });

  opts.onProgress?.({ phase: 'done', shardsAccepted: accepted, shardsStored: stored, totalShards });
  return manifest;
}

// ---------- download ----------

export async function downloadFile(opts: DownloadOptions): Promise<{
  bytes: Uint8Array;
  name: string;
  contentType?: string;
}> {
  if (!(await verifyManifest(opts.manifest))) {
    throw new Error('manifest signature verification failed');
  }

  const { manifest } = opts;
  const totalShards = manifest.k + manifest.m;

  // Step 1: collect shards. Check local first; broadcast fetch for missing
  // ones in parallel.
  const collected: Array<Uint8Array | null> = new Array(totalShards).fill(null);
  let collectedCount = 0;

  for (let i = 0; i < totalShards; i++) {
    const local = opts.store.getShard(manifest.fileId, i);
    if (local) {
      collected[i] = local.data;
      collectedCount++;
    }
  }
  opts.onProgress?.(collectedCount, manifest.k);

  if (collectedCount >= manifest.k) {
    return finalize(manifest, collected, opts);
  }

  // For the remaining slots, fire broadcasts in parallel. We need k total;
  // pick a deterministic order so we don't waste fetches.
  const needed: number[] = [];
  for (let i = 0; i < totalShards && needed.length + collectedCount < manifest.k; i++) {
    if (!collected[i]) needed.push(i);
  }

  const fetchOne = async (index: number) => {
    // DHT first (iterative FIND_VALUE). If it returns the bytes, we skip
    // the broadcast — and we get O(log N) hops instead of O(N) flood.
    if (opts.dhtFetch) {
      try {
        const dhtData = await opts.dhtFetch(manifest.fileId, index);
        if (dhtData) {
          collected[index] = dhtData;
          collectedCount++;
          opts.onProgress?.(collectedCount, manifest.k);
          return;
        }
      } catch {
        // DHT lookup failed — fall through to broadcast.
      }
    }
    const data = await fetchShard(opts.wire, manifest.fileId, index);
    if (data) {
      collected[index] = data;
      collectedCount++;
      opts.onProgress?.(collectedCount, manifest.k);
    }
  };

  await Promise.all(needed.map((index) => fetchOne(index).catch(() => undefined)));

  // If still short, try the parity shards we didn't initially request.
  if (collectedCount < manifest.k) {
    const additional: number[] = [];
    for (let i = 0; i < totalShards && collectedCount + additional.length < manifest.k; i++) {
      if (!collected[i] && !needed.includes(i)) additional.push(i);
    }
    await Promise.all(additional.map((index) => fetchOne(index).catch(() => undefined)));
  }

  if (collectedCount < manifest.k) {
    throw new Error(`download: only ${collectedCount}/${manifest.k} shards available`);
  }

  return finalize(manifest, collected, opts);
}

async function fetchShard(
  wire: Wire,
  fileId: string,
  index: number,
): Promise<Uint8Array | null> {
  // Broadcasts a fetch and accepts the first response that actually carries
  // shard bytes. Peers that don't hold the shard respond with `dataB64: null`
  // — those don't count, so we ignore them and keep listening until either
  // a real holder replies or the timeout fires.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(null);
    }, FETCH_TIMEOUT_MS);
    const unsub = wire.subscribe((_from, msg) => {
      if (msg.op !== 'drive:fetch-response') return;
      if (msg.fileId !== fileId || msg.index !== index) return;
      if (!msg.dataB64) return; // peer doesn't have it, keep waiting
      clearTimeout(timer);
      unsub();
      resolve(b64ToBytes(msg.dataB64));
    });
    wire.broadcast({ op: 'drive:fetch', fileId, index });
  });
}

async function finalize(
  manifest: SignedManifest,
  collected: Array<Uint8Array | null>,
  opts: DownloadOptions,
): Promise<{ bytes: Uint8Array; name: string; contentType?: string }> {
  // Verify shard hashes for the ones we have.
  for (let i = 0; i < collected.length; i++) {
    const data = collected[i];
    if (!data) continue;
    const expected = manifest.shards[i]?.hashB64;
    const got = bytesToB64(await sha256(data));
    if (expected !== got) {
      // Drop tampered shard; reconstruction must use a different subset.
      collected[i] = null;
    }
  }

  const rs = new ReedSolomon({ k: manifest.k, m: manifest.m });
  const recovered = rs.reconstruct(collected);
  const sealed = recombineShards(recovered, manifest.sealedSize);

  const fileKey = await unwrapFileKey(manifest.fileKeyWrapped, opts.identity.ecdh);
  const plaintext = await openFile(fileKey, b64ToBytes(manifest.iv), sealed);

  if (plaintext.length !== manifest.size) {
    throw new Error(`download: decrypted size ${plaintext.length} != manifest.size ${manifest.size}`);
  }

  const result: { bytes: Uint8Array; name: string; contentType?: string } = {
    bytes: plaintext,
    name: manifest.name,
  };
  if (manifest.contentType !== undefined) {
    result.contentType = manifest.contentType;
  }
  return result;
}

// ---------- holder side ----------

// Bind a peer's drive store to the wire. The peer accepts offers, stores
// shards, serves fetches, and syncs manifests with newcomers. Returns an
// unsubscribe function.
export function bindHolder(
  wire: Wire,
  store: PeerDriveStore,
  options?: {
    onManifest?: (m: SignedManifest) => void;
    onShardStored?: (fileId: string, index: number, data: Uint8Array) => void;
  },
): () => void {
  return wire.subscribe(async (from, msg) => {
    switch (msg.op) {
      case 'drive:offer':
        // v1 accepts every offer. A future version could reject based on
        // disk-budget heuristics.
        wire.send(from, { op: 'drive:offer-ack', fileId: msg.fileId, index: msg.index, accept: true });
        return;
      case 'drive:store': {
        try {
          const data = b64ToBytes(msg.dataB64);
          store.putShard({
            fileId: msg.fileId,
            index: msg.index,
            data,
            hashB64: bytesToB64(await sha256(data)),
            receivedAt: Date.now(),
          });
          options?.onShardStored?.(msg.fileId, msg.index, data);
          wire.send(from, { op: 'drive:store-ack', fileId: msg.fileId, index: msg.index, ok: true });
        } catch (err) {
          wire.send(from, {
            op: 'drive:store-ack',
            fileId: msg.fileId,
            index: msg.index,
            ok: false,
            reason: (err as Error).message,
          });
        }
        return;
      }
      case 'drive:fetch': {
        const shard = store.getShard(msg.fileId, msg.index);
        wire.send(from, {
          op: 'drive:fetch-response',
          fileId: msg.fileId,
          index: msg.index,
          dataB64: shard ? bytesToB64(shard.data) : null,
        });
        return;
      }
      case 'drive:manifest':
        if (await verifyManifest(msg.manifest)) {
          store.putManifest(msg.manifest);
          options?.onManifest?.(msg.manifest);
        }
        return;
      case 'drive:manifest-sync-request':
        wire.send(from, { op: 'drive:manifest-sync-response', manifests: store.allManifests() });
        return;
      case 'drive:manifest-sync-response':
        for (const manifest of msg.manifests) {
          if (await verifyManifest(manifest)) {
            store.putManifest(manifest);
            options?.onManifest?.(manifest);
          }
        }
        return;
      default:
        return;
    }
  });
}
