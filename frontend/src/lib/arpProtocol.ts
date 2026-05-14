// ARP — Application Reliable Protocol
// =====================================
// A tiny TCP-Reno-style reliable transport built ON TOP of an unreliable +
// unordered WebRTC DataChannel ({ ordered: false, maxRetransmits: 0 }).
//
// The DataChannel gives us datagrams that may be dropped, duplicated, or
// reordered. ARP layers ARQ + sliding-window flow control + slow-start /
// AIMD congestion control on top — i.e. the kind of mechanisms you'd see in
// TCP or QUIC, but running entirely in-browser so they're observable.
//
// This file is PURE LOGIC: no DataChannel, no React. It exposes a Sender
// and a Receiver class plus a frame codec. arpSession.ts binds them to a
// real DataChannel and drives the tick.
//
// Frame format (11-byte header, big-endian):
//   byte  0      : type   (uint8)   0 = DATA, 1 = ACK
//   bytes 1..4   : seq    (uint32)  sequence # of THIS DATA packet
//                                   (ignored / 0 for ACKs)
//   bytes 5..8   : ack    (uint32)  cumulative ACK — receiver has all
//                                   sequences strictly less than this
//   bytes 9..10  : window (uint16)  receiver-advertised window in packets
//   bytes 11..N  : payload (DATA only)

export const ARP_HEADER_BYTES = 11;
export const ARP_FRAME_DATA = 0;
export const ARP_FRAME_ACK = 1;

export const ARP_MSS = 1024;            // bytes per app-data segment
export const ARP_INITIAL_CWND = 1;      // packets — TCP-Reno initial window
export const ARP_INITIAL_SSTHRESH = 64; // packets
export const ARP_INITIAL_RTO_MS = 1000;
export const ARP_MIN_RTO_MS = 100;
export const ARP_MAX_RTO_MS = 30_000;
export const ARP_DUP_ACK_THRESHOLD = 3;
export const ARP_DEFAULT_RWND = 256;    // packets — receive window we advertise

export interface ArpFrame {
  type: number;
  seq: number;
  ack: number;
  window: number;
  payload: Uint8Array; // empty for ACKs
}

// ---------- frame codec ----------

export function encodeFrame(f: ArpFrame): ArrayBuffer {
  const out = new ArrayBuffer(ARP_HEADER_BYTES + f.payload.byteLength);
  const view = new DataView(out);
  view.setUint8(0, f.type);
  view.setUint32(1, f.seq >>> 0, false);
  view.setUint32(5, f.ack >>> 0, false);
  view.setUint16(9, f.window & 0xffff, false);
  if (f.payload.byteLength > 0) {
    new Uint8Array(out, ARP_HEADER_BYTES).set(f.payload);
  }
  return out;
}

export function decodeFrame(buf: ArrayBuffer): ArpFrame | null {
  if (buf.byteLength < ARP_HEADER_BYTES) return null;
  const view = new DataView(buf);
  const type = view.getUint8(0);
  const seq = view.getUint32(1, false);
  const ack = view.getUint32(5, false);
  const window = view.getUint16(9, false);
  const payload = new Uint8Array(buf.slice(ARP_HEADER_BYTES));
  return { type, seq, ack, window, payload };
}

// ---------- packet log entry (for the visualizer) ----------

export interface PacketLogEntry {
  t: number;
  dir: "tx" | "rx";
  type: "DATA" | "ACK";
  seq: number;
  ack: number;
  bytes: number;
  retransmit?: boolean;
  drop?: boolean; // simulated drop, sender side
}

// ---------- sender ----------

interface InFlight {
  seq: number;
  payload: Uint8Array;
  sentAt: number;
  retransmitted: boolean;
}

export type SenderMode = "slow-start" | "cong-avoid" | "fast-recovery";

export interface SenderSnapshot {
  cwnd: number;
  ssthresh: number;
  inFlight: number;
  sendQueue: number;
  rttSrtt: number;
  rttVar: number;
  rto: number;
  mode: SenderMode;
  bytesAcked: number;
  bytesSent: number;
  retransmits: number;
  fastRetransmits: number;
  rtoExpiries: number;
  dupAcks: number;
  highestAck: number;
  nextSeq: number;
  rwnd: number;
}

export interface SenderEmitArgs {
  // Frame to enqueue on the DataChannel. Returns true if the frame was actually
  // emitted (i.e. not dropped by the loss injector). The sender does NOT change
  // its book-keeping based on the return value — a "drop" is just network loss
  // from its perspective, recovered via dup-ACKs or RTO.
  send: (frame: ArpFrame) => boolean;
  log: (entry: PacketLogEntry) => void;
  now: () => number;
}

export class ArpSender {
  cwnd = ARP_INITIAL_CWND;
  ssthresh = ARP_INITIAL_SSTHRESH;
  rttSrtt = 0;
  rttVar = 0;
  rto = ARP_INITIAL_RTO_MS;
  mode: SenderMode = "slow-start";
  bytesAcked = 0;
  bytesSent = 0;
  retransmits = 0;
  fastRetransmits = 0;
  rtoExpiries = 0;
  dupAcks = 0;

