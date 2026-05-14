import { useEffect, useRef, useState, type MutableRefObject } from "react";

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

export interface IceCandidateInfo {
  side: "local" | "remote";
  candidateType: CandidateType;
  address?: string;
  port?: number;
  protocol?: string;        // udp | tcp
  relayProtocol?: string;   // for relay candidates: udp | tcp | tls
  networkType?: string;
  priority?: number;
}

export interface SelectedPairInfo {
  localType: CandidateType;
  remoteType: CandidateType;
  localAddress?: string;
  remoteAddress?: string;
  protocol?: string;
  relayProtocol?: string;
  currentRoundTripTimeMs?: number;
  availableOutgoingBitrate?: number;
  availableIncomingBitrate?: number;
  bytesSent: number;
  bytesReceived: number;
  state?: string;
}

export interface MediaInboundStats {
  kind: "video" | "audio";
  codec?: string;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitterMs: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
}

export interface MediaOutboundStats {
  kind: "video" | "audio";
  codec?: string;
  bytesSent: number;
  packetsSent: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
}

export interface PeerStats {
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  selectedPair: SelectedPairInfo | null;
  candidates: IceCandidateInfo[];
  inbound: MediaInboundStats[];
  outbound: MediaOutboundStats[];
  inboundBps: number;
  outboundBps: number;
  packetLossPct: number;       // 0..100, computed across all inbound RTP since last tick
  history: Array<{ t: number; inBps: number; outBps: number; rttMs: number }>;
}

// Permissive structural type covering the subset of RTCStats fields we read.
// We can't rely on lib.dom alone — many useful fields (availableOutgoingBitrate,
// framesPerSecond, etc.) are spec-extension fields not in the baseline typing.
interface RtcStat {
  id: string;
  type: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  state?: string;
  nominated?: boolean;
  currentRoundTripTime?: number;
  availableOutgoingBitrate?: number;
  availableIncomingBitrate?: number;
  bytesSent?: number;
  bytesReceived?: number;
  candidateType?: string;
  address?: string;
  ip?: string;
  port?: number;
  protocol?: string;
  relayProtocol?: string;
  networkType?: string;
  priority?: number;
  mimeType?: string;
  kind?: string;
  isRemote?: boolean;
  packetsLost?: number;
  packetsReceived?: number;
  packetsSent?: number;
  jitter?: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  codecId?: string;
}

interface PrevSample {
  bytesIn: number;
  bytesOut: number;
  packetsLost: number;
  packetsReceived: number;
  t: number;
}

const MAX_HISTORY = 60;

function asCandidateType(t: string | undefined): CandidateType {
  if (t === "host" || t === "srflx" || t === "prflx" || t === "relay") return t;
  return "unknown";
}

function codecFromMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  // "video/VP8" -> "VP8"
  const slash = mime.indexOf("/");
  return slash >= 0 ? mime.slice(slash + 1) : mime;
}

