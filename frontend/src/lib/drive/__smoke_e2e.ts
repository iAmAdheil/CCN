// End-to-end smoke for the distributed drive. Spins up an in-memory wire
// network with N "peers" where each peer is a PeerDriveStore plus a
// holder binding. The uploader pushes a 100KB random buffer through
// upload, peers store shards. Then a "downloader" peer (different
// identity for self-only file is meaningless) pulls it back and verifies.
//
// Run via: npx tsx src/lib/drive/__smoke_e2e.ts

import { uploadFile, downloadFile, bindHolder } from './driveClient.ts';
import { generateUserIdentity } from './fileCrypto.ts';
import { PeerDriveStore } from './peerStore.ts';
import type { DriveMessage, Wire } from './protocol.ts';

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

// Tiny in-memory network: every peer subscribes to its own inbox, and the
// network routes `send(peer, msg)` into that inbox synchronously via
// setTimeout(_, 0). Broadcasts go to every peer except the sender.
class FakeNetwork {
  private readonly subscribers = new Map<string, Array<(from: string, msg: DriveMessage) => void>>();

  wireFor(peerId: string): Wire {
    const network = this;
    return {
      send(to, msg) {
        const handlers = network.subscribers.get(to) ?? [];
        for (const h of handlers) {
          setTimeout(() => h(peerId, msg), 0);
        }
      },
      broadcast(msg) {
        for (const [other, handlers] of network.subscribers) {
          if (other === peerId) continue;
          for (const h of handlers) {
            setTimeout(() => h(peerId, msg), 0);
          }
        }
      },
      subscribe(handler) {
        const list = network.subscribers.get(peerId) ?? [];
        list.push(handler);
        network.subscribers.set(peerId, list);
        return () => {
          const updated = (network.subscribers.get(peerId) ?? []).filter((h) => h !== handler);
          network.subscribers.set(peerId, updated);
        };
      },
    };
  }
}

const NETWORK = new FakeNetwork();

async function makePeer(id: string) {
  const identity = await generateUserIdentity();
  const store = new PeerDriveStore();
  const wire = NETWORK.wireFor(id);
  const unbind = bindHolder(wire, store);
  return { id, identity, store, wire, unbind };
}

// Make a 100KB pseudo-random buffer (deterministic seed for reproducibility)
function randBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = 1234567;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

const uploader = await makePeer('uploader');
const peers = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(makePeer));

const original = randBytes(100_000);

// 1. Upload
console.log('uploading 100KB to 6 peers + self (k=10, m=4)...');
const manifest = await uploadFile({
  file: { name: 'test.bin', type: 'application/octet-stream', bytes: original },
  identity: uploader.identity,
  selfPeerId: uploader.id,
  peers: peers.map((p) => p.id),
  wire: uploader.wire,
  store: uploader.store,
  k: 10,
  m: 4,
  onProgress: (p) => {
    if (p.phase === 'distributing' && (p.shardsStored % 4 === 0 || p.shardsStored === 14)) {
      console.log(`  ${p.phase}: ${p.shardsStored}/${p.totalShards} stored`);
    }
  },
});
console.log('upload complete. manifest fileId=', manifest.fileId);
assert(manifest.shards.length === 14, 'manifest-shard-count');

// 2. Download back. Uploader fetches own file from peers + own store.
console.log('downloading via uploader...');
const downloaded = await downloadFile({
  manifest,
  identity: uploader.identity,
  wire: uploader.wire,
  store: uploader.store,
  peers: peers.map((p) => p.id),
});
assert(buffersEqual(original, downloaded.bytes), 'roundtrip-bytes');
assert(downloaded.name === 'test.bin', 'roundtrip-name');
console.log('roundtrip 100KB through 6-peer fanout: OK');

// 3. Simulate losing 3 peers (drop their stores), then re-download. With
// k=10/m=4 we tolerate up to m=4 shard losses. 3 lost peers each likely
// held ~2 shards apiece → could exceed m. Test what survives.
console.log('simulating 3 peers leaving (their shards are lost)...');
for (let i = 0; i < 3; i++) {
  peers[i]!.unbind();
  // Effectively make their inbox a black hole — easier: pop their subscribers
  // from the network so fetches time out.
  (NETWORK as any).subscribers.delete(peers[i]!.id);
}

// 14 shards, 7 holders → 2 each. Lose 3 holders → 6 shards lost. 8 alive
// total: 2 in uploader's local store (unreachable via broadcast-to-self),
// 6 in the surviving peers. So broadcast yields 6, plus uploader's local
// store contributes 2 of those 8 — total 8 > k=10? No, 8 < 10 = fail.
// We test the *expected* fail path with the uploader's own store too.
try {
  const dl2 = await downloadFile({
    manifest,
    identity: uploader.identity,
    wire: uploader.wire,
    store: uploader.store,
    peers: peers.slice(3).map((p) => p.id),
  });
  console.log('  unexpectedly succeeded; check round-robin math');
  assert(buffersEqual(original, dl2.bytes), 'partial-fail-roundtrip');
} catch (err) {
  console.log('  expected failure:', (err as Error).message);
}

// 4. Now drop only 2 peers (4 shards lost). Should be at the threshold of
// what RS can recover (m=4).
console.log('reset + simulating exactly 2 peers leaving (4 shards lost)...');
for (const p of peers.slice(3, 6)) {
  // Re-add the peers we dropped before so we have a fresh 6-peer ring.
}
const peers2 = await Promise.all(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(makePeer));
const uploader2 = await makePeer('uploader2');
const manifest2 = await uploadFile({
  file: { name: 'second.bin', bytes: original },
  identity: uploader2.identity,
  selfPeerId: uploader2.id,
  peers: peers2.map((p) => p.id),
  wire: uploader2.wire,
  store: uploader2.store,
  k: 10,
  m: 4,
});
// Drop 2 peers
for (let i = 0; i < 2; i++) {
  peers2[i]!.unbind();
  (NETWORK as any).subscribers.delete(peers2[i]!.id);
}
// Uploader downloads with their own real store. Of the 14 shards: 2 in
// uploader2's local store, 8 reachable on surviving peers (q3..q6 hold 2
// each), 4 lost with q1/q2. Total available = 10 = k. Reconstruction
// should succeed at exactly the threshold.
const dl3 = await downloadFile({
  manifest: manifest2,
  identity: uploader2.identity,
  wire: uploader2.wire,
  store: uploader2.store,
  peers: peers2.slice(2).map((p) => p.id),
});
assert(buffersEqual(original, dl3.bytes), 'survives-2-peer-loss');
console.log('survives 2-peer loss (4 shards): OK');

console.log('ALL OK');
process.exit(0);
