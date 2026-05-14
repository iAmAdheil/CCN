// npx tsx src/lib/dht/__smoke_dht.ts
// Builds an in-memory mesh of N Kademlia nodes and exercises the lookup
// algorithm. The transport is direct method dispatch (no socket.io / DC).

import { KademliaNode } from "./kademlia.js";
import type { DhtMessage, DhtTransport } from "./protocol.js";
import { bytesToHex, bucketIndex, nodeIdFromString, xorDistance } from "./nodeId.js";

interface Wire {
  inbox: Map<string, (from: string, msg: DhtMessage) => void>;
}

function makeMesh(): Wire {
  return { inbox: new Map() };
}

function transportFor(wire: Wire, handle: string): DhtTransport {
  return {
    send(toHandle, msg) {
      const recv = wire.inbox.get(toHandle);
      if (!recv) return false;
      // Deliver asynchronously so the call stack unwinds.
      queueMicrotask(() => recv(handle, msg));
      return true;
    },
    subscribe(handler) {
      wire.inbox.set(handle, handler);
      return () => {
        if (wire.inbox.get(handle) === handler) wire.inbox.delete(handle);
      };
    },
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("  PASS", name);
  } else {
    fail++;
    console.error("  FAIL", name);
  }
}

console.log("Kademlia DHT smoke");

// ---- 1. NodeId derivation is stable + xor metric works.
{
  const a = await nodeIdFromString("alice");
  const b = await nodeIdFromString("alice");
  check("nodeId is deterministic", bytesToHex(a) === bytesToHex(b));

  const c = await nodeIdFromString("bob");
  const d = xorDistance(a, c);
  const d2 = xorDistance(c, a);
  check("xor symmetric", bytesToHex(d) === bytesToHex(d2));
  check("xor is non-zero for different ids", bytesToHex(d) !== "00".repeat(20));
}

// ---- 2. bucketIndex spans 0..159.
{
  const self = await nodeIdFromString("self");
  let sawNonZero = false;
  for (let i = 0; i < 50; i++) {
    const peer = await nodeIdFromString(`peer-${i}`);
    const idx = bucketIndex(self, peer);
    if (idx > 0) sawNonZero = true;
    if (idx < -1 || idx >= 160) {
      check(`bucketIndex range for peer-${i}`, false);
      break;
    }
  }
  check("bucketIndex produces non-zero across random peers", sawNonZero);
}

// ---- 3. 6-node mesh: every node bootstrapped from one peer can find
// the value stored at any node via iterative findValue.
{
  const wire = makeMesh();
  const N = 6;
  const nodes: KademliaNode[] = [];
  for (let i = 0; i < N; i++) {
    const handle = `node-${i}`;
    const node = await KademliaNode.create(handle, transportFor(wire, handle), { k: 4, alpha: 2 });
    node.start();
    nodes.push(node);
  }
  // Bootstrap: each node knows about node-0 only (real-world hub).
  for (let i = 1; i < N; i++) {
    await nodes[i].addContact("node-0");
    await nodes[0].addContact(`node-${i}`);
  }
  // Run a findNode from each node toward each other node. The routing
  // tables should fill out as a side effect.
  for (let i = 1; i < N; i++) {
    await nodes[i].findNode("warmup");
  }

  // Now node-2 stores a value, and node-5 should be able to locate it.
  const value = new TextEncoder().encode("hello-from-node-2");
  const acks = await nodes[2].store("payload-key-x", value);
  check("store returned acks", acks > 0);

  const found = await nodes[5].findValue("payload-key-x");
  check(
    "node-5 found value via iterative lookup",
    found !== null && new TextDecoder().decode(found) === "hello-from-node-2",
  );

  // node-5 lookup of an unknown key returns null.
  const missing = await nodes[5].findValue("does-not-exist");
  check("findValue returns null when key absent", missing === null);

  for (const n of nodes) n.stop();
}

// ---- 4. Routing-table observation idempotent + size bounded.
{
  const wire = makeMesh();
  const node = await KademliaNode.create("self", transportFor(wire, "self"), { k: 2 });
  for (let i = 0; i < 20; i++) {
    await node.addContact(`peer-${i}`);
  }
  const total = node.table.size();
  check("table size never exceeds 160 * k", total <= 160 * 2);

  // Re-observing an existing peer doesn't grow the table.
  const before = node.table.size();
  await node.addContact("peer-0");
  await node.addContact("peer-0");
  check("re-observation idempotent", node.table.size() === before);
}

// ---- 5. closest() returns sorted-by-distance results.
{
  const wire = makeMesh();
  const self = await KademliaNode.create("self", transportFor(wire, "self"), { k: 8 });
  for (let i = 0; i < 30; i++) await self.addContact(`p-${i}`);
  const target = await nodeIdFromString("target");
  const closest = self.table.closest(target, 5);
  // Verify ascending distance.
  let prev: Uint8Array | null = null;
  let ascending = true;
  for (const c of closest) {
    const d = xorDistance(c.id, target);
    if (prev) {
      // Compare prev <= d.
      let cmp = 0;
      for (let i = 0; i < d.length; i++) {
        if (prev[i] < d[i]) { cmp = -1; break; }
        if (prev[i] > d[i]) { cmp = 1; break; }
      }
      if (cmp > 0) ascending = false;
    }
    prev = d;
  }
  check("closest sorted by xor distance", ascending);
  check("closest length capped", closest.length === 5);
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
