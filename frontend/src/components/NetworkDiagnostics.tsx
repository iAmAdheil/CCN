import { useMemo, useState, type MutableRefObject } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Activity, ChevronDown, Network } from "lucide-react";
import {
  useWebRTCStats,
  formatBitrate,
  formatBytes,
  describePath,
  type CandidateType,
  type PeerStats,
} from "@/hooks/useWebRTCStats";

interface NetworkDiagnosticsProps {
  pcsRef: MutableRefObject<Record<string, RTCPeerConnection>>;
  participants: Array<{ id: string; username: string }>;
  sfu?: {
    mode: "mesh" | "sfu";
    peers: number;
    producers: number;
    consumers: number;
  };
  mediaE2EE?: {
    hasKey: boolean;
    keyId: number | null;
  };
}

// Heuristic per-peer media bitrate used for the SFU/mesh comparison. Real
// measurements would come from getStats() on each Producer/Consumer; this
// estimate is sufficient to make the O(N) vs O(1) story for the demo.
const ESTIMATED_BITRATE_KBPS = 600 /* video */ + 32 /* audio */;

function SfuComparisonCard({
  mode,
  peers,
  producers,
  consumers,
  mediaE2EE,
}: NonNullable<NetworkDiagnosticsProps["sfu"]> & {
  mediaE2EE?: NetworkDiagnosticsProps["mediaE2EE"];
}) {
  // Peers here is the count of *other* participants in the room. In mesh mode
  // each peer maintains an RTCPeerConnection with every other peer and
  // uplinks one copy per peer. In SFU each peer uplinks exactly once.
  const meshUpKbps = peers * ESTIMATED_BITRATE_KBPS;
  const sfuUpKbps = peers > 0 ? ESTIMATED_BITRATE_KBPS : 0;
  const savingsPct = meshUpKbps > 0 ? Math.round(((meshUpKbps - sfuUpKbps) / meshUpKbps) * 100) : 0;
  const isSfu = mode === "sfu";
  return (
    <Card className="p-4 space-y-3 border-primary/40">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold flex items-center gap-2">
            Transport mode
            <Badge
              variant="outline"
              className={
                isSfu
                  ? "border-blue-500/40 text-blue-600 dark:text-blue-400 uppercase text-[10px]"
                  : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 uppercase text-[10px]"
              }
            >
              {mode}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isSfu ? "Router forwards media — uplink is O(1) per peer." : "Full mesh — uplink is O(N) per peer."}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Peers</div>
          <div className="font-mono text-lg">{peers}</div>
        </div>
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Your upstream</div>
          <div className="font-mono text-sm">
            {isSfu ? formatBitrate(sfuUpKbps * 1000) : formatBitrate(meshUpKbps * 1000)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {isSfu ? "1× video+audio" : `${peers}× video+audio`}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {isSfu ? "Mesh would have cost" : "SFU would cost"}
          </div>
          <div className="font-mono text-sm">
            {isSfu ? formatBitrate(meshUpKbps * 1000) : formatBitrate(sfuUpKbps * 1000)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {savingsPct > 0 ? `−${savingsPct}% via SFU` : "—"}
          </div>
        </div>
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-3 text-xs">
        <Stat label="Producers" value={String(producers)} />
        <Stat label="Consumers" value={String(consumers)} />
      </div>
      <div className="text-[10px] text-muted-foreground">
        Upstream estimate uses {ESTIMATED_BITRATE_KBPS} Kbps per stream (typical
        cam + mic). Live per-stream bitrates land with Tier 3 observability.
      </div>
      {mediaE2EE && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Media E2EE</div>
            {mediaE2EE.hasKey ? (
              <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                keyed{mediaE2EE.keyId !== null ? ` · 0x${mediaE2EE.keyId.toString(16).padStart(8, "0")}` : ""}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">
                waiting for room key
              </Badge>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {mediaE2EE.hasKey
              ? "AES-GCM per-frame encryption applied; the SFU forwards opaque bytes."
              : "Frames suppressed until the room media key arrives via DC."}
          </div>
        </>
      )}
    </Card>
  );
}

const candidateTypeColor: Record<CandidateType, string> = {
  host: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  srflx: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  prflx: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
  relay: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  unknown: "bg-muted text-muted-foreground border-border",
};

function StateBadge({ state }: { state: string }) {
  const ok = state === "connected" || state === "completed";
  const warn = state === "checking" || state === "new" || state === "gathering";
  const bad = state === "failed" || state === "disconnected" || state === "closed";
  const cls = ok
    ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
    : bad
      ? "border-destructive/30 text-destructive"
      : warn
        ? "border-amber-500/30 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${cls}`}>
      {state}
    </Badge>
  );
}

function CandidateTypeChip({ type }: { type: CandidateType }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border ${candidateTypeColor[type]}`}
      title={typeExplain(type)}
    >
      {type}
    </span>
  );
}

function typeExplain(t: CandidateType): string {
  switch (t) {
    case "host":
      return "host: a local IP (LAN, VPN, or loopback)";
    case "srflx":
      return "srflx: server-reflexive — public IP discovered via STUN";
    case "prflx":
      return "prflx: peer-reflexive — discovered during connectivity checks";
    case "relay":
      return "relay: TURN-relayed (a TURN server forwards media)";
    default:
      return "unknown candidate type";
  }
}

function PeerCard({ peer, peerStats }: { peer: { id: string; username: string }; peerStats: PeerStats | undefined }) {
  const [candOpen, setCandOpen] = useState(false);

  const chartData = useMemo(() => {
    if (!peerStats) return [];
    const t0 = peerStats.history[0]?.t ?? Date.now();
    return peerStats.history.map((s) => ({
      t: Math.round((s.t - t0) / 1000),
      "in (Kbps)": +(s.inBps / 1000).toFixed(1),
      "out (Kbps)": +(s.outBps / 1000).toFixed(1),
    }));
  }, [peerStats]);

  if (!peerStats) {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold">{peer.username}</div>
          <Badge variant="outline" className="text-[10px]">collecting…</Badge>
        </div>
      </Card>
    );
  }

  const pair = peerStats.selectedPair;
  const inboundVideo = peerStats.inbound.find((s) => s.kind === "video");
  const inboundAudio = peerStats.inbound.find((s) => s.kind === "audio");
  const outboundVideo = peerStats.outbound.find((s) => s.kind === "video");

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{peer.username}</div>
          <div className="text-[11px] text-muted-foreground font-mono break-all">{peer.id}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StateBadge state={peerStats.connectionState} />
          <span className="text-[10px] text-muted-foreground">
            ICE: {peerStats.iceConnectionState} · gather: {peerStats.iceGatheringState}
          </span>
        </div>
      </div>

      <Separator />

      <div>
        <div className="text-xs font-medium mb-1">Selected path</div>
        {pair ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <CandidateTypeChip type={pair.localType} />
              <span className="font-mono text-[11px] text-muted-foreground">{pair.localAddress}</span>
              <span className="text-muted-foreground">→</span>
              <CandidateTypeChip type={pair.remoteType} />
              <span className="font-mono text-[11px] text-muted-foreground">{pair.remoteAddress}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {describePath(pair)}
              {pair.protocol ? ` · ${pair.protocol.toUpperCase()}` : ""}
              {pair.relayProtocol ? ` (relay ${pair.relayProtocol.toUpperCase()})` : ""}
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs pt-1">
              <Stat label="RTT" value={pair.currentRoundTripTimeMs != null ? `${pair.currentRoundTripTimeMs.toFixed(1)} ms` : "—"} />
              <Stat label="Sent" value={formatBytes(pair.bytesSent)} />
              <Stat label="Recv" value={formatBytes(pair.bytesReceived)} />
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No nominated candidate pair yet.</div>
        )}
      </div>

      <Separator />

      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Inbound" value={formatBitrate(peerStats.inboundBps)} />
        <Stat label="Outbound" value={formatBitrate(peerStats.outboundBps)} />
        <Stat label="Loss" value={`${peerStats.packetLossPct.toFixed(2)}%`} />
      </div>

      {(inboundVideo || inboundAudio || outboundVideo) && (
        <>
          <Separator />
          <div className="space-y-1.5 text-xs">
            {inboundVideo && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">in video</span>
                <span className="font-mono text-[11px]">
                  {inboundVideo.codec ?? "?"} ·{" "}
                  {inboundVideo.frameWidth && inboundVideo.frameHeight
                    ? `${inboundVideo.frameWidth}×${inboundVideo.frameHeight}`
                    : "?"}{" "}
                  · {inboundVideo.framesPerSecond?.toFixed(0) ?? "?"} fps · jitter{" "}
                  {inboundVideo.jitterMs.toFixed(1)} ms
                </span>
              </div>
            )}
            {inboundAudio && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">in audio</span>
                <span className="font-mono text-[11px]">
                  {inboundAudio.codec ?? "?"} · jitter {inboundAudio.jitterMs.toFixed(1)} ms · lost{" "}
                  {inboundAudio.packetsLost}
                </span>
              </div>
            )}
            {outboundVideo && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">out video</span>
                <span className="font-mono text-[11px]">
                  {outboundVideo.codec ?? "?"} ·{" "}
                  {outboundVideo.frameWidth && outboundVideo.frameHeight
                    ? `${outboundVideo.frameWidth}×${outboundVideo.frameHeight}`
                    : "?"}{" "}
                  · {outboundVideo.framesPerSecond?.toFixed(0) ?? "?"} fps
                </span>
              </div>
            )}
          </div>
        </>
      )}

      {chartData.length > 1 && (
        <>
          <Separator />
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} unit="s" />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} width={40} />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="in (Kbps)" stroke="hsl(var(--primary))" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="out (Kbps)" stroke="hsl(var(--accent-foreground))" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <Collapsible open={candOpen} onOpenChange={setCandOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full justify-between h-7 px-2 text-xs">
            <span>{peerStats.candidates.length} ICE candidates</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${candOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="space-y-1 text-[11px] font-mono">
            {peerStats.candidates.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground w-12">{c.side}</span>
                <CandidateTypeChip type={c.candidateType} />
                <span className="text-muted-foreground">{c.protocol ?? ""}</span>
                <span className="truncate">
                  {c.address ?? "?"}:{c.port ?? "?"}
                  {c.relayProtocol ? ` (relay ${c.relayProtocol})` : ""}
                </span>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}

const NetworkDiagnostics = ({ pcsRef, participants, sfu, mediaE2EE }: NetworkDiagnosticsProps) => {
  const [open, setOpen] = useState(false);
  const stats = useWebRTCStats(pcsRef, { enabled: open, intervalMs: 1000 });

  // Show one card per remote peer that has an active mesh PC. In SFU mode
  // there are no mesh PCs, so this list is empty — the SfuComparisonCard
  // carries the diagnostics narrative instead.
  const remotePeers = participants.filter((p) => pcsRef.current[p.id]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Activity className="w-4 h-4" />
          <span className="hidden sm:inline">Network</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md p-0">
        <div className="flex flex-col h-full">
          <div className="p-4 border-b">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Network className="w-4 h-4" /> Network diagnostics
              </SheetTitle>
            </SheetHeader>
            <p className="text-[11px] text-muted-foreground mt-1">
              Live WebRTC stats per peer · candidate path · RTT · bitrate · loss · codec
            </p>
          </div>
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-3">
              {sfu && <SfuComparisonCard {...sfu} mediaE2EE={mediaE2EE} />}
              {sfu?.mode === "mesh" && remotePeers.length === 0 && (
                <div className="text-sm text-muted-foreground">No active peer connections.</div>
              )}
              {remotePeers.map((p) => (
                <PeerCard key={p.id} peer={p} peerStats={stats[p.id]} />
              ))}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default NetworkDiagnostics;
