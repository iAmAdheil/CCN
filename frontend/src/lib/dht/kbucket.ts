// Kademlia routing table: 160 buckets of size k, indexed by XOR distance
// from self. Each bucket is an LRU list — most-recently-seen at the tail.
//
// Replacement policy: when a bucket is full and we hear from a new node,
// we don't auto-evict. Instead the new node sits in a "candidate" slot
// that promotes only if we discover an existing node has gone stale.
// This is Kademlia's defense against malicious nodes flooding the table.
// Our toy version simplifies: drop new nodes when full, mark old ones as
// stale on PING failures from kademlia.ts.

import { NODE_ID_BITS, bucketIndex, type NodeId } from "./nodeId.js";

export interface Contact {
  id: NodeId;
  /** Wire-level handle the transport uses to address this node. */
  handle: string;
  lastSeen: number;
}

export class RoutingTable {
  private readonly buckets: Contact[][];

  constructor(
    public readonly self: NodeId,
    public readonly k: number = 8,
  ) {
    this.buckets = new Array(NODE_ID_BITS);
    for (let i = 0; i < NODE_ID_BITS; i++) this.buckets[i] = [];
  }

  // Record a sighting of `contact`. Returns true if the contact is new to
  // the table, false if it was already present.
  observe(contact: Omit<Contact, "lastSeen"> & Partial<Pick<Contact, "lastSeen">>): boolean {
    if (sameId(contact.id, this.self)) return false;
    const idx = bucketIndex(this.self, contact.id);
    if (idx < 0) return false;
    const bucket = this.buckets[idx];
    const now = contact.lastSeen ?? Date.now();
    const existingIdx = bucket.findIndex((c) => c.handle === contact.handle || sameId(c.id, contact.id));
    if (existingIdx >= 0) {
      // Move to tail (most-recently seen).
      const [existing] = bucket.splice(existingIdx, 1);
      existing.lastSeen = now;
      bucket.push(existing);
      return false;
    }
    if (bucket.length >= this.k) {
      // Toy policy: drop the new contact (real Kademlia pings the head and
      // evicts only on no-response).
      return false;
    }
    bucket.push({ id: contact.id, handle: contact.handle, lastSeen: now });
    return true;
  }

  remove(handle: string): boolean {
    for (const bucket of this.buckets) {
      const idx = bucket.findIndex((c) => c.handle === handle);
      if (idx >= 0) {
        bucket.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  size(): number {
    let n = 0;
    for (const b of this.buckets) n += b.length;
    return n;
  }

  bucketSizes(): number[] {
    return this.buckets.map((b) => b.length);
  }

  // Return up to `count` contacts closest to `target`, sorted by ascending
  // XOR distance. The walk starts at the bucket `target` would belong in
  // and fans outward (toward the bucket of self).
  closest(target: NodeId, count = this.k): Contact[] {
    const all: Contact[] = [];
    for (const bucket of this.buckets) {
      for (const c of bucket) all.push(c);
    }
    all.sort((a, b) => byteCmp(xor(a.id, target), xor(b.id, target)));
    return all.slice(0, count);
  }

  allContacts(): Contact[] {
    const out: Contact[] = [];
    for (const bucket of this.buckets) {
      for (const c of bucket) out.push(c);
    }
    return out;
  }
}

function sameId(a: NodeId, b: NodeId): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function xor(a: NodeId, b: NodeId): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function byteCmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}
