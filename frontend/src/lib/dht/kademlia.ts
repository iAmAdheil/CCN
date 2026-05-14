// Toy Kademlia node. Owns the routing table, dispatches messages, and runs
// iterative FIND_NODE / FIND_VALUE lookups with parallel α-fanout.
//
// Bootstrap model: callers explicitly `addContact(handle)` for peers they
// already know about (typically from the room roster). The DHT then
// expands its view via FIND_NODE / find-node-response.
//
// What this DOES NOT do compared to the real protocol:
//   - No periodic bucket refresh.
//   - No iterative STORE — we just send to the K closest known contacts at
//     STORE time, no bucket-walk to find better candidates first.
//   - No "candidate slot" eviction policy on full buckets — we drop the
//     newcomer instead of pinging the head.
//   - No expiry on stored values.
// Those are easy to add and are flagged in the README. The point here is to
// demonstrate XOR routing + iterative lookup convergence, not to ship
// Kademlia 1:1.

import { RoutingTable, type Contact } from "./kbucket.js";
import {
  bucketIndex,
  bytesToHex,
  hexToBytes,
  isNodeId,
  keyFromString,
  nodeIdFromString,
  type NodeId,
} from "./nodeId.js";
import type { DhtMessage, DhtTransport } from "./protocol.js";

const ALPHA = 3; // parallel queries per round
const REQ_TIMEOUT_MS = 4000;

