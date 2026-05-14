// npx tsx src/lib/abr/__smoke_abr.ts
// Verifies the AIMD policy in isolation by stubbing RTCRtpSender.

type TimerHandle = number;
let nextHandle = 1;
const timers = new Map<TimerHandle, () => void>();

(globalThis as unknown as { window: unknown }).window = {
  setInterval(fn: () => void): TimerHandle {
    const h = nextHandle++;
    timers.set(h, fn);
    return h;
  },
  clearInterval(h: TimerHandle): void {
    timers.delete(h);
  },
};

async function tickAll(): Promise<void> {
  for (const fn of timers.values()) {
    fn();
  }
  // ABR awaits getStats inside tick — let microtasks settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

class FakeRtcStatsReport implements Iterable<unknown> {
  constructor(private readonly entries: unknown[]) {}
  forEach(cb: (v: unknown) => void): void {
    for (const e of this.entries) cb(e);
  }
  [Symbol.iterator](): Iterator<unknown> {
    return this.entries[Symbol.iterator]();
  }
}

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
    transform: null,
    dtmf: null,
    rtcpTransport: null,
    getCapabilities: undefined,
    getStats: async () => {
      return new FakeRtcStatsReport([
        {
          type: "transport",
          id: "T0",
          selectedCandidatePairId: "P0",
        },
        {
          type: "candidate-pair",
          id: "P0",
          nominated: true,
          state: "succeeded",
          availableOutgoingBitrate: state.available ?? undefined,
        },
        {
          type: "outbound-rtp",
          id: "O0",
          kind: "video",
          isRemote: false,
          bytesSent: state.bytesSent,
          packetsSent: state.packetsSent,
        },
        {
          type: "remote-inbound-rtp",
          id: "RI0",
          kind: "video",
          packetsLost: state.packetsLost,
        },
      ]) as unknown as RTCStatsReport;
    },
    getParameters: () => {
      return {
        transactionId: "tx",
        encodings: state.encodings.map((e) => ({ ...e })),
        rtcp: {},
        headerExtensions: [],
        codecs: [],
        degradationPreference: "balanced",
      } as unknown as RTCRtpSendParameters;
    },
    setParameters: async (params: RTCRtpSendParameters) => {
      state.setParametersCalls++;
      if (Array.isArray(params.encodings)) {
        state.encodings = params.encodings.map((e) => ({
          rid: e.rid ?? "",
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

const { AbrController, DEFAULT_LAYERS } = await import("./abr.js");

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

// 1. applyInitialEncodings sets the ladder.
{
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
  check(
    "initial encodings published",
    state.encodings.length === DEFAULT_LAYERS.length &&
      state.encodings.every((e, i) => e.rid === DEFAULT_LAYERS[i].rid),
  );
}

// 2. High loss tightens.
{
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
  await tickAll(); // first tick: prev not set, no decision but counts collected
  // Inject loss between ticks
  state.packetsSent += 200;
  state.packetsLost += 30;
  state.bytesSent += 100_000;
  await tickAll();
  const snap = ctrl.snapshot();
  check("packetLossPct computed", snap.packetLossPct > 5);
  check("lastChange = down on high loss", snap.lastChange === "down");
  check("top layer cut", snap.layers[2].targetBitrate < DEFAULT_LAYERS[2].initialMaxBitrate);
  ctrl.stop();
}

// 3. Healthy + ample headroom loosens.
{
  const start = DEFAULT_LAYERS.map((l) => ({
    rid: l.rid,
    active: true,
    maxBitrate: l.initialMaxBitrate * 0.5, // start below ceiling so loosen has somewhere to go
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
  await tickAll();
  state.packetsSent += 500;
  state.bytesSent += 500_000;
  await tickAll();
  const snap = ctrl.snapshot();
  check("lastChange = up on healthy", snap.lastChange === "up");
  check("top layer increased", snap.layers[2].targetBitrate > DEFAULT_LAYERS[2].initialMaxBitrate * 0.5);
  ctrl.stop();
}

// 4. Sustained high loss eventually deactivates the top layer once it
// reaches its floor.
{
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
  await tickAll(); // bootstrap sample
  for (let i = 0; i < 8; i++) {
    state.packetsSent += 200;
    state.packetsLost += 80;
    await tickAll();
  }
  const snap = ctrl.snapshot();
  check("top layer at floor or deactivated after sustained loss",
    !snap.layers[2].active || snap.layers[2].targetBitrate <= DEFAULT_LAYERS[2].minBitrate);
  ctrl.stop();
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