  private inFlight = new Map<number, InFlight>();
  private sendQueue: Uint8Array[] = [];
  private nextSeq = 0;
  private highestAck = 0;     // cumulative ACK = "all seq < highestAck have been received"
  private lastDupAckSeq = -1;
  private rwnd = ARP_DEFAULT_RWND;

  constructor(private io: SenderEmitArgs) {}

  // App-level enqueue.
  enqueue(payload: Uint8Array): void {
    if (payload.byteLength === 0) return;
    this.sendQueue.push(payload);
    this.pump();
  }

  // Send as many fresh DATA frames as cwnd + rwnd allow.
  private pump(): void {
    const window = Math.min(this.cwnd, this.rwnd);
    while (this.inFlight.size < window && this.sendQueue.length > 0) {
      const payload = this.sendQueue.shift()!;
      const seq = this.nextSeq++;
      const frame: ArpFrame = {
        type: ARP_FRAME_DATA,
        seq,
        ack: 0,
        window: ARP_DEFAULT_RWND,
        payload,
      };
      const now = this.io.now();
      this.inFlight.set(seq, { seq, payload, sentAt: now, retransmitted: false });
      const dropped = !this.io.send(frame);
      this.bytesSent += payload.byteLength;
      this.io.log({
        t: now,
        dir: "tx",
        type: "DATA",
        seq,
        ack: 0,
        bytes: payload.byteLength,
        drop: dropped || undefined,
      });
    }
  }

  // Receiver acknowledged everything strictly less than `cumulativeAck`.
  onAck(cumulativeAck: number, advertisedWindow: number): void {
    this.rwnd = advertisedWindow > 0 ? advertisedWindow : ARP_DEFAULT_RWND;

    const newlyAckedCount = this.acceptCumulativeAck(cumulativeAck);

    if (newlyAckedCount > 0) {
      // Successful ACK — exit fast-recovery if we were in it.
      if (this.mode === "fast-recovery") {
        this.cwnd = this.ssthresh;
        this.mode = this.cwnd < this.ssthresh ? "slow-start" : "cong-avoid";
      }
      this.dupAcks = 0;
      this.lastDupAckSeq = cumulativeAck; // track baseline so next dup is detected correctly

      // Slow-start vs congestion-avoidance growth.
      if (this.cwnd < this.ssthresh) {
        this.mode = "slow-start";
        this.cwnd += newlyAckedCount; // exponential per ACK
      } else {
        this.mode = "cong-avoid";
        this.cwnd += newlyAckedCount / Math.max(this.cwnd, 1); // additive per ACK
      }

      this.pump();
      return;
    }

    // No new data ACKed — duplicate ACK. Only meaningful if we still have
    // outstanding segments (otherwise there's nothing to fast-retransmit).
    if (this.inFlight.size === 0) return;

    if (cumulativeAck === this.lastDupAckSeq) {
      this.dupAcks++;
    } else {
      this.dupAcks = 1;
      this.lastDupAckSeq = cumulativeAck;
    }

    if (this.dupAcks === ARP_DUP_ACK_THRESHOLD) {
      this.fastRetransmit(cumulativeAck);
    }
  }

  private acceptCumulativeAck(cumAck: number): number {
    if (cumAck <= this.highestAck) return 0;
    const now = this.io.now();
    let acked = 0;
    for (const seq of Array.from(this.inFlight.keys())) {
      if (seq < cumAck) {
        const seg = this.inFlight.get(seq)!;
        // Karn's algorithm: don't sample RTT from retransmitted packets.
        if (!seg.retransmitted) {
          this.updateRtt(now - seg.sentAt);
        }
        this.bytesAcked += seg.payload.byteLength;
        this.inFlight.delete(seq);
        acked++;
      }
    }
    this.highestAck = cumAck;
    return acked;
  }

  private fastRetransmit(cumAck: number): void {
    const seg = this.inFlight.get(cumAck);
    if (!seg) return;
    this.ssthresh = Math.max(Math.floor(this.cwnd / 2), 2);
    this.cwnd = this.ssthresh + ARP_DUP_ACK_THRESHOLD; // RFC 5681 inflation
    this.mode = "fast-recovery";
    this.fastRetransmits++;
    this.retransmitSegment(seg);
  }

  // Driven by arpSession.tick() at ~50 Hz; checks oldest in-flight packet
  // for RTO expiry.
  tick(): void {
    if (this.inFlight.size === 0) return;
    const now = this.io.now();
    let oldest: InFlight | undefined;
    for (const seg of this.inFlight.values()) {
      if (!oldest || seg.sentAt < oldest.sentAt) oldest = seg;
    }
    if (!oldest) return;
    if (now - oldest.sentAt < this.rto) return;

    // RTO expired — TCP Reno hard reset.
    this.ssthresh = Math.max(Math.floor(this.cwnd / 2), 2);
    this.cwnd = ARP_INITIAL_CWND;
    this.mode = "slow-start";
    this.rtoExpiries++;
    this.dupAcks = 0;
    // Karn's algorithm: exponential RTO backoff on timeout.
    this.rto = Math.min(this.rto * 2, ARP_MAX_RTO_MS);
    this.retransmitSegment(oldest);
  }

