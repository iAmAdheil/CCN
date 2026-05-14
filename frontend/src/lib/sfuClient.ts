// mediasoup-client wrapper. The frontend boots a Device against the room's
// Router, opens a send Transport + a recv Transport, then drives produce()
// for each local track and consume() for each remote producer.
//
// All RPCs go through the existing socket.io connection using ack callbacks.
// The server-side counterpart lives in backend/src/sfu/handlers.ts and uses
// the same event names.
import { Device } from 'mediasoup-client';
import type {
  Consumer,
  DtlsParameters,
  MediaKind,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
} from 'mediasoup-client/types';
import type { Socket } from 'socket.io-client';

type Ack<T> = { ok: true; data: T } | { ok: false; error: string };

type TransportInit = {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
};

function rpc<TReq, TRes>(socket: Socket, event: string, payload: TReq, timeoutMs = 8000): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.emit(event, payload, (response: Ack<TRes>) => {
      clearTimeout(timer);
      if (response.ok === true) {
        resolve(response.data);
      } else {
        reject(new Error(`${event}: ${response.error}`));
      }
    });
  });
}

export interface RemoteProducer {
  producerSocketId: string;
  producerId: string;
  kind: MediaKind;
}

export async function createDevice(socket: Socket, roomId: string): Promise<Device> {
  const { rtpCapabilities } = await rpc<{ roomId: string }, { rtpCapabilities: RtpCapabilities }>(
    socket,
    'sfu:get-rtp-capabilities',
    { roomId },
  );
  const device = new Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
  return device;
}

async function makeTransport(
  socket: Socket,
  roomId: string,
  device: Device,
  direction: 'send' | 'recv',
): Promise<Transport> {
  const params = await rpc<
    { roomId: string; direction: 'send' | 'recv' },
    TransportInit
  >(socket, 'sfu:create-transport', { roomId, direction });

  const transport =
    direction === 'send'
      ? device.createSendTransport(params as unknown as Parameters<Device['createSendTransport']>[0])
      : device.createRecvTransport(params as unknown as Parameters<Device['createRecvTransport']>[0]);

  // The DTLS handshake completes once the transport reaches "connecting" —
  // mediasoup-client fires `connect` exactly once, and we forward the DTLS
  // parameters to the server which calls transport.connect() on the router.
  transport.on('connect', ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, callback, errback) => {
    rpc(socket, 'sfu:connect-transport', { transportId: transport.id, dtlsParameters })
      .then(() => callback())
      .catch((err: Error) => errback(err));
  });

  // Only send transports emit `produce`. mediasoup-client wants us to call
  // back with the server-side producer id so it can build the local Producer
  // wrapper.
  if (direction === 'send') {
    transport.on(
      'produce',
      (
        { kind, rtpParameters }: { kind: MediaKind; rtpParameters: RtpParameters },
        callback: (data: { id: string }) => void,
        errback: (err: Error) => void,
      ) => {
        rpc<
          { transportId: string; kind: MediaKind; rtpParameters: RtpParameters },
          { id: string }
        >(socket, 'sfu:produce', { transportId: transport.id, kind, rtpParameters })
          .then(({ id }) => callback({ id }))
          .catch((err: Error) => errback(err));
      },
    );
  }

  return transport;
}

export function createSendTransport(socket: Socket, roomId: string, device: Device): Promise<Transport> {
  return makeTransport(socket, roomId, device, 'send');
}

export function createRecvTransport(socket: Socket, roomId: string, device: Device): Promise<Transport> {
  return makeTransport(socket, roomId, device, 'recv');
}

export interface ProduceOptions {
  encodings?: RTCRtpEncodingParameters[];
  codecOptions?: { videoGoogleStartBitrate?: number };
}

export async function produceTrack(
  transport: Transport,
  track: MediaStreamTrack,
  options: ProduceOptions = {},
): Promise<Producer> {
  const params: Parameters<Transport["produce"]>[0] = { track };
  if (options.encodings && options.encodings.length > 0) {
    params.encodings = options.encodings;
  }
  if (options.codecOptions) {
    params.codecOptions = options.codecOptions;
  }
  return transport.produce(params);
}

export async function consumeProducer(
  socket: Socket,
  roomId: string,
  device: Device,
  recvTransport: Transport,
  producerId: string,
): Promise<Consumer> {
  const data = await rpc<
    { roomId: string; producerId: string; rtpCapabilities: RtpCapabilities },
    { id: string; producerId: string; kind: MediaKind; rtpParameters: RtpParameters }
  >(socket, 'sfu:consume', {
    roomId,
    producerId,
    rtpCapabilities: device.rtpCapabilities,
  });

  const consumer = await recvTransport.consume({
    id: data.id,
    producerId: data.producerId,
    kind: data.kind,
    rtpParameters: data.rtpParameters,
  });

  // Server starts consumers paused so the client can bind the track to the
  // <video> element before frames start flowing. Resume now that we have it.
  await rpc<{ consumerId: string }, { resumed: true }>(socket, 'sfu:resume-consumer', {
    consumerId: consumer.id,
  });

  return consumer;
}

export async function listProducers(socket: Socket, roomId: string): Promise<RemoteProducer[]> {
  const { producers } = await rpc<{ roomId: string }, { producers: RemoteProducer[] }>(
    socket,
    'sfu:list-producers',
    { roomId },
  );
  return producers;
}

export async function closeProducer(socket: Socket, producerId: string): Promise<void> {
  await rpc(socket, 'sfu:close-producer', { producerId });
}
