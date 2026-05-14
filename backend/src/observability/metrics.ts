// Prometheus metrics. Single Registry; per-feature gauges + counters
// declared up-front so they're discoverable from one file.
//
// We don't pull in prom-client's collectDefaultMetrics() helper —
// process.cpu/memory are nice but balloon the surface area. Add later if
// needed via a flag.

import { Counter, Gauge, Registry } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'socket-webrtc-backend' });

// --- room state ---
export const gaugeRooms = new Gauge({
  name: 'vc_rooms_total',
  help: 'Number of active rooms',
  registers: [registry],
});

export const gaugePeers = new Gauge({
  name: 'vc_peers_total',
  help: 'Number of connected sockets',
  registers: [registry],
});

export const gaugeRoomSize = new Gauge({
  name: 'vc_room_size',
  help: 'Number of peers in a room',
  labelNames: ['room'] as const,
  registers: [registry],
});

export const gaugeRoomMode = new Gauge({
  name: 'vc_room_mode',
  help: '1 for the active mode of a room (mesh|sfu)',
  labelNames: ['room', 'mode'] as const,
  registers: [registry],
});

// --- SFU ---
export const gaugeRouters = new Gauge({
  name: 'vc_sfu_routers_total',
  help: 'Number of active mediasoup routers',
  registers: [registry],
});

export const gaugeProducers = new Gauge({
  name: 'vc_sfu_producers_total',
  help: 'Total active producers across all rooms',
  registers: [registry],
});

export const gaugeConsumers = new Gauge({
  name: 'vc_sfu_consumers_total',
  help: 'Total active consumers across all rooms',
  registers: [registry],
});

export const gaugeSfuEgressBps = new Gauge({
  name: 'vc_sfu_egress_bps',
  help: 'Aggregate SFU egress bitrate (bits per second), sampled every 5s',
  registers: [registry],
});

export const gaugeSfuIngressBps = new Gauge({
  name: 'vc_sfu_ingress_bps',
  help: 'Aggregate SFU ingress bitrate (bits per second), sampled every 5s',
  registers: [registry],
});

// --- socket events ---
export const counterSocketEvents = new Counter({
  name: 'vc_socket_events_total',
  help: 'Number of socket.io events processed by event name',
  labelNames: ['event'] as const,
  registers: [registry],
});

// --- auth ---
export const counterMagicLinksSent = new Counter({
  name: 'vc_auth_magic_links_sent_total',
  help: 'Magic-link emails attempted',
  labelNames: ['result'] as const, // 'ok' | 'error'
  registers: [registry],
});

export const counterRedemptions = new Counter({
  name: 'vc_auth_redemptions_total',
  help: 'Magic-link redemption attempts',
  labelNames: ['result'] as const, // 'ok' | 'expired' | 'replay' | 'invalid'
  registers: [registry],
});