async function collectPeerStats(
  peerId: string,
  pc: RTCPeerConnection,
  prev: PrevSample | undefined,
  now: number
): Promise<{ stats: Omit<PeerStats, "history">; sample: PrevSample }> {
  const report = await pc.getStats();

  let transport: RtcStat | null = null;
  const pairsById: Record<string, RtcStat> = {};
  const localCandsById: Record<string, RtcStat> = {};
  const remoteCandsById: Record<string, RtcStat> = {};
  const codecsById: Record<string, RtcStat> = {};
  const inboundRtp: RtcStat[] = [];
  const outboundRtp: RtcStat[] = [];

  report.forEach((raw) => {
    const s = raw as RtcStat;
    switch (s.type) {
      case "transport":
        transport = s;
        break;
      case "candidate-pair":
        pairsById[s.id] = s;
        break;
      case "local-candidate":
        localCandsById[s.id] = s;
        break;
      case "remote-candidate":
        remoteCandsById[s.id] = s;
        break;
      case "codec":
        codecsById[s.id] = s;
        break;
      case "inbound-rtp":
        if (!s.isRemote) inboundRtp.push(s);
        break;
      case "outbound-rtp":
        if (!s.isRemote) outboundRtp.push(s);
        break;
    }
  });

  // Resolve selected pair: prefer transport.selectedCandidatePairId, else any nominated+succeeded.
  let selectedPairStat: RtcStat | null = null;
  const selectedId = transport?.selectedCandidatePairId;
  if (selectedId && pairsById[selectedId]) {
    selectedPairStat = pairsById[selectedId];
  } else {
    for (const p of Object.values(pairsById)) {
      if (p.nominated && p.state === "succeeded") {
        selectedPairStat = p;
        break;
      }
    }
  }

  let selectedPair: SelectedPairInfo | null = null;
  if (selectedPairStat) {
    const local = localCandsById[selectedPairStat.localCandidateId];
    const remote = remoteCandsById[selectedPairStat.remoteCandidateId];
    selectedPair = {
      localType: asCandidateType(local?.candidateType),
      remoteType: asCandidateType(remote?.candidateType),
      localAddress: local ? `${local.address ?? local.ip ?? "?"}:${local.port ?? "?"}` : undefined,
      remoteAddress: remote ? `${remote.address ?? remote.ip ?? "?"}:${remote.port ?? "?"}` : undefined,
      protocol: local?.protocol,
      relayProtocol: local?.relayProtocol,
      currentRoundTripTimeMs:
        typeof selectedPairStat.currentRoundTripTime === "number"
          ? selectedPairStat.currentRoundTripTime * 1000
          : undefined,
      availableOutgoingBitrate: selectedPairStat.availableOutgoingBitrate,
      availableIncomingBitrate: selectedPairStat.availableIncomingBitrate,
      bytesSent: selectedPairStat.bytesSent ?? 0,
      bytesReceived: selectedPairStat.bytesReceived ?? 0,
      state: selectedPairStat.state,
    };
  }

  const candidates: IceCandidateInfo[] = [];
  for (const c of Object.values(localCandsById)) {
    candidates.push({
      side: "local",
      candidateType: asCandidateType(c.candidateType),
      address: c.address ?? c.ip,
      port: c.port,
      protocol: c.protocol,
      relayProtocol: c.relayProtocol,
      networkType: c.networkType,
      priority: c.priority,
    });
  }
  for (const c of Object.values(remoteCandsById)) {
    candidates.push({
      side: "remote",
      candidateType: asCandidateType(c.candidateType),
      address: c.address ?? c.ip,
      port: c.port,
      protocol: c.protocol,
      relayProtocol: c.relayProtocol,
    });
  }

  const inbound: MediaInboundStats[] = inboundRtp
    .filter((s): s is RtcStat & { kind: "video" | "audio" } => s.kind === "video" || s.kind === "audio")
    .map((s) => ({
      kind: s.kind,
      codec: codecFromMime(s.codecId ? codecsById[s.codecId]?.mimeType : undefined),
      bytesReceived: s.bytesReceived ?? 0,
      packetsReceived: s.packetsReceived ?? 0,
      packetsLost: s.packetsLost ?? 0,
      jitterMs: typeof s.jitter === "number" ? s.jitter * 1000 : 0,
      framesPerSecond: s.framesPerSecond,
      frameWidth: s.frameWidth,
      frameHeight: s.frameHeight,
    }));

  const outbound: MediaOutboundStats[] = outboundRtp
    .filter((s): s is RtcStat & { kind: "video" | "audio" } => s.kind === "video" || s.kind === "audio")
    .map((s) => ({
      kind: s.kind,
      codec: codecFromMime(s.codecId ? codecsById[s.codecId]?.mimeType : undefined),
      bytesSent: s.bytesSent ?? 0,
      packetsSent: s.packetsSent ?? 0,
      framesPerSecond: s.framesPerSecond,
      frameWidth: s.frameWidth,
      frameHeight: s.frameHeight,
    }));

  const totalBytesIn = inbound.reduce((a, s) => a + s.bytesReceived, 0);
  const totalBytesOut = outbound.reduce((a, s) => a + s.bytesSent, 0);
  const totalPacketsLost = inbound.reduce((a, s) => a + s.packetsLost, 0);
  const totalPacketsReceived = inbound.reduce((a, s) => a + s.packetsReceived, 0);

  let inBps = 0;
  let outBps = 0;
  let packetLossPct = 0;
  if (prev && now > prev.t) {
    const dt = (now - prev.t) / 1000;
    inBps = Math.max(0, ((totalBytesIn - prev.bytesIn) * 8) / dt);
    outBps = Math.max(0, ((totalBytesOut - prev.bytesOut) * 8) / dt);
    const dLost = Math.max(0, totalPacketsLost - prev.packetsLost);
    const dRecv = Math.max(0, totalPacketsReceived - prev.packetsReceived);
    const denom = dLost + dRecv;
    packetLossPct = denom > 0 ? (dLost / denom) * 100 : 0;
  }

  return {
    stats: {
      peerId,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      selectedPair,
      candidates,
      inbound,
      outbound,
      inboundBps: inBps,
      outboundBps: outBps,
      packetLossPct,
    },
    sample: {
      bytesIn: totalBytesIn,
      bytesOut: totalBytesOut,
      packetsLost: totalPacketsLost,
      packetsReceived: totalPacketsReceived,
      t: now,
    },
  };
}

