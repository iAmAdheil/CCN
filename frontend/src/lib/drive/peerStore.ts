// Per-peer local shard storage. Each peer in the room holds an in-memory
// Map of shard bytes keyed by (fileId, index). Storage is ephemeral — a
// peer reload drops everything. Persistence to IndexedDB is a Tier 3
// follow-up; v1 demonstrates the algorithm, not durability.
//
// The store also tracks which manifests this peer has heard about so a
// newly-joined peer can sync the directory without contacting the
// uploader directly.
import type { SignedManifest } from './manifest.js';

export interface StoredShard {
  fileId: string;
  index: number;
  data: Uint8Array;
  hashB64: string;
  receivedAt: number;
}

function shardKey(fileId: string, index: number): string {
  return `${fileId}:${index}`;
}

export class PeerDriveStore {
  private readonly shards = new Map<string, StoredShard>();
  private readonly manifests = new Map<string, SignedManifest>(); // fileId -> manifest

  putShard(shard: StoredShard): void {
    this.shards.set(shardKey(shard.fileId, shard.index), shard);
  }

  getShard(fileId: string, index: number): StoredShard | undefined {
    return this.shards.get(shardKey(fileId, index));
  }

  removeShard(fileId: string, index: number): boolean {
    return this.shards.delete(shardKey(fileId, index));
  }

  putManifest(manifest: SignedManifest): void {
    this.manifests.set(manifest.fileId, manifest);
  }

  getManifest(fileId: string): SignedManifest | undefined {
    return this.manifests.get(fileId);
  }

  allManifests(): SignedManifest[] {
    return Array.from(this.manifests.values());
  }

  removeManifest(fileId: string): boolean {
    return this.manifests.delete(fileId);
  }

  shardsHeldForFile(fileId: string): StoredShard[] {
    const out: StoredShard[] = [];
    for (const s of this.shards.values()) {
      if (s.fileId === fileId) out.push(s);
    }
    return out;
  }

  stats(): { shards: number; manifests: number; bytes: number } {
    let bytes = 0;
    for (const s of this.shards.values()) bytes += s.data.byteLength;
    return { shards: this.shards.size, manifests: this.manifests.size, bytes };
  }
}
