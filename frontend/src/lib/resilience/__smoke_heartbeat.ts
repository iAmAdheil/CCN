// Run with: npx tsx src/lib/resilience/__smoke_heartbeat.ts
// Verifies the HeartbeatTracker happy/sad paths in isolation from the DOM.
//
// The tracker uses window.setInterval/window.clearInterval; we stub a tiny
// `window` shim so this file runs under bare Node.

type TimerHandle = number;

let nextHandle = 1;
const timers = new Map<TimerHandle, { fn: () => void; intervalMs: number }>();

(globalThis as unknown as { window: unknown }).window = {
  setInterval(fn: () => void, ms: number): TimerHandle {
    const h = nextHandle++;
    timers.set(h, { fn, intervalMs: ms });
    return h;
  },
  clearInterval(h: TimerHandle): void {
    timers.delete(h);
  },
  setTimeout(fn: () => void, _ms: number): TimerHandle {
    const h = nextHandle++;
    timers.set(h, { fn, intervalMs: -1 });
    queueMicrotask(() => {
      const t = timers.get(h);
      if (t) {
        timers.delete(h);
        t.fn();
      }
    });
    return h;
  },
  clearTimeout(h: TimerHandle): void {
    timers.delete(h);
  },
};

function tickAll(): void {
  for (const t of timers.values()) {
    if (t.intervalMs > 0) t.fn();
  }
}

const { HeartbeatTracker } = await import("./heartbeat.js");

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

console.log("HeartbeatTracker smoke");

// 1. Round trip: ping → pong sets RTT and keeps status healthy.
{
  const sent: unknown[] = [];
  const tracker = new HeartbeatTracker({ intervalMs: 100 });
  tracker.start();
  tracker.addPeer("p1", (obj) => {
    sent.push(obj);
    return true;
  });
  tickAll();
  check("first tick sent a ping", sent.length === 1);
  const ping = sent[0] as { type: string; id: number; t: number };
  check("ping shape", ping.type === "hb-ping" && typeof ping.id === "number");

  // Receiver echoes
  const pong = tracker.handlePing(ping);
  check("handlePing returns pong", pong !== null);
  // Sender adopts the pong
  await new Promise((r) => setTimeout(r, 5));
  const accepted = tracker.handlePong("p1", pong!);
  check("handlePong accepted", accepted);
  const snap = tracker.snapshot();
  check("status healthy after pong", snap["p1"].status === "healthy");
  check("rtt recorded", snap["p1"].rttMs !== null && snap["p1"].rttMs >= 0);
  tracker.stop();
}

// 2. Misses escalate: stale → unhealthy → dead.
{
  const tracker = new HeartbeatTracker({ intervalMs: 100, staleAfterMisses: 1, unhealthyAfterMisses: 2, deadAfterMisses: 3 });
  let unhealthyFired: string | null = null;
  const tracker2 = new HeartbeatTracker({
    intervalMs: 100,
    staleAfterMisses: 1,
    unhealthyAfterMisses: 2,
    deadAfterMisses: 3,
    onUnhealthy: (id) => {
      unhealthyFired = id;
    },
  });
  tracker2.start();
  tracker2.addPeer("p2", () => true); // sender pretends to send but no pong ever comes
  tickAll(); // sends ping #1, no pending yet to count
  check("after 1 tick (no pong, no stale yet — ping just queued)", tracker2.snapshot()["p2"].status === "healthy");
  tickAll(); // counts the unanswered ping #1, status -> stale
  check("after 2 ticks: stale", tracker2.snapshot()["p2"].status === "stale");
  tickAll(); // unhealthy
  check("after 3 ticks: unhealthy", tracker2.snapshot()["p2"].status === "unhealthy");
  check("onUnhealthy fired with peerId", unhealthyFired === "p2");
  tickAll(); // dead
  check("after 4 ticks: dead", tracker2.snapshot()["p2"].status === "dead");
  tracker2.stop();
  void tracker; // silence
}

// 3. Recovery: a pong after misses returns status to healthy.
{
  const sent: Array<{ type: string; id: number; t: number }> = [];
  const tracker = new HeartbeatTracker({ intervalMs: 100, staleAfterMisses: 1, unhealthyAfterMisses: 2, deadAfterMisses: 3 });
  tracker.start();
  tracker.addPeer("p3", (obj) => {
    sent.push(obj as { type: string; id: number; t: number });
    return true;
  });
  tickAll();
  tickAll();
  check("p3 stale after 2 ticks", tracker.snapshot()["p3"].status === "stale");
  // Echo the most recent ping
  const ping = sent[sent.length - 1];
  const pong = tracker.handlePing(ping)!;
  tracker.handlePong("p3", pong);
  check("p3 healthy again after late pong", tracker.snapshot()["p3"].status === "healthy");
  tracker.stop();
}

// 4. removePeer cleans up.
{
  const tracker = new HeartbeatTracker({ intervalMs: 100 });
  tracker.start();
  tracker.addPeer("p4", () => true);
  tracker.removePeer("p4");
  check("snapshot empty after remove", Object.keys(tracker.snapshot()).length === 0);
  tracker.stop();
}

// 5. handlePing rejects malformed input.
{
  const tracker = new HeartbeatTracker();
  check("rejects non-object", tracker.handlePing("nope") === null);
  check("rejects wrong type", tracker.handlePing({ type: "x", id: 1, t: 1 }) === null);
  check("rejects missing id", tracker.handlePing({ type: "hb-ping", t: 1 }) === null);
  check("accepts valid", tracker.handlePing({ type: "hb-ping", id: 1, t: 1 }) !== null);
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
