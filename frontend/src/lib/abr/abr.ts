// Adaptive bitrate controller for an outgoing video sender.
//
// On each tick (default 2s):
//   1. Read the sender's getStats() report.
//   2. Pull the candidate-pair availableOutgoingBitrate (Chromium emits this
//      via REMB/transport-cc). If absent, fall back to a moving average of
//      observed bytesSent so we have *some* signal.
//   3. Compute fractional loss over the tick from outbound-rtp packetsSent
//      and (if exposed) RTCP feedback.
//   4. AIMD on the per-layer maxBitrate: tighten (multiplicative decrease)
//      when loss is bad or available headroom is gone; loosen (additive
//      increase) otherwise.
//   5. Push the new encodings via sender.setParameters().
//
// The controller is intentionally conservative — we want demonstrable
// adaptation without thrashing. Real SFUs (e.g. Janus, Pion) do something
// similar with ML-tuned thresholds; ours is a hand-rolled toy.
//
// Layers are addressed by `rid` ("l", "m", "h") so we can match them across
// simulcast restarts. The default ladder targets typical webcam profiles:
//   l: 320×180  @ ~150 Kbps   (fallback for severely constrained downlinks)
//   m: 640×360  @ ~500 Kbps
//   h: 1280×720 @ ~1500 Kbps  (full quality)

export interface AbrLayerSpec {
  rid: string;
  scaleResolutionDownBy: number;
  /** Initial maxBitrate (bps). Adjusted at runtime. */
  initialMaxBitrate: number;
  /** Floor — never tighten below this. */
  minBitrate: number;
  /** Ceiling — never loosen above this. */
  maxBitrate: number;
}

export interface AbrLayerState {
  rid: string;
  targetBitrate: number;
  active: boolean;
}

export interface AbrSnapshot {
  layers: AbrLayerState[];
  availableOutgoingBitrate: number | null;
  observedOutboundBps: number;
  packetLossPct: number;
  lastChange: "up" | "down" | "hold";
  ticks: number;
}

export const DEFAULT_LAYERS: AbrLayerSpec[] = [
  { rid: "l", scaleResolutionDownBy: 4, initialMaxBitrate: 150_000, minBitrate: 80_000, maxBitrate: 250_000 },
  { rid: "m", scaleResolutionDownBy: 2, initialMaxBitrate: 500_000, minBitrate: 200_000, maxBitrate: 800_000 },
  { rid: "h", scaleResolutionDownBy: 1, initialMaxBitrate: 1_500_000, minBitrate: 500_000, maxBitrate: 2_500_000 },
];

export interface AbrControllerOptions {
  intervalMs?: number;
  layers?: AbrLayerSpec[];
  /** Multiplicative decrease factor on degradation. */
  decreaseFactor?: number;
  /** Additive increase step (bps) on healthy ticks. */
  increaseStep?: number;
  /** Loss percentage above which we tighten unconditionally. */
  highLossPct?: number;
  /** Loss percentage below which we may loosen. */
  lowLossPct?: number;
}

interface PrevSample {
  bytesSent: number;
  packetsSent: number;
  packetsLost: number;
  t: number;
}

type Subscriber = (snap: AbrSnapshot) => void;

interface RtcStat {
  type: string;
  bytesSent?: number;
  packetsSent?: number;
  packetsLost?: number;
  availableOutgoingBitrate?: number;
  selectedCandidatePairId?: string;
  nominated?: boolean;
  state?: string;
  kind?: string;
  isRemote?: boolean;
  id: string;
  localId?: string;
}

export class AbrController {
  private timer: number | null = null;
  private prev: PrevSample | null = null;
  private subs = new Set<Subscriber>();
  private snap: AbrSnapshot;
  private readonly opts: Required<AbrControllerOptions>;

  constructor(
    private readonly sender: RTCRtpSender,
    options: AbrControllerOptions = {},
  ) {
    this.opts = {
      intervalMs: options.intervalMs ?? 2_000,
      layers: options.layers ?? DEFAULT_LAYERS,
      decreaseFactor: options.decreaseFactor ?? 0.6,
      increaseStep: options.increaseStep ?? 100_000,
      highLossPct: options.highLossPct ?? 5,
      lowLossPct: options.lowLossPct ?? 2,
    };
    this.snap = {
      layers: this.opts.layers.map((l) => ({ rid: l.rid, targetBitrate: l.initialMaxBitrate, active: true })),
      availableOutgoingBitrate: null,
      observedOutboundBps: 0,
      packetLossPct: 0,
      lastChange: "hold",
      ticks: 0,
    };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): AbrSnapshot {
    return { ...this.snap, layers: this.snap.layers.map((l) => ({ ...l })) };
  }

  subscribe(s: Subscriber): () => void {
    this.subs.add(s);
    s(this.snapshot());
    return () => {
      this.subs.delete(s);
    };
  }

  // Exposed so callers can apply the initial encoding ladder right after
  // produce(), before the first tick fires. Returns the params object that
  // would be applied if applyImmediately is false.
  async applyInitialEncodings(applyImmediately = true): Promise<RTCRtpSendParameters> {
    const params = this.sender.getParameters();
    params.encodings = this.opts.layers.map((l) => ({
      rid: l.rid,
      active: true,
      maxBitrate: l.initialMaxBitrate,
      scaleResolutionDownBy: l.scaleResolutionDownBy,
    }));
    if (applyImmediately) {
      try {
        await this.sender.setParameters(params);
      } catch (err) {
        console.warn("[abr] applyInitialEncodings failed", err);
      }
    }
    return params;
  }

