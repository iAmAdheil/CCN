// useDrive — distributed drive integration for the current room.
//
// Owns the user's identity keypair (ECDH for key wrap, ECDSA for manifest
// signing), the local PeerDriveStore, and the Wire that routes drive
// messages over the existing mesh DataChannels. v1 is mesh-only: when the
// room is in SFU mode the DCs are gone, and the drive becomes read-only
// against whatever manifests this peer already learned about.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  bindHolder,
  downloadFile as protocolDownload,
  uploadFile as protocolUpload,
  type UploadProgress,
} from '@/lib/drive/driveClient';
import { generateUserIdentity, type UserIdentity } from '@/lib/drive/fileCrypto';
import { PeerDriveStore } from '@/lib/drive/peerStore';
import type { DriveMessage, Wire } from '@/lib/drive/protocol';
import type { SignedManifest } from '@/lib/drive/manifest';
import { KademliaNode } from '@/lib/dht/kademlia';
import type { DhtMessage, DhtTransport } from '@/lib/dht/protocol';

export interface UseDriveOptions {
  selfPeerId: string | null;
  // Ref to the map of open RTCDataChannels keyed by peer id. Mutated in
  // place by Index.tsx as peers join / leave.
  dcsRef: MutableRefObject<Record<string, RTCDataChannel>>;
}

export interface DhtSnapshot {
  selfHex: string;
  handle: string;
  contacts: Array<{ idHex: string; handle: string; bucket: number }>;
  storageKeys: string[];
  bucketSizes: number[];
}

export interface DriveApi {
  identity: UserIdentity | null;
  ready: boolean;
  manifests: SignedManifest[];
  storeStats: { shards: number; manifests: number; bytes: number };
  dht: DhtSnapshot | null;
  upload: (file: File, opts?: { onProgress?: (p: UploadProgress) => void }) => Promise<SignedManifest>;
  download: (manifest: SignedManifest) => Promise<{ bytes: Uint8Array; name: string; contentType?: string }>;
  // Called by Index.tsx whenever a DC delivers a drive message.
  ingestRemote: (fromPeerId: string, msg: DriveMessage) => void;
}

// Stable, transport-agnostic key under which a shard's bytes live in the
// DHT. The hash domain — `shard:<fileId>:<index>` — buys some isolation
// from any future non-shard values that share the same DHT.
function shardKey(fileId: string, index: number): string {
  return `shard:${fileId}:${index}`;
}

