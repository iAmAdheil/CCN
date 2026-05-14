// ICE configuration source. The signaling server's /turn-credentials endpoint
// returns time-limited credentials (HMAC-SHA1 over expiry+userId). We cache
// the response and refresh well before TTL. If the endpoint is unreachable or
// returns no TURN entry, we fall back to STUN-only — the app keeps working,
// just without NAT-relay support for symmetric NATs / strict firewalls.

const STUN_FALLBACK: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// Re-exported for legacy callers; treat this as the fallback only.
export const config: RTCConfiguration = STUN_FALLBACK;

interface CredentialsResponse {
  iceServers: RTCIceServer[];
  ttl: number;
  expiresAt: number;
  turnAvailable: boolean;
}

let cached: { config: RTCConfiguration; expiresAt: number; turnAvailable: boolean } | null = null;
let inFlight: Promise<RTCConfiguration> | null = null;

function signalUrl(): string {
  return (
    (import.meta as unknown as { env?: { VITE_SIGNAL_URL?: string } }).env?.VITE_SIGNAL_URL
    ?? `${window.location.protocol}//${window.location.hostname}:3000`
  );
}

export async function fetchRtcConfig(userId?: string): Promise<RTCConfiguration> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const url = new URL("/turn-credentials", signalUrl());
      if (userId) url.searchParams.set("userId", userId);
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error(`/turn-credentials returned ${resp.status}`);
      const data = (await resp.json()) as CredentialsResponse;
      if (!data || !Array.isArray(data.iceServers) || data.iceServers.length === 0) {
        throw new Error("invalid /turn-credentials payload");
      }
      cached = {
        config: { iceServers: data.iceServers },
        expiresAt: data.expiresAt || 0,
        turnAvailable: !!data.turnAvailable,
      };
      return cached.config;
    } catch (e) {
      console.warn("Failed to fetch ICE config; falling back to STUN-only.", e);
      cached = { config: STUN_FALLBACK, expiresAt: 0, turnAvailable: false };
      return STUN_FALLBACK;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function getCachedRtcConfig(): RTCConfiguration {
  return cached?.config ?? STUN_FALLBACK;
}

// Returns true if cached config is still valid for at least `safetyMs` more.
export function rtcConfigIsFresh(safetyMs = 30_000): boolean {
  if (!cached) return false;
  // STUN-only fallback never "expires" — treat as fresh forever.
  if (!cached.turnAvailable) return true;
  return cached.expiresAt > Date.now() + safetyMs;
}