export function useWebRTCStats(
  pcsRef: MutableRefObject<Record<string, RTCPeerConnection>>,
  options: { intervalMs?: number; enabled?: boolean } = {}
): Record<string, PeerStats> {
  const { intervalMs = 1000, enabled = true } = options;
  const [stats, setStats] = useState<Record<string, PeerStats>>({});
  const prevRef = useRef<Record<string, PrevSample>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      const peers = pcsRef.current;
      const peerIds = Object.keys(peers);
      const now = Date.now();

      const results = await Promise.all(
        peerIds.map(async (id) => {
          try {
            return await collectPeerStats(id, peers[id], prevRef.current[id], now);
          } catch {
            return null;
          }
        })
      );

      if (cancelled) return;

      setStats((prev) => {
        const next: Record<string, PeerStats> = {};
        results.forEach((r, i) => {
          if (!r) return;
          const id = peerIds[i];
          prevRef.current[id] = r.sample;
          const prevHistory = prev[id]?.history ?? [];
          const sample = {
            t: now,
            inBps: r.stats.inboundBps,
            outBps: r.stats.outboundBps,
            rttMs: r.stats.selectedPair?.currentRoundTripTimeMs ?? 0,
          };
          next[id] = {
            ...r.stats,
            history: [...prevHistory.slice(-(MAX_HISTORY - 1)), sample],
          };
        });
        // Drop prev samples for peers that disappeared
        for (const id of Object.keys(prevRef.current)) {
          if (!next[id]) delete prevRef.current[id];
        }
        return next;
      });
    };

    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [pcsRef, intervalMs, enabled]);

  return stats;
}

export function formatBitrate(bps: number): string {
  if (!isFinite(bps) || bps <= 0) return "0 bps";
  if (bps < 1_000) return `${bps.toFixed(0)} bps`;
  if (bps < 1_000_000) return `${(bps / 1_000).toFixed(1)} Kbps`;
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function describePath(pair: SelectedPairInfo | null): string {
  if (!pair) return "Not connected";
  const l = pair.localType;
  const r = pair.remoteType;
  if (l === "host" && r === "host") return "Direct (LAN — no NAT traversal)";
  if (l === "relay" || r === "relay")
    return "Relayed via TURN (symmetric NAT or strict firewall on at least one side)";
  if (l === "srflx" || r === "srflx") return "STUN-assisted (NAT traversal succeeded)";
  if (l === "prflx" || r === "prflx") return "Peer-reflexive (discovered via connectivity check)";
  return "Unknown path";
}
