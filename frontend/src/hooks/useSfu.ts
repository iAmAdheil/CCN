// useSfu — encapsulates the mediasoup-client lifecycle for the current room.
//
// The hook listens for the `room-mode` signal from the server and reacts:
//   - mode 'sfu': build Device + send/recv Transports, produce local tracks,
//     consume every existing producer + every future `sfu:new-producer`.
//   - mode 'mesh': tear everything down so the mesh path can take over.
//
// It returns the current mode, the count of active producers/consumers (for
// the diagnostics panel), and a map of remote MediaStreams keyed by the
// owning socket id — which Index.tsx merges into its room-user records.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { Consumer, Device, Producer, Transport } from 'mediasoup-client/types';
import {
  closeProducer,
  consumeProducer,
  createDevice,
  createRecvTransport,
  createSendTransport,
  listProducers,
  produceTrack,
  type RemoteProducer,
} from '@/lib/sfuClient';
import type { FrameCipher } from '@/lib/mediaE2EE/frameCipher';
import {
  applyReceiverTransform,
  applySenderTransform,
  getUnderlyingPc,
} from '@/lib/mediaE2EE/transforms';
import { AbrController, DEFAULT_LAYERS, type AbrSnapshot } from '@/lib/abr/abr';

export type RoomMode = 'mesh' | 'sfu';

export interface SfuStats {
  mode: RoomMode;
  producers: number;
  consumers: number;
  remoteStreams: Record<string, MediaStream>;
  abr: AbrSnapshot | null;
}

interface UseSfuOptions {
  socket: Socket | null;
  roomId: string | null;
  localStream: MediaStream | null;
  // Optional E2EE cipher. When provided, every produced sender and every
  // consumed receiver gets the corresponding transform attached so the SFU
  // sees opaque bytes only. The cipher's keyId is read at decrypt time so
  // a mid-session key rotation is transparent to the transform setup.
  e2eeCipher?: FrameCipher;
}