  private retransmitSegment(seg: InFlight): void {
    const now = this.io.now();
    seg.sentAt = now;
    seg.retransmitted = true;
    this.retransmits++;
    const frame: ArpFrame = {
      type: ARP_FRAME_DATA,
      seq: seg.seq,
      ack: 0,
      window: ARP_DEFAULT_RWND,
      payload: seg.payload,
    };
    const dropped = !this.io.send(frame);
    this.io.log({
      t: now,
      dir: "tx",
      type: "DATA",
      seq: seg.seq,
      ack: 0,
      bytes: seg.payload.byteLength,
      retransmit: true,
      drop: dropped || undefined,
    });
  }

  // Jacobson/Karels RTT smoothing.
  private updateRtt(sample: number): void {
    const ALPHA = 0.125;
    const BETA = 0.25;
    if (this.rttSrtt === 0) {
      this.rttSrtt = sample;
      this.rttVar = sample / 2;
    } else {
      this.rttVar = (1 - BETA) * this.rttVar + BETA * Math.abs(this.rttSrtt - sample);
      this.rttSrtt = (1 - ALPHA) * this.rttSrtt + ALPHA * sample;
    }
    this.rto = Math.min(
      ARP_MAX_RTO_MS,
      Math.max(ARP_MIN_RTO_MS, this.rttSrtt + 4 * this.rttVar)
    );
  }

  snapshot(): SenderSnapshot {
    return {
      cwnd: this.cwnd,
      ssthresh: this.ssthresh,
      inFlight: this.inFlight.size,
      sendQueue: this.sendQueue.length,
      rttSrtt: this.rttSrtt,
      rttVar: this.rttVar,
      rto: this.rto,
      mode: this.mode,
      bytesAcked: this.bytesAcked,
      bytesSent: this.bytesSent,
      retransmits: this.retransmits,
      fastRetransmits: this.fastRetransmits,
      rtoExpiries: this.rtoExpiries,
      dupAcks: this.dupAcks,
      highestAck: this.highestAck,
      nextSeq: this.nextSeq,
      rwnd: this.rwnd,
    };
  }
}

// ---------- receiver ----------

export interface ReceiverEmitArgs {
  send: (frame: ArpFrame) => void;
  deliver: (payload: Uint8Array) => void;
  log: (entry: PacketLogEntry) => void;
  now: () => number;
}

export interface ReceiverSnapshot {
  expectedSeq: number;
  outOfOrder: number;
  bytesDelivered: number;
  duplicates: number;
}

export class ArpReceiver {
  expectedSeq = 0;
  bytesDelivered = 0;
  duplicates = 0;
  private outOfOrder = new Map<number, Uint8Array>();
  private rwnd = ARP_DEFAULT_RWND;

  constructor(private io: ReceiverEmitArgs) {}

  onData(frame: ArpFrame): void {
    const now = this.io.now();
    this.io.log({
      t: now,
      dir: "rx",
      type: "DATA",
      seq: frame.seq,
      ack: 0,
      bytes: frame.payload.byteLength,
    });

    if (frame.seq < this.expectedSeq) {
      this.duplicates++;
    } else if (frame.seq === this.expectedSeq) {
      this.deliver(frame.payload);
      this.expectedSeq++;
      // Drain any contiguous run from the OOO buffer.
      while (this.outOfOrder.has(this.expectedSeq)) {
        const buffered = this.outOfOrder.get(this.expectedSeq)!;
        this.outOfOrder.delete(this.expectedSeq);
        this.deliver(buffered);
        this.expectedSeq++;
      }
    } else {
      // Future seq — buffer.
      if (!this.outOfOrder.has(frame.seq)) {
        this.outOfOrder.set(frame.seq, frame.payload);
      }
    }

    // Always send a cumulative ACK (RFC 5681) — even on out-of-order arrivals,
    // which yields the dup-ACK signal that drives fast retransmit.
    const ackFrame: ArpFrame = {
      type: ARP_FRAME_ACK,
      seq: 0,
      ack: this.expectedSeq,
      window: this.rwnd,
      payload: new Uint8Array(0),
    };
    this.io.send(ackFrame);
    this.io.log({
      t: now,
      dir: "tx",
      type: "ACK",
      seq: 0,
      ack: this.expectedSeq,
      bytes: 0,
    });
  }

  private deliver(payload: Uint8Array) {
    this.bytesDelivered += payload.byteLength;
    this.io.deliver(payload);
  }

  snapshot(): ReceiverSnapshot {
    return {
      expectedSeq: this.expectedSeq,
      outOfOrder: this.outOfOrder.size,
      bytesDelivered: this.bytesDelivered,
      duplicates: this.duplicates,
    };
  }
}
