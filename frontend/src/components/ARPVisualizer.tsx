import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Cpu, Send, Zap } from "lucide-react";
import type { ArpSession, ArpSessionSnapshot } from "@/lib/arpSession";
import type { SenderMode } from "@/lib/arpProtocol";

interface ARPVisualizerProps {
  arpSessionsRef: MutableRefObject<Record<string, ArpSession>>;
  participants: Array<{ id: string; username: string }>;
  // Bumps from parent when sessions add/remove — included in deps so the
  // peer-list memo invalidates.
  channelTick: number;
}

interface HistorySample {
  t: number;       // seconds since chart start
  cwnd: number;
  ssthresh: number;
  rttMs: number;
  inFlight: number;
  throughputKbps: number;
}

const POLL_INTERVAL_MS = 200;
const HISTORY_SECONDS = 60;
const HISTORY_MAX = (HISTORY_SECONDS * 1000) / POLL_INTERVAL_MS; // = 300 samples

function modeColor(m: SenderMode): string {
  if (m === "slow-start") return "border-blue-500/30 text-blue-600 dark:text-blue-400";
  if (m === "cong-avoid") return "border-emerald-500/30 text-emerald-600 dark:text-emerald-400";
  return "border-amber-500/30 text-amber-600 dark:text-amber-400";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const ARPVisualizer = ({ arpSessionsRef, participants, channelTick }: ARPVisualizerProps) => {
  const [open, setOpen] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ArpSessionSnapshot | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [lossPct, setLossPct] = useState(0);
  const lastBytesAckedRef = useRef(0);
  const lastSampleAtRef = useRef(0);
  const chartStartRef = useRef(0);

  // Available peers: only those with an active session. Use channelTick so
  // this memo invalidates when the parent ref changes.
  const availablePeers = useMemo(() => {
    void channelTick;
    return participants.filter((p) => arpSessionsRef.current[p.id]);
  }, [arpSessionsRef, channelTick, participants]);

  // Auto-pick the first available peer on open / when the current selection
  // disappears.
  useEffect(() => {
    if (!open) return;
    if (selectedPeer && availablePeers.some((p) => p.id === selectedPeer)) return;
    setSelectedPeer(availablePeers[0]?.id ?? null);
  }, [availablePeers, open, selectedPeer]);

  // Keep loss-injection probability in sync with the slider on the active
  // session.
  useEffect(() => {
    if (!selectedPeer) return;
    const session = arpSessionsRef.current[selectedPeer];
    if (session) session.outboundLossPct = lossPct / 100;
  }, [arpSessionsRef, lossPct, selectedPeer]);

  // Reset chart history + counters whenever the user switches peers.
  useEffect(() => {
    if (!selectedPeer) {
      setHistory([]);
      setSnapshot(null);
      return;
    }
    setHistory([]);
    chartStartRef.current = performance.now();
    lastBytesAckedRef.current = arpSessionsRef.current[selectedPeer]?.snapshot().sender.bytesAcked ?? 0;
    lastSampleAtRef.current = 0;
  }, [selectedPeer]);

  // Polling loop — only ticks while the sheet is open.
  useEffect(() => {
    if (!open || !selectedPeer) return;
    let cancelled = false;
    const sample = () => {
      if (cancelled) return;
      const session = arpSessionsRef.current[selectedPeer];
      if (!session) {
        setSnapshot(null);
        return;
      }
      const snap = session.snapshot();
      setSnapshot(snap);

      const now = performance.now();
      const lastAt = lastSampleAtRef.current || now - POLL_INTERVAL_MS;
      const dtSec = Math.max((now - lastAt) / 1000, 0.001);
      const ackedDelta = Math.max(0, snap.sender.bytesAcked - lastBytesAckedRef.current);
      lastBytesAckedRef.current = snap.sender.bytesAcked;
      lastSampleAtRef.current = now;

      const t = (now - chartStartRef.current) / 1000;
      const next: HistorySample = {
        t: +t.toFixed(2),
        cwnd: +snap.sender.cwnd.toFixed(2),
        ssthresh: snap.sender.ssthresh,
        rttMs: +snap.sender.rttSrtt.toFixed(2),
        inFlight: snap.sender.inFlight,
        throughputKbps: +((ackedDelta * 8) / dtSec / 1000).toFixed(1),
      };
      setHistory((prev) => {
        const trimmed = prev.length >= HISTORY_MAX ? prev.slice(prev.length - HISTORY_MAX + 1) : prev;
        return [...trimmed, next];
      });
    };

    sample();
    const handle = window.setInterval(sample, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [arpSessionsRef, open, selectedPeer]);

  const sendDemoBytes = (kb: number) => {
    if (!selectedPeer) return;
    const session = arpSessionsRef.current[selectedPeer];
    if (!session) return;
    const buf = new Uint8Array(kb * 1024);
    // Fill with a non-zero pattern so we can see real bytes flowing.
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    session.send(buf);
  };

  const senderSnap = snapshot?.sender;
  const recvSnap = snapshot?.receiver;

  const cwndChartMax = useMemo(() => {
    if (history.length === 0) return 16;
    const max = Math.max(...history.map((h) => Math.max(h.cwnd, h.ssthresh)));
    return Math.max(8, Math.ceil(max * 1.2));
  }, [history]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Cpu className="w-4 h-4" />
          <span className="hidden sm:inline">ARP</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0">
        <div className="flex flex-col h-full">
          <div className="p-4 border-b">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Cpu className="w-4 h-4" /> ARP — application reliable protocol
              </SheetTitle>
            </SheetHeader>
            <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
              Custom TCP-Reno-style transport over an unreliable WebRTC DataChannel
              ({"{"} ordered: false, maxRetransmits: 0 {"}"}). Slow-start → AIMD,
              fast-retransmit on 3 dup-ACKs, RTO with Karn's algorithm, RTT smoothed
              by Jacobson/Karels.
            </p>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Peer</div>
                <Select
                  value={selectedPeer ?? ""}
                  onValueChange={(v) => setSelectedPeer(v || null)}
                  disabled={availablePeers.length === 0}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={availablePeers.length === 0 ? "No peers" : "Select peer"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePeers.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.username} <span className="text-muted-foreground">· {p.id.slice(0, 6)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {!senderSnap ? (
                <Card className="p-4 text-xs text-muted-foreground">
                  {availablePeers.length === 0
                    ? "Open this in a room with at least one connected peer."
                    : "Collecting snapshot..."}
                </Card>
              ) : (
                <>
                  <Card className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={`text-[10px] uppercase ${modeColor(senderSnap.mode)}`}>
                        {senderSnap.mode}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] uppercase border-border">
                        {snapshot!.channelState}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Stat label="cwnd" value={senderSnap.cwnd.toFixed(1)} />
                      <Stat label="ssthresh" value={String(senderSnap.ssthresh)} />
                      <Stat label="in flight" value={String(senderSnap.inFlight)} />
                      <Stat label="srtt" value={`${senderSnap.rttSrtt.toFixed(1)} ms`} />
                      <Stat label="rttvar" value={`${senderSnap.rttVar.toFixed(1)} ms`} />
                      <Stat label="rto" value={`${senderSnap.rto.toFixed(0)} ms`} />
                      <Stat label="sent" value={formatBytes(senderSnap.bytesSent)} />
                      <Stat label="acked" value={formatBytes(senderSnap.bytesAcked)} />
                      <Stat label="queue" value={String(senderSnap.sendQueue)} />
                      <Stat label="retransmits" value={String(senderSnap.retransmits)} />
                      <Stat label="fast rtx" value={String(senderSnap.fastRetransmits)} />
                      <Stat label="rto exp." value={String(senderSnap.rtoExpiries)} />
                    </div>
                  </Card>

                  {history.length > 1 && (
                    <Card className="p-3">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">cwnd vs ssthresh</div>
                      <div className="h-32">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={history} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                            <XAxis dataKey="t" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} unit="s" />
                            <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} width={40} domain={[0, cwndChartMax]} />
                            <Tooltip contentStyle={{ fontSize: 11 }} />
                            <Line type="stepAfter" dataKey="cwnd" stroke="hsl(var(--primary))" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                            <Line type="stepAfter" dataKey="ssthresh" stroke="hsl(38 92% 50%)" strokeDasharray="4 4" dot={false} strokeWidth={1.2} isAnimationActive={false} />
                            <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.2} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  )}

                  {history.length > 1 && (
                    <Card className="p-3">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        rtt smoothed (ms) · throughput (Kbps)
                      </div>
                      <div className="h-32">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={history} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                            <XAxis dataKey="t" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} unit="s" />
                            <YAxis yAxisId="rtt" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} width={40} />
                            <YAxis yAxisId="bw" orientation="right" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} width={40} />
                            <Tooltip contentStyle={{ fontSize: 11 }} />
                            <Line yAxisId="rtt" type="monotone" dataKey="rttMs" stroke="hsl(142 71% 45%)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                            <Line yAxisId="bw" type="monotone" dataKey="throughputKbps" stroke="hsl(217 91% 60%)" dot={false} strokeWidth={1.2} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  )}

                  <Card className="p-3 space-y-3">
                    <div>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-muted-foreground">Outbound loss injection</span>
                        <span className="font-mono">{lossPct.toFixed(0)}%</span>
                      </div>
                      <Slider
                        value={[lossPct]}
                        onValueChange={(v) => setLossPct(v[0] ?? 0)}
                        min={0}
                        max={50}
                        step={1}
                      />
                      <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                        Drops the chosen percentage of outgoing DATA frames before they
                        hit the wire. Watch the cwnd chart react to dup-ACKs and RTO.
                      </p>
                    </div>
                    <Separator />
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">Push synthetic data through the protocol:</div>
                      <div className="grid grid-cols-3 gap-2">
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => sendDemoBytes(64)}>
                          <Send className="w-3.5 h-3.5" /> 64 KB
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => sendDemoBytes(256)}>
                          <Send className="w-3.5 h-3.5" /> 256 KB
                        </Button>
                        <Button size="sm" className="gap-1.5 text-xs" onClick={() => sendDemoBytes(1024)}>
                          <Zap className="w-3.5 h-3.5" /> 1 MB
                        </Button>
                      </div>
                    </div>
                  </Card>

                  {recvSnap && (
                    <Card className="p-3">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Receiver (this end)</div>
                      <div className="grid grid-cols-4 gap-2">
                        <Stat label="delivered" value={formatBytes(recvSnap.bytesDelivered)} />
                        <Stat label="next seq" value={String(recvSnap.expectedSeq)} />
                        <Stat label="ooo buf" value={String(recvSnap.outOfOrder)} />
                        <Stat label="dup data" value={String(recvSnap.duplicates)} />
                      </div>
                    </Card>
                  )}

                  {snapshot && snapshot.packetLog.length > 0 && (
                    <Card className="p-3">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        Packet log (last {snapshot.packetLog.length})
                      </div>
                      <ScrollArea className="h-44">
                        <div className="font-mono text-[10px] leading-tight space-y-0.5">
                          {snapshot.packetLog
                            .slice()
                            .reverse()
                            .map((e, i) => (
                              <div
                                key={i}
                                className={`flex justify-between gap-2 ${e.drop ? "text-destructive" : e.retransmit ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
                              >
                                <span className="w-12">{e.dir === "tx" ? "→" : "←"} {e.type}</span>
                                <span className="flex-1">
                                  {e.type === "DATA" ? `seq=${e.seq}` : `ack=${e.ack}`}
                                  {e.retransmit ? "  RTX" : ""}
                                  {e.drop ? "  DROP" : ""}
                                </span>
                                <span className="w-14 text-right">{e.bytes ? `${e.bytes}B` : ""}</span>
                              </div>
                            ))}
                        </div>
                      </ScrollArea>
                    </Card>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}

export default ARPVisualizer;