export function useSfu({ socket, roomId, localStream, e2eeCipher }: UseSfuOptions): SfuStats {
  const e2eeCipherRef = useRef<FrameCipher | undefined>(e2eeCipher);
  useEffect(() => { e2eeCipherRef.current = e2eeCipher; }, [e2eeCipher]);
  const [mode, setMode] = useState<RoomMode>('mesh');
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [producerCount, setProducerCount] = useState(0);
  const [consumerCount, setConsumerCount] = useState(0);

  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producersRef = useRef<Map<string, Producer>>(new Map());
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
  // consumerId -> producerSocketId, so consumer-closed events can clean up
  // the stream entry for the right peer.
  const consumerOwnersRef = useRef<Map<string, string>>(new Map());
  // ABR controller bound to the *video* sender. Audio doesn't get an ABR
  // loop (Opus is constant-bitrate-ish and the gain isn't worth the
  // complexity).
  const abrRef = useRef<AbrController | null>(null);
  const [abrSnap, setAbrSnap] = useState<AbrSnapshot | null>(null);

  // Listen for mode changes from the server.
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { roomName: string; mode: RoomMode; size: number }) => {
      if (data.roomName !== roomId) return;
      setMode(data.mode);
    };
    socket.on('room-mode', handler);
    return () => {
      socket.off('room-mode', handler);
    };
  }, [socket, roomId]);

  // Spin up / tear down SFU resources whenever mode or core inputs change.
  useEffect(() => {
    if (!socket || !roomId) return;
    if (mode !== 'sfu' || !localStream) {
      if (mode === 'mesh') teardown();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const device = await createDevice(socket, roomId);
        if (cancelled) return;
        deviceRef.current = device;

        const sendTransport = await createSendTransport(socket, roomId, device);
        if (cancelled) return;
        sendTransportRef.current = sendTransport;

        const recvTransport = await createRecvTransport(socket, roomId, device);
        if (cancelled) return;
        recvTransportRef.current = recvTransport;

        // Produce every local track. Each call hits the server-side
        // sfu:produce path via the transport's `produce` callback.
        for (const track of localStream.getTracks()) {
          if (cancelled) return;
          // Video gets simulcast: the client publishes 3 spatial layers and
          // the SFU forwards whichever the consumer's downlink supports.
          // Audio is single-stream — Opus already adapts internally and
          // simulcast adds no value.
          const isVideo = track.kind === 'video';
          const produceOpts = isVideo
            ? {
                encodings: DEFAULT_LAYERS.map((l) => ({
                  rid: l.rid,
                  active: true,
                  maxBitrate: l.initialMaxBitrate,
                  scaleResolutionDownBy: l.scaleResolutionDownBy,
                })),
                codecOptions: { videoGoogleStartBitrate: 600 },
              }
            : undefined;
          const producer = await produceTrack(sendTransport, track, produceOpts);
          producersRef.current.set(producer.id, producer);
          setProducerCount(producersRef.current.size);
          // Attach the E2EE encode transform to the underlying RTCRtpSender
          // so the SFU never sees plaintext frames. Falls back silently in
          // browsers that lack RTCRtpSender.transform.
          attachSenderTransform(sendTransport, track);
          // Bind the ABR controller to the video sender. Re-binds replace
          // any previous controller (start of fresh SFU session).
          if (isVideo) attachAbr(sendTransport, track);
          producer.on('trackended', () => {
            void closeProducer(socket, producer.id).catch(() => undefined);
            producersRef.current.delete(producer.id);
            setProducerCount(producersRef.current.size);
          });
        }

        // Catch up on producers that already exist in the room.
        const existing = await listProducers(socket, roomId);
        for (const remote of existing) {
          if (cancelled) return;
          await consumeRemote(remote);
        }
      } catch (err) {
        console.error('[useSfu] init failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, roomId, mode, localStream]);

  // Subscribe to producer notifications. Runs whenever the SFU path is
  // active; outside of SFU mode the no-op return keeps the hook idempotent.
  useEffect(() => {
    if (!socket || !roomId || mode !== 'sfu') return;
    const onNew = (data: RemoteProducer) => {
      void consumeRemote(data);
    };
    const onProducerClosed = (data: { producerSocketId: string; producerId: string }) => {
      // Find any consumer bound to this producer and clean up.
      for (const [consumerId, consumer] of consumersRef.current) {
        if (consumer.producerId === data.producerId) {
          try { consumer.close(); } catch { /* already closed */ }
          consumersRef.current.delete(consumerId);
          const owner = consumerOwnersRef.current.get(consumerId);
          consumerOwnersRef.current.delete(consumerId);
          if (owner) removeTrackFromStream(owner, consumer.track);
        }
      }
      setConsumerCount(consumersRef.current.size);
    };
    const onConsumerClosed = (data: { consumerId: string }) => {
      const consumer = consumersRef.current.get(data.consumerId);
      if (!consumer) return;
      try { consumer.close(); } catch { /* already closed */ }
      consumersRef.current.delete(data.consumerId);
      const owner = consumerOwnersRef.current.get(data.consumerId);
      consumerOwnersRef.current.delete(data.consumerId);
      if (owner) removeTrackFromStream(owner, consumer.track);
      setConsumerCount(consumersRef.current.size);
    };
    socket.on('sfu:new-producer', onNew);
    socket.on('sfu:producer-closed', onProducerClosed);
    socket.on('sfu:consumer-closed', onConsumerClosed);
    return () => {
      socket.off('sfu:new-producer', onNew);
      socket.off('sfu:producer-closed', onProducerClosed);
      socket.off('sfu:consumer-closed', onConsumerClosed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, roomId, mode]);

  function attachSenderTransform(sendTransport: Transport, track: MediaStreamTrack) {
    const cipher = e2eeCipherRef.current;
    if (!cipher) return;
    const pc = getUnderlyingPc(sendTransport);
    if (!pc) {
      console.warn('[useSfu] could not locate underlying PC to attach sender transform');
      return;
    }
    const sender = pc.getSenders().find((s) => s.track === track);
    if (!sender) return;
    applySenderTransform(sender, cipher);
  }

  function attachAbr(sendTransport: Transport, track: MediaStreamTrack) {
    const pc = getUnderlyingPc(sendTransport);
    if (!pc) {
      console.warn('[useSfu] could not locate underlying PC to attach ABR');
      return;
    }
    const sender = pc.getSenders().find((s) => s.track === track);
    if (!sender) return;
    // Tear down any previous controller before installing a fresh one (this
    // matters across SFU re-entries within the same session).
    if (abrRef.current) {
      abrRef.current.stop();
      abrRef.current = null;
    }
    const abr = new AbrController(sender, { intervalMs: 2_000 });
    abrRef.current = abr;
    // Re-publish current encoding ladder; produceTrack already passed the
    // initial encodings so this is a no-op on most paths but defensive against
    // mediasoup-client variants that strip them.
    void abr.applyInitialEncodings(true);
    abr.subscribe(setAbrSnap);
    abr.start();
  }

  function attachReceiverTransform(recvTransport: Transport, track: MediaStreamTrack) {
    const cipher = e2eeCipherRef.current;
    if (!cipher) return;
    const pc = getUnderlyingPc(recvTransport);
    if (!pc) {
      console.warn('[useSfu] could not locate underlying PC to attach receiver transform');
      return;
    }
    const receiver = pc.getReceivers().find((r) => r.track === track);
    if (!receiver) return;
    applyReceiverTransform(receiver, cipher, () => cipher.currentKeyId() ?? 0);
  }

  function removeTrackFromStream(socketId: string, track: MediaStreamTrack) {
    setRemoteStreams((prev) => {
      const stream = prev[socketId];
      if (!stream) return prev;
      try { stream.removeTrack(track); } catch { /* already gone */ }
      if (stream.getTracks().length === 0) {
        const next = { ...prev };
        delete next[socketId];
        return next;
      }
      return { ...prev };
    });
  }

  async function consumeRemote(remote: RemoteProducer) {
    if (!socket || !roomId) return;
    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;
    if (!device || !recvTransport) return;
    try {
      const consumer = await consumeProducer(socket, roomId, device, recvTransport, remote.producerId);
      consumersRef.current.set(consumer.id, consumer);
      consumerOwnersRef.current.set(consumer.id, remote.producerSocketId);
      setConsumerCount(consumersRef.current.size);
      // Attach the E2EE decode transform so the receiver gets plaintext
      // back. The transform reads the current cipher key at frame time, so
      // a mid-session key rotation works without reattaching.
      attachReceiverTransform(recvTransport, consumer.track);
      setRemoteStreams((prev) => {
        const existing = prev[remote.producerSocketId];
        const stream = existing ?? new MediaStream();
        stream.addTrack(consumer.track);
        return { ...prev, [remote.producerSocketId]: stream };
      });
      consumer.on('trackended', () => {
        consumersRef.current.delete(consumer.id);
        consumerOwnersRef.current.delete(consumer.id);
        setConsumerCount(consumersRef.current.size);
        removeTrackFromStream(remote.producerSocketId, consumer.track);
      });
    } catch (err) {
      console.warn('[useSfu] consume failed for', remote, err);
    }
  }

  function teardown() {
    if (abrRef.current) {
      abrRef.current.stop();
      abrRef.current = null;
    }
    setAbrSnap(null);
    for (const consumer of consumersRef.current.values()) {
      try { consumer.close(); } catch { /* already closed */ }
    }
    consumersRef.current.clear();
    consumerOwnersRef.current.clear();
    for (const producer of producersRef.current.values()) {
      try { producer.close(); } catch { /* already closed */ }
    }
    producersRef.current.clear();
    try { sendTransportRef.current?.close(); } catch { /* already closed */ }
    try { recvTransportRef.current?.close(); } catch { /* already closed */ }
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    deviceRef.current = null;
    setProducerCount(0);
    setConsumerCount(0);
    setRemoteStreams({});
  }

  // Clean up on unmount or roomId change.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [socket, roomId]);

  return useMemo(
    () => ({ mode, producers: producerCount, consumers: consumerCount, remoteStreams, abr: abrSnap }),
    [mode, producerCount, consumerCount, remoteStreams, abrSnap],
  );
}
