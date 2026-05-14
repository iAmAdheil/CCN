// Vitest port of __smoke_dht.ts. Builds an in-memory mesh of nodes and
// exercises iterative lookup convergence.

import { describe, expect, it } from 'vitest';
import { KademliaNode } from './kademlia';
import type { DhtMessage, DhtTransport } from './protocol';
import { bytesToHex, bucketIndex, nodeIdFromString, xorDistance } from './nodeId';

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

describe('Kademlia', () => {
  it('derives stable node ids', async () => {
    const a = await nodeIdFromString('alice');
    const b = await nodeIdFromString('alice');
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('xor distance is symmetric and non-zero for different ids', async () => {
    const a = await nodeIdFromString('alice');
    const b = await nodeIdFromString('bob');
    const d = xorDistance(a, b);
    const d2 = xorDistance(b, a);
    expect(bytesToHex(d)).toBe(bytesToHex(d2));
    expect(bytesToHex(d)).not.toBe('00'.repeat(20));
  });

  it('bucketIndex stays within 0..159', async () => {
    const self = await nodeIdFromString('self');
    for (let i = 0; i < 50; i++) {
      const peer = await nodeIdFromString(`peer-${i}`);
      const idx = bucketIndex(self, peer);
      expect(idx).toBeGreaterThanOrEqual(-1);
      expect(idx).toBeLessThan(160);
    }
  });

  it('iterative findValue locates a value across a 6-node mesh', async () => {
    const wire = makeMesh();
    const N = 6;
    const nodes: KademliaNode[] = [];
    for (let i = 0; i < N; i++) {
      const handle = `node-${i}`;
      const node = await KademliaNode.create(handle, transportFor(wire, handle), { k: 4, alpha: 2 });
      node.start();
      nodes.push(node);
    }
    for (let i = 1; i < N; i++) {
      await nodes[i]!.addContact('node-0');
      await nodes[0]!.addContact(`node-${i}`);
    }
    for (let i = 1; i < N; i++) {
      await nodes[i]!.findNode('warmup');
    }

    const value = new TextEncoder().encode('payload-from-node-2');
    await nodes[2]!.store('payload-key-x', value);
    const found = await nodes[5]!.findValue('payload-key-x');
    expect(found).not.toBeNull();
    expect(new TextDecoder().decode(found!)).toBe('payload-from-node-2');

    const missing = await nodes[5]!.findValue('does-not-exist');
    expect(missing).toBeNull();

    for (const n of nodes) n.stop();
  });

  it('routing table is bounded by 160*k', async () => {
    const wire = makeMesh();
    const node = await KademliaNode.create('self', transportFor(wire, 'self'), { k: 2 });
    for (let i = 0; i < 20; i++) await node.addContact(`peer-${i}`);
    expect(node.table.size()).toBeLessThanOrEqual(160 * 2);
    const before = node.table.size();
    await node.addContact('peer-0');
    expect(node.table.size()).toBe(before);
  });
});