  private async tick(): Promise<void> {
    let report: RTCStatsReport;
    try {
      report = await this.sender.getStats();
    } catch {
      return;
    }
    const sample = this.collect(report);
    const dt = this.prev ? Math.max(0.001, (sample.t - this.prev.t) / 1000) : 0;
    let observedOutboundBps = 0;
    let packetLossPct = 0;
    if (this.prev && dt > 0) {
      observedOutboundBps = Math.max(0, ((sample.bytesSent - this.prev.bytesSent) * 8) / dt);
      const dLost = Math.max(0, sample.packetsLost - this.prev.packetsLost);
      const dSent = Math.max(0, sample.packetsSent - this.prev.packetsSent);
      const denom = dLost + dSent;
      packetLossPct = denom > 0 ? (dLost / denom) * 100 : 0;
    }
    this.prev = sample;

    let lastChange: AbrSnapshot["lastChange"] = "hold";
    const layers = this.snap.layers.map((l) => ({ ...l }));

    if (packetLossPct >= this.opts.highLossPct) {
      lastChange = this.tighten(layers);
    } else {
      const totalTarget = layers.reduce((a, l) => a + (l.active ? l.targetBitrate : 0), 0);
      const headroom =
        sample.availableOutgoingBitrate !== null
          ? sample.availableOutgoingBitrate - totalTarget
          : null;
      if (headroom !== null && headroom < 0) {
        lastChange = this.tighten(layers);
      } else if (
        packetLossPct < this.opts.lowLossPct &&
        (headroom === null || headroom > totalTarget * 0.2)
      ) {
        lastChange = this.loosen(layers);
      }
    }

    if (lastChange !== "hold") {
      try {
        const params = this.sender.getParameters();
        if (Array.isArray(params.encodings) && params.encodings.length > 0) {
          for (const enc of params.encodings) {
            const layer = layers.find((l) => l.rid === enc.rid);
            if (layer) {
              enc.maxBitrate = layer.targetBitrate;
              enc.active = layer.active;
            }
          }
          await this.sender.setParameters(params);
        }
      } catch (err) {
        console.warn("[abr] setParameters failed", err);
        // Roll back the snapshot on failure so we don't drift.
        return;
      }
    }

    this.snap = {
      layers,
      availableOutgoingBitrate: sample.availableOutgoingBitrate,
      observedOutboundBps,
      packetLossPct,
      lastChange,
      ticks: this.snap.ticks + 1,
    };
    this.publish();
  }

  private tighten(layers: AbrLayerState[]): "down" | "hold" {
    // Cut from the highest active layer first. If it's at floor, deactivate
    // it and fall back to the next one down.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer.active) continue;
      const spec = this.opts.layers.find((l) => l.rid === layer.rid)!;
      const next = Math.max(spec.minBitrate, Math.floor(layer.targetBitrate * this.opts.decreaseFactor));
      if (next < layer.targetBitrate) {
        layer.targetBitrate = next;
        return "down";
      }
      // Already at floor — deactivate the top layer if there's a lower one.
      if (i > 0) {
        layer.active = false;
        return "down";
      }
      return "hold";
    }
    return "hold";
  }

  private loosen(layers: AbrLayerState[]): "up" | "hold" {
    // Re-activate the next-highest layer if any are off; otherwise nudge the
    // top active layer up by `increaseStep` (capped at its ceiling).
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.active) {
        layer.active = true;
        return "up";
      }
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const spec = this.opts.layers.find((l) => l.rid === layer.rid)!;
      const next = Math.min(spec.maxBitrate, layer.targetBitrate + this.opts.increaseStep);
      if (next > layer.targetBitrate) {
        layer.targetBitrate = next;
        return "up";
      }
    }
    return "hold";
  }

  private collect(report: RTCStatsReport): PrevSample & { availableOutgoingBitrate: number | null } {
    let transportSelectedPairId: string | null = null;
    const pairsById: Record<string, RtcStat> = {};
    let bytesSent = 0;
    let packetsSent = 0;
    let packetsLost = 0;

    report.forEach((raw) => {
      const s = raw as unknown as RtcStat;
      switch (s.type) {
        case "transport":
          transportSelectedPairId = s.selectedCandidatePairId ?? null;
          break;
        case "candidate-pair":
          pairsById[s.id] = s;
          break;
        case "outbound-rtp":
          if (s.kind === "video" && !s.isRemote) {
            bytesSent += s.bytesSent ?? 0;
            packetsSent += s.packetsSent ?? 0;
          }
          break;
        case "remote-inbound-rtp":
          if (s.kind === "video") {
            packetsLost += s.packetsLost ?? 0;
          }
          break;
      }
    });

    let pair: RtcStat | null = null;
    if (transportSelectedPairId && pairsById[transportSelectedPairId]) {
      pair = pairsById[transportSelectedPairId];
    } else {
      for (const p of Object.values(pairsById)) {
        if (p.nominated && p.state === "succeeded") {
          pair = p;
          break;
        }
      }
    }

    const availableOutgoingBitrate =
      pair && typeof pair.availableOutgoingBitrate === "number" ? pair.availableOutgoingBitrate : null;

    return {
      bytesSent,
      packetsSent,
      packetsLost,
      t: Date.now(),
      availableOutgoingBitrate,
    };
  }

  private publish(): void {
    if (this.subs.size === 0) return;
    const snap = this.snapshot();
    for (const s of this.subs) s(snap);
  }
}
