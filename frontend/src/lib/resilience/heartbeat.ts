// DataChannel-level heartbeat. Active probe of the per-peer DC, separate from
// ICE-level liveness — answers "is this channel actually responding?", not
// just "is the transport notionally up?".
//
// Wire frames (JSON over the chat/file DC):
//   { type: "hb-ping", id, t }   sender stamps a monotonic id + Date.now()
//   { type: "hb-pong", id, t }   receiver echoes both fields immediately
//
// Sender computes RTT on pong receipt. If we miss `unhealthyAfterMisses`
// consecutive pongs, the peer is unhealthy and the caller should trigger an
// ICE restart. After `deadAfterMisses`, the peer is treated as gone for the
// purposes of UI badges (the underlying PC will usually have been torn down
// by then via iceconnectionstate transitions).

export interface PeerHeartbeat {
  rttMs: number | null;
  lastPongAt: number | null;
  consecutiveMisses: number;
  status: "healthy" | "stale" | "unhealthy" | "dead";
}

type Subscriber = (snapshot: Record<string, PeerHeartbeat>) => void;

export interface HeartbeatTrackerOptions {
  intervalMs?: number;
  unhealthyAfterMisses?: number;
  deadAfterMisses?: number;
  staleAfterMisses?: number;
  onUnhealthy?: (peerId: string) => void;
}

const DEFAULT_INTERVAL = 5_000;
const DEFAULT_STALE = 1;
const DEFAULT_UNHEALTHY = 3;
const DEFAULT_DEAD = 6;

interface PendingPing {
  id: number;
  sentAt: number;
}

interface PeerEntry {
  state: PeerHeartbeat;
  sender: (obj: unknown) => boolean;
  pending: Map<number, PendingPing>;
  nextPingId: number;
  unhealthyFired: boolean;
}

export class HeartbeatTracker {
  private peers = new Map<string, PeerEntry>();
  private subs = new Set<Subscriber>();
  private timer: number | null = null;
  private readonly opts: Required<Omit<HeartbeatTrackerOptions, "onUnhealthy">> & {
    onUnhealthy?: (peerId: string) => void;
  };

  constructor(opts: HeartbeatTrackerOptions = {}) {
    this.opts = {
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL,
      unhealthyAfterMisses: opts.unhealthyAfterMisses ?? DEFAULT_UNHEALTHY,
      deadAfterMisses: opts.deadAfterMisses ?? DEFAULT_DEAD,
      staleAfterMisses: opts.staleAfterMisses ?? DEFAULT_STALE,
      onUnhealthy: opts.onUnhealthy,
    };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  addPeer(peerId: string, sender: (obj: unknown) => boolean): void {
    if (this.peers.has(peerId)) {
      // Sender may have changed (e.g. DC was rebuilt after ICE restart); refresh.
      const entry = this.peers.get(peerId)!;
      entry.sender = sender;
      entry.unhealthyFired = false;
      entry.state = { ...entry.state, consecutiveMisses: 0, status: "healthy" };
      this.publish();
      return;
    }
    this.peers.set(peerId, {
      state: { rttMs: null, lastPongAt: null, consecutiveMisses: 0, status: "healthy" },
      sender,
      pending: new Map(),
      nextPingId: 1,
      unhealthyFired: false,
    });
    this.publish();
  }

  removePeer(peerId: string): void {
    if (this.peers.delete(peerId)) this.publish();
  }

  // Receiver side: caller routes "hb-ping" frames here and replies with the
  // returned pong payload (or null if the message wasn't a heartbeat).
  handlePing(raw: unknown): { type: "hb-pong"; id: number; t: number } | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as { type?: unknown; id?: unknown; t?: unknown };
    if (m.type !== "hb-ping") return null;
    if (typeof m.id !== "number" || typeof m.t !== "number") return null;
    return { type: "hb-pong", id: m.id, t: m.t };
  }

  // Sender side: caller routes "hb-pong" frames here.
  handlePong(peerId: string, raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const m = raw as { type?: unknown; id?: unknown };
    if (m.type !== "hb-pong" || typeof m.id !== "number") return false;
    const entry = this.peers.get(peerId);
    if (!entry) return false;
    const pending = entry.pending.get(m.id);
    if (!pending) return false;
    entry.pending.delete(m.id);
    const now = Date.now();
    entry.state.rttMs = Math.max(0, now - pending.sentAt);
    entry.state.lastPongAt = now;
    entry.state.consecutiveMisses = 0;
    entry.state.status = "healthy";
    entry.unhealthyFired = false;
    this.publish();
    return true;
  }

  snapshot(): Record<string, PeerHeartbeat> {
    const out: Record<string, PeerHeartbeat> = {};
    for (const [id, e] of this.peers) out[id] = { ...e.state };
    return out;
  }

  subscribe(s: Subscriber): () => void {
    this.subs.add(s);
    s(this.snapshot());
    return () => {
      this.subs.delete(s);
    };
  }

  private tick(): void {
    let changed = false;
    for (const [peerId, entry] of this.peers) {
      // Account for the previous round: any still-unanswered pings count as a
      // miss exactly once (when their pingId is still in `pending`).
      const stalePings = entry.pending.size;
      if (stalePings > 0) {
        // Drop pending older than a couple of intervals so the map doesn't grow
        // unbounded if a peer is silent for a long time.
        const cutoff = Date.now() - this.opts.intervalMs * (this.opts.deadAfterMisses + 1);
        for (const [id, p] of entry.pending) {
          if (p.sentAt < cutoff) entry.pending.delete(id);
        }
        entry.state.consecutiveMisses += 1;
        const next = this.classify(entry.state.consecutiveMisses);
        if (entry.state.status !== next) {
          entry.state.status = next;
          changed = true;
        }
        if (entry.state.status === "unhealthy" && !entry.unhealthyFired) {
          entry.unhealthyFired = true;
          this.opts.onUnhealthy?.(peerId);
        }
      }

      // Send a fresh ping for this round.
      const id = entry.nextPingId++;
      const sentAt = Date.now();
      const ok = entry.sender({ type: "hb-ping", id, t: sentAt });
      if (ok) {
        entry.pending.set(id, { id, sentAt });
      } else {
        // DC isn't writable — count it as a miss too.
        entry.state.consecutiveMisses += 1;
        const next = this.classify(entry.state.consecutiveMisses);
        if (entry.state.status !== next) {
          entry.state.status = next;
          changed = true;
        }
      }
    }
    if (changed) this.publish();
  }

  private classify(misses: number): PeerHeartbeat["status"] {
    if (misses >= this.opts.deadAfterMisses) return "dead";
    if (misses >= this.opts.unhealthyAfterMisses) return "unhealthy";
    if (misses >= this.opts.staleAfterMisses) return "stale";
    return "healthy";
  }

  private publish(): void {
    if (this.subs.size === 0) return;
    const snap = this.snapshot();
    for (const s of this.subs) s(snap);
  }
}
