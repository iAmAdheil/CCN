// Helpers for creating WebRtcTransports against a Router. Listen IPs and
// announced IP come from env so production deploys can route through the
// public address instead of leaking 127.0.0.1.
import type { Router, TransportListenIp, WebRtcTransport } from 'mediasoup/types';

function listenIps(): TransportListenIp[] {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP ?? '127.0.0.1';
  const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP;
  return [
    announcedIp
      ? { ip: listenIp, announcedIp }
      : { ip: listenIp },
  ];
}

export async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  const transport = await router.createWebRtcTransport({
    listenIps: listenIps(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
  return transport;
}

export interface TransportInitParams {
  id: string;
  iceParameters: WebRtcTransport['iceParameters'];
  iceCandidates: WebRtcTransport['iceCandidates'];
  dtlsParameters: WebRtcTransport['dtlsParameters'];
}

export function describeTransport(transport: WebRtcTransport): TransportInitParams {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}