interface PendingRequest {
  resolve: (msg: DhtMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface KademliaOptions {
  k?: number;
  alpha?: number;
  requestTimeoutMs?: number;
}

export class KademliaNode {
  readonly id: NodeId;
  readonly handle: string;
  readonly table: RoutingTable;
  private readonly transport: DhtTransport;
  private readonly storage = new Map<string, Uint8Array>(); // hex(key) -> value bytes
  private readonly pending = new Map<string, PendingRequest>(); // rid -> waiter
  private readonly opts: Required<KademliaOptions>;
  private nextRid = 1;
  private unsubscribe: (() => void) | null = null;

  constructor(self: { id: NodeId; handle: string }, transport: DhtTransport, opts: KademliaOptions = {}) {
    if (!isNodeId(self.id)) throw new Error("KademliaNode: invalid id");
    this.id = self.id;
    this.handle = self.handle;
    this.transport = transport;
    this.opts = {
      k: opts.k ?? 8,
      alpha: opts.alpha ?? ALPHA,
      requestTimeoutMs: opts.requestTimeoutMs ?? REQ_TIMEOUT_MS,
    };
    this.table = new RoutingTable(self.id, this.opts.k);
  }

  static async create(handle: string, transport: DhtTransport, opts: KademliaOptions = {}): Promise<KademliaNode> {
    const id = await nodeIdFromString(handle);
    return new KademliaNode({ id, handle }, transport, opts);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.subscribe((fromHandle, msg) => {
      void this.handleMessage(fromHandle, msg).catch((err) => {
        console.warn("[dht] handleMessage failed", err);
      });
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  // External: announce a contact this node has learned about. Returns true
  // if the contact was new to the routing table.
  async addContact(handle: string): Promise<boolean> {
    if (handle === this.handle) return false;
    const id = await nodeIdFromString(handle);
    return this.table.observe({ id, handle });
  }

  removeContact(handle: string): boolean {
    return this.table.remove(handle);
  }

  // External: STORE a value at the K closest known contacts (single round,
  // no further iteration). Returns the number of acks received.
  async store(keyText: string, value: Uint8Array): Promise<number> {
    const key = await keyFromString(keyText);
    const keyHex = bytesToHex(key);
    // Always self-store too — we may be the closest.
    this.storage.set(keyHex, value);
    const targets = this.table.closest(key, this.opts.k);
    let acks = 1; // self
    await Promise.all(
      targets.map(async (c) => {
        try {
          const reply = await this.request<Extract<DhtMessage, { op: "dht:store-ack" }>>(
            c.handle,
            (rid) => ({
              op: "dht:store",
              rid,
              fromIdHex: bytesToHex(this.id),
              keyHex,
              valueB64: bytesToB64(value),
            }),
            "dht:store-ack",
          );
          if (reply.ok) acks++;
        } catch {
          // Peer didn't respond; not fatal.
        }
      }),
    );
    return acks;
  }

  // External: iterative FIND_VALUE. Returns the value bytes if any node has
  // them, or null if exhausted.
  async findValue(keyText: string): Promise<Uint8Array | null> {
    const key = await keyFromString(keyText);
    const keyHex = bytesToHex(key);
    const local = this.storage.get(keyHex);
    if (local) return local;
    const result = await this.iterativeFind(key, "value");
    return result.value;
  }

  // External: iterative FIND_NODE. Returns the K closest contacts the
  // network knows about (including any newly-discovered ones added to the
  // routing table during the walk).
  async findNode(targetText: string): Promise<Contact[]> {
    const target = await keyFromString(targetText);
    const result = await this.iterativeFind(target, "node");
    return result.closest;
  }

  // External diagnostics for the UI.
  snapshot(): {
    selfHex: string;
    handle: string;
    contacts: Array<{ idHex: string; handle: string; bucket: number }>;
    storageKeys: string[];
    bucketSizes: number[];
  } {
    const contacts = this.table.allContacts().map((c) => ({
      idHex: bytesToHex(c.id),
      handle: c.handle,
      bucket: bucketIndexOrZero(this.id, c.id),
    }));
    return {
      selfHex: bytesToHex(this.id),
      handle: this.handle,
      contacts,
      storageKeys: Array.from(this.storage.keys()),
      bucketSizes: this.table.bucketSizes(),
    };
  }

  // ---- internals ----

  private async iterativeFind(
    target: NodeId,
    mode: "node" | "value",
  ): Promise<{ value: Uint8Array | null; closest: Contact[] }> {
    type Cand = Contact & { queried: boolean };
    const seen = new Set<string>();
    const candidates: Cand[] = [];
    for (const c of this.table.closest(target, this.opts.k)) {
      candidates.push({ ...c, queried: false });
      seen.add(c.handle);
    }
    if (candidates.length === 0) return { value: null, closest: [] };

    const targetHex = bytesToHex(target);
    let value: Uint8Array | null = null;

    for (let round = 0; round < 16; round++) {
      // Pick up to α unqueried candidates closest to target.
      candidates.sort((a, b) => byteCmp(xor(a.id, target), xor(b.id, target)));
      const batch = candidates.filter((c) => !c.queried).slice(0, this.opts.alpha);
      if (batch.length === 0) break;

      const replies = await Promise.allSettled(
        batch.map((c) => {
          c.queried = true;
          return mode === "value"
            ? this.request<Extract<DhtMessage, { op: "dht:find-value-response" }>>(
                c.handle,
                (rid) => ({
                  op: "dht:find-value",
                  rid,
                  fromIdHex: bytesToHex(this.id),
                  keyHex: targetHex,
                }),
                "dht:find-value-response",
              )
            : this.request<Extract<DhtMessage, { op: "dht:find-node-response" }>>(
                c.handle,
                (rid) => ({
                  op: "dht:find-node",
                  rid,
                  fromIdHex: bytesToHex(this.id),
                  targetHex,
                }),
                "dht:find-node-response",
              );
        }),
      );

      let learnedNew = false;
      for (const r of replies) {
        if (r.status !== "fulfilled") continue;
        const reply = r.value;
        if (mode === "value" && reply.op === "dht:find-value-response" && reply.valueB64) {
          value = b64ToBytes(reply.valueB64);
          break;
        }
        for (const c of reply.contacts) {
          if (seen.has(c.handle)) continue;
          if (c.handle === this.handle) continue;
          const id = hexToBytes(c.idHex);
          this.table.observe({ id, handle: c.handle });
          candidates.push({ id, handle: c.handle, queried: false, lastSeen: Date.now() });
          seen.add(c.handle);
          learnedNew = true;
        }
      }
      if (value) break;
      if (!learnedNew) break; // no new candidates → converged.
    }

    return { value, closest: candidates.slice(0, this.opts.k).map(({ queried: _q, ...c }) => c) };
  }

  // Generic request/response wrapper. Times out after `requestTimeoutMs`.
  private request<TReply extends DhtMessage>(
    handle: string,
    build: (rid: string) => DhtMessage,
    expectedOp: TReply["op"],
  ): Promise<TReply> {
    const rid = `${this.handle}-${this.nextRid++}`;
    const msg = build(rid);
    return new Promise<TReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`${expectedOp}: timeout`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(rid, {
        resolve: (got) => {
          if (got.op !== expectedOp) {
            this.pending.delete(rid);
            reject(new Error(`${expectedOp}: got ${got.op}`));
            return;
          }
          this.pending.delete(rid);
          resolve(got as TReply);
        },
        timer,
      });
      const sent = this.transport.send(handle, msg);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(new Error(`${expectedOp}: send failed`));
      }
    });
  }

  private async handleMessage(fromHandle: string, msg: DhtMessage): Promise<void> {
    // Every interaction adds the sender to our routing table.
    if ("fromIdHex" in msg && fromHandle !== this.handle) {
      try {
        const id = hexToBytes(msg.fromIdHex);
        if (isNodeId(id)) this.table.observe({ id, handle: fromHandle });
      } catch {
        /* malformed id */
      }
    }

    switch (msg.op) {
      case "dht:ping":
        this.transport.send(fromHandle, {
          op: "dht:pong",
          rid: msg.rid,
          fromIdHex: bytesToHex(this.id),
        });
        return;
      case "dht:find-node": {
        const target = hexToBytes(msg.targetHex);
        const closest = this.table.closest(target, this.opts.k);
        this.transport.send(fromHandle, {
          op: "dht:find-node-response",
          rid: msg.rid,
          fromIdHex: bytesToHex(this.id),
          contacts: closest.map((c) => ({ idHex: bytesToHex(c.id), handle: c.handle })),
        });
        return;
      }
      case "dht:find-value": {
        const key = hexToBytes(msg.keyHex);
        const local = this.storage.get(msg.keyHex);
        const closest = this.table.closest(key, this.opts.k);
        this.transport.send(fromHandle, {
          op: "dht:find-value-response",
          rid: msg.rid,
          fromIdHex: bytesToHex(this.id),
          valueB64: local ? bytesToB64(local) : null,
          contacts: closest.map((c) => ({ idHex: bytesToHex(c.id), handle: c.handle })),
        });
        return;
      }
      case "dht:store": {
        try {
          this.storage.set(msg.keyHex, b64ToBytes(msg.valueB64));
          this.transport.send(fromHandle, {
            op: "dht:store-ack",
            rid: msg.rid,
            fromIdHex: bytesToHex(this.id),
            ok: true,
          });
        } catch {
          this.transport.send(fromHandle, {
            op: "dht:store-ack",
            rid: msg.rid,
            fromIdHex: bytesToHex(this.id),
            ok: false,
          });
        }
        return;
      }
      case "dht:pong":
      case "dht:find-node-response":
      case "dht:find-value-response":
      case "dht:store-ack": {
        const waiter = this.pending.get(msg.rid);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
        return;
      }
    }
  }
}

function bytesToB64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  // Node fallback for tests.
  return Buffer.from(bytes).toString("base64");
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
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

function bucketIndexOrZero(self: NodeId, target: NodeId): number {
  try {
    return bucketIndex(self, target);
  } catch {
    return 0;
  }
}
