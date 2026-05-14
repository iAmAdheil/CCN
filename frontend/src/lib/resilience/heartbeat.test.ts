// Vitest port of __smoke_heartbeat.ts. Uses vitest fake timers instead of
// the hand-rolled stub.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatTracker } from './heartbeat';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HeartbeatTracker', () => {
  it('records RTT on a successful pong', () => {
    const sent: unknown[] = [];
    const tracker = new HeartbeatTracker({ intervalMs: 100 });
    tracker.start();
    tracker.addPeer('p1', (obj) => {
      sent.push(obj);
      return true;
    });
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    const ping = sent[0] as { type: string; id: number; t: number };
    const pong = tracker.handlePing(ping);
    expect(pong).not.toBeNull();
    expect(tracker.handlePong('p1', pong!)).toBe(true);
    const snap = tracker.snapshot();
    expect(snap['p1']!.status).toBe('healthy');
    expect(snap['p1']!.rttMs).not.toBeNull();
  });

  it('escalates through stale → unhealthy → dead on missed pongs', () => {
    let unhealthyFor: string | null = null;
    const tracker = new HeartbeatTracker({
      intervalMs: 100,
      staleAfterMisses: 1,
      unhealthyAfterMisses: 2,
      deadAfterMisses: 3,
      onUnhealthy: (id) => {
        unhealthyFor = id;
      },
    });
    tracker.start();
    tracker.addPeer('p2', () => true);
    vi.advanceTimersByTime(100); // ping #1, no decision yet
    expect(tracker.snapshot()['p2']!.status).toBe('healthy');
    vi.advanceTimersByTime(100); // miss counted, status -> stale
    expect(tracker.snapshot()['p2']!.status).toBe('stale');
    vi.advanceTimersByTime(100);
    expect(tracker.snapshot()['p2']!.status).toBe('unhealthy');
    expect(unhealthyFor).toBe('p2');
    vi.advanceTimersByTime(100);
    expect(tracker.snapshot()['p2']!.status).toBe('dead');
  });

  it('recovers to healthy after a late pong', () => {
    const sent: Array<{ type: string; id: number; t: number }> = [];
    const tracker = new HeartbeatTracker({ intervalMs: 100, staleAfterMisses: 1 });
    tracker.start();
    tracker.addPeer('p3', (obj) => {
      sent.push(obj as { type: string; id: number; t: number });
      return true;
    });
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(tracker.snapshot()['p3']!.status).toBe('stale');
    const pong = tracker.handlePing(sent[sent.length - 1]!)!;
    tracker.handlePong('p3', pong);
    expect(tracker.snapshot()['p3']!.status).toBe('healthy');
  });

  it('rejects malformed handlePing input', () => {
    const tracker = new HeartbeatTracker();
    expect(tracker.handlePing('nope')).toBeNull();
    expect(tracker.handlePing({ type: 'wrong', id: 1, t: 1 })).toBeNull();
    expect(tracker.handlePing({ type: 'hb-ping', t: 1 })).toBeNull();
    expect(tracker.handlePing({ type: 'hb-ping', id: 1, t: 1 })).not.toBeNull();
  });
});