export function useDrive({ selfPeerId, dcsRef }: UseDriveOptions): DriveApi {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [manifests, setManifests] = useState<SignedManifest[]>([]);
  const [storeStats, setStoreStats] = useState({ shards: 0, manifests: 0, bytes: 0 });
  const [dhtSnap, setDhtSnap] = useState<DhtSnapshot | null>(null);
  const storeRef = useRef<PeerDriveStore | null>(null);
  const subscribersRef = useRef<Set<(fromPeerId: string, msg: DriveMessage) => void>>(new Set());
  const dhtRef = useRef<KademliaNode | null>(null);
  // DHT message subscribers, kept distinct from drive's own subscribers so
  // bindHolder doesn't see DHT envelopes.
  const dhtSubscribersRef = useRef<Set<(from: string, msg: DhtMessage) => void>>(new Set());

  if (!storeRef.current) storeRef.current = new PeerDriveStore();

  // Generate identity once on first mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ident = await generateUserIdentity();
      if (!cancelled) setIdentity(ident);
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshState = useCallback(() => {
    const store = storeRef.current;
    if (!store) return;
    setManifests(store.allManifests().slice());
    setStoreStats(store.stats());
  }, []);

  // Wire backed by RTCDataChannels. Each peer's DC gets a JSON-wrapped
  // drive message under `type: 'drive'`. Broadcast iterates the dcs map.
  // dcsRef is a stable ref object from the parent — depending on it does
  // not cause re-creation, but keeps the linter happy.
  const wire = useMemo<Wire>(() => ({
    send(peerId, msg) {
      const dc = dcsRef.current[peerId];
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify({ type: 'drive', payload: msg }));
        } catch (err) {
          console.warn('[drive] dc.send failed for', peerId, err);
        }
      } else {
        // v1 limitation: drive needs an open DC. SFU mode tears down all
        // mesh DCs, so the drive becomes read-only for whatever manifests
        // were already cached.
        console.warn('[drive] no open DC for', peerId, '— message dropped');
      }
    },
    broadcast(msg) {
      for (const [peerId, dc] of Object.entries(dcsRef.current)) {
        if (dc.readyState !== 'open') continue;
        try {
          dc.send(JSON.stringify({ type: 'drive', payload: msg }));
        } catch (err) {
          console.warn('[drive] broadcast send failed for', peerId, err);
        }
      }
    },
    subscribe(handler) {
      subscribersRef.current.add(handler);
      return () => {
        subscribersRef.current.delete(handler);
      };
    },
  }), [dcsRef]);

  // Bind the holder side as soon as the identity is ready. The binding
  // wraps wire.subscribe internally and reacts to incoming drive ops.
  useEffect(() => {
    if (!identity) return;
    const store = storeRef.current!;
    const unbind = bindHolder(wire, store, {
      onManifest: () => refreshState(),
      onShardStored: (fileId, index, data) => {
        // Publish the shard into the DHT so downloaders can find it via
        // iterative FIND_VALUE instead of a broadcast flood.
        const node = dhtRef.current;
        if (!node) return;
        void node.store(shardKey(fileId, index), data).catch((e) => {
          console.warn('[drive] dht store failed', e);
        });
      },
    });
    refreshState();
    return () => {
      unbind();
    };
  }, [identity, wire, refreshState]);

  // Periodically refresh stats so the UI shows shard counts as they arrive.
  useEffect(() => {
    const handle = window.setInterval(refreshState, 1000);
    return () => window.clearInterval(handle);
  }, [refreshState]);

  // DHT transport: shares the chat DC with drive; messages are wrapped in
  // a `drive:dht` envelope so the existing dispatch path can fan them out.
  const dhtTransport = useMemo<DhtTransport>(() => ({
    send(toHandle, msg) {
      const dc = dcsRef.current[toHandle];
      if (!dc || dc.readyState !== 'open') return false;
      try {
        dc.send(JSON.stringify({ type: 'drive', payload: { op: 'drive:dht', payload: msg } }));
        return true;
      } catch (err) {
        console.warn('[dht] dc.send failed for', toHandle, err);
        return false;
      }
    },
    subscribe(handler) {
      dhtSubscribersRef.current.add(handler);
      return () => {
        dhtSubscribersRef.current.delete(handler);
      };
    },
  }), [dcsRef]);

  // Spin up the Kademlia node once selfPeerId is known. Tear it down and
  // rebuild on selfPeerId change (e.g. socket reconnect).
  useEffect(() => {
    if (!selfPeerId) return;
    let cancelled = false;
    void (async () => {
      const node = await KademliaNode.create(selfPeerId, dhtTransport);
      if (cancelled) return;
      node.start();
      dhtRef.current = node;
      setDhtSnap(node.snapshot());
    })();
    return () => {
      cancelled = true;
      dhtRef.current?.stop();
      dhtRef.current = null;
      setDhtSnap(null);
    };
  }, [selfPeerId, dhtTransport]);

  // Bootstrap the routing table from the current DC roster + refresh
  // periodically as peers join/leave. Re-runs whenever the DHT node is
  // (re)created — `dhtReady` flips false→true on creation and true→false
  // on teardown.
  const dhtReady = dhtSnap !== null;
  useEffect(() => {
    if (!dhtReady) return;
    const node = dhtRef.current;
    if (!node) return;
    const handle = window.setInterval(() => {
      const peers = Object.entries(dcsRef.current)
        .filter(([, dc]) => dc.readyState === 'open')
        .map(([id]) => id);
      void (async () => {
        for (const p of peers) await node.addContact(p);
      })();
      setDhtSnap(node.snapshot());
    }, 1500);
    return () => window.clearInterval(handle);
  }, [dcsRef, dhtReady]);

  // When a remote drive message arrives from the DC layer in Index.tsx,
  // fan it out to drive subscribers (and to the DHT for dht: envelopes).
  const ingestRemote = useCallback((fromPeerId: string, msg: DriveMessage) => {
    if (msg.op === 'drive:dht') {
      for (const handler of dhtSubscribersRef.current) handler(fromPeerId, msg.payload);
      return;
    }
    for (const handler of subscribersRef.current) {
      handler(fromPeerId, msg);
    }
  }, []);

  const upload = useCallback(
    async (file: File, options?: { onProgress?: (p: UploadProgress) => void }) => {
      if (!identity) throw new Error('drive identity not ready');
      if (!selfPeerId) throw new Error('not connected');
      const store = storeRef.current!;
      const buf = new Uint8Array(await file.arrayBuffer());
      // Available peer ids = all DCs currently open.
      const peers = Object.entries(dcsRef.current)
        .filter(([, dc]) => dc.readyState === 'open')
        .map(([id]) => id);
      const manifest = await protocolUpload({
        file: {
          name: file.name,
          ...(file.type ? { type: file.type } : {}),
          bytes: buf,
        },
        identity,
        selfPeerId,
        peers,
        wire,
        store,
        onProgress: options?.onProgress,
        onShardStored: (fileId, index, data) => {
          const node = dhtRef.current;
          if (!node) return;
          void node.store(shardKey(fileId, index), data).catch((e) => {
            console.warn('[drive] dht store failed', e);
          });
        },
      });
      refreshState();
      return manifest;
    },
    [identity, selfPeerId, wire, refreshState, dcsRef],
  );

  const download = useCallback(
    async (manifest: SignedManifest) => {
      if (!identity) throw new Error('drive identity not ready');
      const store = storeRef.current!;
      const peers = Object.entries(dcsRef.current)
        .filter(([, dc]) => dc.readyState === 'open')
        .map(([id]) => id);
      const result = await protocolDownload({
        manifest,
        identity,
        wire,
        store,
        peers,
        dhtFetch: async (fileId, index) => {
          const node = dhtRef.current;
          if (!node) return null;
          return node.findValue(shardKey(fileId, index));
        },
      });
      refreshState();
      return result;
    },
    [identity, wire, refreshState, dcsRef],
  );

  return {
    identity,
    ready: identity !== null,
    manifests,
    storeStats,
    dht: dhtSnap,
    upload,
    download,
    ingestRemote,
  };
}
