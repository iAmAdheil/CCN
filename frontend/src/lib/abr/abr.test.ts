// Vitest port of __smoke_abr.ts — exercises the AIMD policy.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbrController, DEFAULT_LAYERS } from './abr';

interface FakeSenderState {
  bytesSent: number;
  packetsSent: number;
  packetsLost: number;
  available: number | null;
  encodings: Array<{ rid: string; active: boolean; maxBitrate: number; scaleResolutionDownBy?: number }>;
  setParametersCalls: number;
}

function makeSender(state: FakeSenderState): RTCRtpSender {
  return {
    track: null,
    transport: null,
    getStats: async () => {
      const entries: unknown[] = [
        { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
        {
          type: 'candidate-pair',
          id: 'P0',
          nominated: true,
          state: 'succeeded',
          availableOutgoingBitrate: state.available ?? undefined,
        },
        {
          type: 'outbound-rtp',
          id: 'O0',
          kind: 'video',
          isRemote: false,
          bytesSent: state.bytesSent,
          packetsSent: state.packetsSent,
        },
        { type: 'remote-inbound-rtp', id: 'RI0', kind: 'video', packetsLost: state.packetsLost },
      ];
      return {
        forEach: (cb: (v: unknown) => void) => entries.forEach(cb),
      } as unknown as RTCStatsReport;
    },
    getParameters: () =>
      ({
        transactionId: 'tx',
        encodings: state.encodings.map((e) => ({ ...e })),
        rtcp: {},
        headerExtensions: [],
        codecs: [],
        degradationPreference: 'balanced',
      } as unknown as RTCRtpSendParameters),
    setParameters: async (params: RTCRtpSendParameters) => {
      state.setParametersCalls++;
      if (Array.isArray(params.encodings)) {
        state.encodings = params.encodings.map((e) => ({
          rid: e.rid ?? '',
          active: e.active ?? true,
          maxBitrate: e.maxBitrate ?? 0,
          scaleResolutionDownBy: e.scaleResolutionDownBy,
        }));
      }
    },
    replaceTrack: async () => {},
    setStreams: () => {},
  } as unknown as RTCRtpSender;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  // Let microtasks settle (getStats is async).
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('AbrController', () => {
  it('publishes the initial encoding ladder', async () => {
    const state: FakeSenderState = {
      bytesSent: 0,
      packetsSent: 0,
      packetsLost: 0,
      available: null,
      encodings: [],
      setParametersCalls: 0,
    };
    const ctrl = new AbrController(makeSender(state), { intervalMs: 1000 });
    await ctrl.applyInitialEncodings(true);
    expect(state.encodings.map((e) => e.rid)).toEqual(DEFAULT_LAYERS.map((l) => l.rid));
  });

  it('tightens on high loss', async () => {
    const state: FakeSenderState = {
      bytesSent: 0,
      packetsSent: 100,
      packetsLost: 0,
      available: 5_000_000,
      encodings: DEFAULT_LAYERS.map((l) => ({
        rid: l.rid,
        active: true,
        maxBitrate: l.initialMaxBitrate,
        scaleResolutionDownBy: l.scaleResolutionDownBy,
      })),
      setParametersCalls: 0,
    };
    const ctrl = new AbrController(makeSender(state), { intervalMs: 100 });
    ctrl.start();
    vi.advanceTimersByTime(100);
    await flush();
    state.packetsSent += 200;
    state.packetsLost += 30;
    state.bytesSent += 100_000;
    vi.advanceTimersByTime(100);
    await flush();
    const snap = ctrl.snapshot();
    expect(snap.packetLossPct).toBeGreaterThan(5);
    expect(snap.lastChange).toBe('down');
    ctrl.stop();
  });

  it('loosens on healthy with headroom', async () => {
    const start = DEFAULT_LAYERS.map((l) => ({
      rid: l.rid,
      active: true,
      maxBitrate: l.initialMaxBitrate * 0.5,
      scaleResolutionDownBy: l.scaleResolutionDownBy,
    }));
    const state: FakeSenderState = {
      bytesSent: 0,
      packetsSent: 100,
      packetsLost: 0,
      available: 10_000_000,
      encodings: start,
      setParametersCalls: 0,
    };
    const ctrl = new AbrController(makeSender(state), { intervalMs: 100 });
    ctrl.start();
    vi.advanceTimersByTime(100);
    await flush();
    state.packetsSent += 500;
    state.bytesSent += 500_000;
    vi.advanceTimersByTime(100);
    await flush();
    expect(ctrl.snapshot().lastChange).toBe('up');
    ctrl.stop();
  });
});
