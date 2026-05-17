import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Video,
  Mic,
  PhoneOff,
  Users,
  Settings,
  MicOff,
  VideoOff,
  MessageCircle,
  Send,
  Paperclip,
  Download,
  ShieldCheck,
  Lock,
  AlertTriangle,
  ChevronDown,
  Wifi,
  WifiOff,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ThemeToggle from "./ThemeToggle";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { RoomUser, type ChatMessage } from "@/pages/Index";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import NetworkDiagnostics from "./NetworkDiagnostics";
import DriveSheet from "./DriveSheet";
import type { DriveApi } from "@/hooks/useDrive";
import type { ConnectionHealth } from "@/hooks/useConnectionHealth";
import type { AbrSnapshot } from "@/lib/abr/abr";
import { safetyNumber } from "@/lib/chatCrypto";
import type { ArpSession } from "@/lib/arpSession";
import ARPVisualizer from "./ARPVisualizer";

interface RoomViewProps {
  roomName: string;
  username: string;
  participants: RoomUser[];
  onLeave: () => void;
  streamRef: React.MutableRefObject<MediaStream | null>;
  pcsRef: React.MutableRefObject<Record<string, RTCPeerConnection>>;
  onVideoToggle: (enabled: boolean) => void;
  onAudioToggle: (enabled: boolean) => void;
  chatMessages: ChatMessage[];
  onSendChat: (text: string) => void;
  onSendFile: (file: File) => Promise<void> | void;
  uploadProgress: number;
  receivedFiles: Array<{ name: string; size: number; url: string; error?: string }>;
  myPubKey: string | null;
  peerPubKeys: Record<string, string>;
  arpSessionsRef: React.MutableRefObject<Record<string, ArpSession>>;
  // Bumps when ARP sessions are added/removed — re-renders the visualizer's
  // peer dropdown so it stays in sync with the ref.
  arpChannelTick: number;
  sfu?: {
    mode: "mesh" | "sfu";
    peers: number;
    producers: number;
    consumers: number;
    abr?: AbrSnapshot | null;
  };
  drive?: DriveApi;
  selfPeerId?: string | null;
  mediaE2EE?: {
    hasKey: boolean;
    keyId: number | null;
  };
  connectionHealth?: ConnectionHealth;
}

function ConnectionHealthPill({ health }: { health: ConnectionHealth }) {
  const peers = Object.values(health.peers);
  const peerCount = peers.length;
  const dead = peers.filter((p) => p.status === "dead").length;
  const unhealthy = peers.filter((p) => p.status === "unhealthy").length;
  const stale = peers.filter((p) => p.status === "stale").length;
  let label: string;
  let icon: JSX.Element;
  let cls: string;
  let title: string;

  if (health.socket === "disconnected") {
    label = "offline";
    icon = <WifiOff className="w-3 h-3" />;
    cls = "border-destructive/40 text-destructive";
    title = "Signaling socket disconnected — peers may be unreachable.";
  } else if (health.socket === "reconnecting") {
    label = health.socketAttempt > 0 ? `reconnecting · #${health.socketAttempt}` : "reconnecting";
    icon = <Loader2 className="w-3 h-3 animate-spin" />;
    cls = "border-amber-500/40 text-amber-600 dark:text-amber-400";
    title = "Lost signaling socket; backing off and retrying.";
  } else if (health.overall === "bad") {
    label = `bad · ${dead + unhealthy}/${peerCount}`;
    icon = <WifiOff className="w-3 h-3" />;
    cls = "border-destructive/40 text-destructive";
    title = "One or more peers stopped responding to heartbeats; ICE restart in flight.";
  } else if (health.overall === "degraded") {
    label = `degraded · ${stale}/${peerCount}`;
    icon = <Wifi className="w-3 h-3" />;
    cls = "border-amber-500/40 text-amber-600 dark:text-amber-400";
    title = "At least one peer's heartbeat is stale.";
  } else {
    label = peerCount > 0 ? `good · ${peerCount}` : "good";
    icon = <Wifi className="w-3 h-3" />;
    cls = "border-emerald-500/30 text-emerald-600 dark:text-emerald-400";
    const rtts = peers.map((p) => p.rttMs).filter((v): v is number => v !== null);
    const avg = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
    title = avg !== null
      ? `Signaling connected; ${peerCount} peer(s) healthy; avg DC RTT ${avg.toFixed(0)} ms.`
      : "Signaling connected; no DC peers yet.";
  }

  return (
    <Badge variant="outline" className={`gap-1.5 text-xs ${cls}`} title={title}>
      {icon}
      <span>{label}</span>
    </Badge>
  );
}

const RoomView = ({
  roomName,
  username,
  participants,
  onLeave,
  streamRef,
  pcsRef,
  onVideoToggle,
  onAudioToggle,
  chatMessages,
  onSendChat,
  onSendFile,
  uploadProgress,
  receivedFiles,
  myPubKey,
  peerPubKeys,
  arpSessionsRef,
  arpChannelTick,
  sfu,
  drive,
  selfPeerId,
  mediaE2EE,
  connectionHealth,
}: RoomViewProps) => {
  const [micMuted, setMicMuted] = useState(false);
  const [isVideo, setIsVideo] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [fileToSend, setFileToSend] = useState<File | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [mailTo, setMailTo] = useState("");
  const [mailSubject, setMailSubject] = useState("");
  const [mailBody, setMailBody] = useState("");
  const [sendingMail, setSendingMail] = useState(false);
  const [mailNotice, setMailNotice] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [safetyNumbers, setSafetyNumbers] = useState<Record<string, string>>({});
  // Verification is session-local — keyed by the peer's pubkey, so if a peer
  // regenerates their keypair the badge resets (correct: it's a different
  // identity now and needs to be re-verified).
  const [verifiedKeys, setVerifiedKeys] = useState<Record<string, boolean>>({});

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Remote participants only — we don't show a safety number for ourselves.
  const remotePeers = useMemo(
    () => participants.filter((p) => p.username !== username),
    [participants, username]
  );

  // Recompute safety numbers when our pubkey or any peer's pubkey changes.
  // This is a SHA-256 over both pubkeys — effectively free even at 100s of
  // calls, so no need to memoize per-peer.
  useEffect(() => {
    if (!myPubKey) {
      setSafetyNumbers({});
      return;
    }
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const [peerId, theirPub] of Object.entries(peerPubKeys)) {
        try {
          next[peerId] = await safetyNumber(myPubKey, theirPub);
        } catch {
          // ignore — next render will retry
        }
      }
      if (!cancelled) setSafetyNumbers(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [myPubKey, peerPubKeys]);

  const encryptedCount = remotePeers.filter((p) => peerPubKeys[p.id]).length;
  const verifiedCount = remotePeers.filter((p) => {
    const k = peerPubKeys[p.id];
    return k && verifiedKeys[k];
  }).length;

  const getGridCols = (count: number) => {
    if (count === 1) return "grid-cols-1";
    if (count === 2) return "grid-cols-1 md:grid-cols-2";
    if (count <= 4) return "grid-cols-1 md:grid-cols-2";
    if (count <= 6) return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
    return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
  };

  const playVideoFromCamera = useCallback(async () => {
    try {
      const constraints = { video: true, audio: true };
      let stream = streamRef.current;
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error("Error opening video camera.", error);
    }
  }, [streamRef, videoRef]);

  const stopVideo = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (isVideo) {
      void playVideoFromCamera();
    } else {
      stopVideo();
    }
  }, [isVideo, playVideoFromCamera, stopVideo]);

  const handleSend = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    onSendChat(text);
    setChatInput("");
  }, [chatInput, onSendChat]);

  const handleFilePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0] ?? null;
      setFileToSend(f);
      setFileNotice(null);
    },
    []
  );

  const handleSendFile = useCallback(async () => {
    if (!fileToSend) return;
    setFileNotice(null);
    try {
      await onSendFile(fileToSend);
      setFileToSend(null);
      setFileNotice("Sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send file";
      setFileNotice(message);
    }
  }, [fileToSend, onSendFile]);

  const handleSendEmail = useCallback(async () => {
    const to = mailTo.trim();
    const subject = mailSubject.trim();
    const text = mailBody.trim();
    if (!to || !subject || !text) return;
    setSendingMail(true);
    setMailNotice(null);
    try {
      const base = (import.meta as any).env?.VITE_SIGNAL_URL ?? `http://${window.location.hostname}:3000`;
      const resp = await fetch(`${base}/mail/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, text })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to send email");
      }
      setMailNotice(data?.previewUrl ? `Sent (preview): ${data.previewUrl}` : "Email sent");
      setMailTo("");
      setMailSubject("");
      setMailBody("");
    } catch (e: any) {
      setMailNotice(e?.message || "Failed to send email");
    } finally {
      setSendingMail(false);
    }
  }, [mailTo, mailSubject, mailBody]);

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-background sticky top-0 z-50">
        <div className="container mx-auto px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-foreground rounded-lg flex items-center justify-center">
                <Video className="w-4 h-4 text-background" />
              </div>
              <div>
                <h1 className="text-base font-semibold">{roomName}</h1>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                  <Users className="w-3 h-3" />
                  {participants.length}{" "}
                  {participants.length === 1 ? "person" : "people"}
                  {connectionHealth && <ConnectionHealthPill health={connectionHealth} />}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <NetworkDiagnostics
                pcsRef={pcsRef}
                participants={participants.filter((p) => p.username !== username).map((p) => ({ id: p.id, username: p.username }))}
                sfu={sfu}
                mediaE2EE={mediaE2EE}
                connectionHealth={connectionHealth}
              />
              {drive && (
                <DriveSheet
                  drive={drive}
                  selfPeerId={selfPeerId ?? null}
                  roomMode={sfu?.mode ?? "mesh"}
                />
              )}
              <ARPVisualizer
                arpSessionsRef={arpSessionsRef}
                participants={participants.filter((p) => p.username !== username).map((p) => ({ id: p.id, username: p.username }))}
                channelTick={arpChannelTick}
              />
              <Button variant="outline" size="sm" className="gap-2">
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">Settings</span>
              </Button>
              <Sheet open={chatOpen} onOpenChange={setChatOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-2">
                    <MessageCircle className="w-4 h-4" />
                    <span className="hidden sm:inline">Chat</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-full sm:max-w-md p-0">
                  <div className="flex flex-col h-full">
                    <div className="p-4 border-b">
                      <SheetHeader>
                        <SheetTitle>Room chat</SheetTitle>
                      </SheetHeader>
                    </div>
                    <div className="px-4 pt-3 border-b pb-3">
                      <Collapsible open={verifyOpen} onOpenChange={setVerifyOpen}>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="w-full justify-between h-8 px-2">
                            <span className="flex items-center gap-2 text-xs">
                              <Lock className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span className="font-medium">End-to-end encrypted</span>
                              <span className="text-muted-foreground">
                                · {encryptedCount}/{remotePeers.length} peers · {verifiedCount} verified
                              </span>
                            </span>
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${verifyOpen ? "rotate-180" : ""}`} />
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-3">
                          <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                            Compare each peer's safety number with theirs out-of-band (in person, by
                            phone). If they match, no one is intercepting your keys.
                          </p>
                          <div className="space-y-2">
                            {remotePeers.length === 0 && (
                              <div className="text-xs text-muted-foreground">No remote peers in this room.</div>
                            )}
                            {remotePeers.map((p) => {
                              const theirKey = peerPubKeys[p.id];
                              const sn = theirKey ? safetyNumbers[p.id] : undefined;
                              const verified = theirKey ? !!verifiedKeys[theirKey] : false;
                              return (
                                <div key={p.id} className="rounded-md border border-border/50 px-3 py-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-sm font-medium truncate">{p.username}</div>
                                    {!theirKey ? (
                                      <Badge variant="outline" className="gap-1 text-[10px] border-amber-500/30 text-amber-600 dark:text-amber-400">
                                        <AlertTriangle className="w-3 h-3" /> Awaiting key
                                      </Badge>
                                    ) : verified ? (
                                      <Badge variant="outline" className="gap-1 text-[10px] border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                                        <ShieldCheck className="w-3 h-3" /> Verified
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="gap-1 text-[10px] border-blue-500/30 text-blue-600 dark:text-blue-400">
                                        <Lock className="w-3 h-3" /> Encrypted
                                      </Badge>
                                    )}
                                  </div>
                                  {sn && (
                                    <>
                                      <div className="mt-1.5 font-mono text-[11px] tracking-wider break-all text-muted-foreground">
                                        {sn}
                                      </div>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="mt-1.5 h-6 px-2 text-[11px]"
                                        onClick={() =>
                                          setVerifiedKeys((prev) => ({ ...prev, [theirKey!]: !prev[theirKey!] }))
                                        }
                                      >
                                        {verified ? "Unmark verified" : "Mark as verified"}
                                      </Button>
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                    <ScrollArea className="flex-1 p-4">
                      <div className="space-y-3">
                        {chatMessages.map((m) => (
                          <div
                            key={`${m.ts}-${m.id}`}
                            className="flex flex-col"
                          >
                            <div className="text-xs text-muted-foreground">
                              {m.username} •{" "}
                              {new Date(m.ts).toLocaleTimeString()}
                            </div>
                            <div className="text-sm break-words">{m.text}</div>
                          </div>
                        ))}
                        {chatMessages.length === 0 && (
                          <div className="text-sm text-muted-foreground">
                            No messages yet
                          </div>
                        )}
                        {receivedFiles.length > 0 && (
                          <div className="pt-4 space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">
                              Received files
                            </div>
                            {receivedFiles.map((f, idx) => (
                              <div key={`${f.url || "err"}-${idx}`} className="flex items-center justify-between gap-2 text-sm">
                                <div className="truncate" title={`${f.name} • ${(f.size/1024/1024).toFixed(2)} MB`}>{f.name}</div>
                                {f.error ? (
                                  <span className="text-xs text-destructive" title={f.error}>{f.error}</span>
                                ) : (
                                  <a href={f.url} download={f.name} className="inline-flex items-center gap-1 text-primary hover:underline">
                                    <Download className="w-4 h-4" /> Download
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                    <div className="p-3 border-t">
                      <div className="flex items-center gap-2">
                        <Input
                          placeholder="Type a message"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSend();
                            }
                          }}
                        />
                        <Button
                          onClick={handleSend}
                          disabled={!chatInput.trim()}
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
              <Sheet open={emailOpen} onOpenChange={setEmailOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Send className="w-4 h-4" />
                    <span className="hidden sm:inline">Email</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-full sm:max-w-md p-0">
                  <div className="flex flex-col h-full">
                    <div className="p-4 border-b">
                      <SheetHeader>
                        <SheetTitle>Send email</SheetTitle>
                      </SheetHeader>
                    </div>
                    <div className="flex-1 p-4 space-y-2">
                      <Input placeholder="Recipient email" value={mailTo} onChange={(e) => setMailTo(e.target.value)} />
                      <Input placeholder="Subject" value={mailSubject} onChange={(e) => setMailSubject(e.target.value)} />
                      <textarea
                        className="w-full border rounded-md p-2 text-sm bg-background"
                        rows={8}
                        placeholder="Message"
                        value={mailBody}
                        onChange={(e) => setMailBody(e.target.value)}
                      />
                    </div>
                    <div className="p-3 border-t flex items-center gap-2">
                      <Button onClick={handleSendEmail} disabled={sendingMail || !mailTo.trim() || !mailSubject.trim() || !mailBody.trim()}>
                        {sendingMail ? "Sending..." : "Send email"}
                      </Button>
                      {mailNotice && <div className="text-xs text-muted-foreground truncate" title={mailNotice}>{mailNotice}</div>}
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
              <div className="flex items-center gap-2">
                <input
                  id="file-input"
                  type="file"
                  className="hidden"
                  onChange={handleFilePick}
                />
                <Button asChild variant="outline" size="sm" className="gap-2">
                  <label htmlFor="file-input" className="cursor-pointer">
                    <span className="inline-flex items-center gap-2">
                      <Paperclip className="w-4 h-4" />{" "}
                      <p className="hidden sm:inline">Choose file</p>
                    </span>
                  </label>
                </Button>
                <Button
                  size="sm"
                  onClick={handleSendFile}
                  disabled={!fileToSend}
                  className="gap-2"
                >
                  <Send className="w-4 h-4" />
                  <p className="hidden sm:inline">Send</p>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Video Grid */}
      <main className="flex-1 container mx-auto px-6 lg:px-8 py-6 overflow-auto">
        <div className={`grid ${getGridCols(participants.length)} gap-4`}>
          {/* Current User Video */}
          <Card className="aspect-video relative overflow-hidden group">
            {!isVideo && (
              <div className="absolute inset-0 bg-muted/50 flex items-center justify-center">
                <div className="text-center flex flex-col gap-2">
                  <Avatar className="w-16 h-16 mx-auto">
                    <AvatarFallback className="text-2xl">
                      {username.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-sm">{username}</p>
                    <p className="text-xs text-muted-foreground">You</p>
                  </div>
                </div>
              </div>
            )}
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              autoPlay
              playsInline
              muted
            />
            <div className="absolute top-3 left-3">
              <div className="px-2 py-1 rounded-md bg-background/80 backdrop-blur-sm text-xs font-medium">
                You
              </div>
            </div>
            <div className="absolute bottom-3 right-3 flex gap-2">
              <div
                className={`w-8 h-8 ${
                  micMuted ? "bg-destructive" : "bg-background/80"
                } backdrop-blur-sm rounded-lg flex items-center justify-center`}
              >
                {micMuted ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </div>
              <div
                className={`w-8 h-8 ${
                  !isVideo ? "bg-destructive" : "bg-background/80"
                } backdrop-blur-sm rounded-lg flex items-center justify-center`}
              >
                {!isVideo ? (
                  <VideoOff className="w-4 h-4" />
                ) : (
                  <Video className="w-4 h-4" />
                )}
              </div>
            </div>
          </Card>

          {participants
            .filter((p) => p.username !== username)
            .map((p) => (
              <Card
                key={p.id}
                className="aspect-video relative overflow-hidden group"
              >
                {(!p.videoStream || !p.isVideoEnabled) && (
                  <div className="absolute inset-0 bg-muted/50 flex items-center justify-center">
                    <div className="text-center flex flex-col gap-2">
                      <Avatar className="w-16 h-16 mx-auto">
                        <AvatarFallback className="text-2xl">
                          {p.username.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <p className="font-medium text-sm">{p.username}</p>
                    </div>
                  </div>
                )}
                <video
                  ref={(video) => {
                    if (video) {
                      video.srcObject = p.isVideoEnabled ? p.videoStream : null;
                    }
                  }}
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                />
                <div className="absolute top-3 left-3">
                  <div className="px-2 py-1 rounded-md bg-background/80 backdrop-blur-sm text-xs font-medium">
                    {p.username}
                  </div>
                </div>
                <div className="absolute bottom-3 right-3 flex gap-2">
                  <div
                    className={`w-8 h-8 ${
                      p.isAudioEnabled ? "bg-background/80" : "bg-destructive"
                    } backdrop-blur-sm rounded-lg flex items-center justify-center`}
                  >
                    {p.isAudioEnabled ? (
                      <Mic className="w-4 h-4" />
                    ) : (
                      <MicOff className="w-4 h-4" />
                    )}
                  </div>
                  <div
                    className={`w-8 h-8 ${
                      p.isVideoEnabled ? "bg-background/80" : "bg-destructive"
                    } backdrop-blur-sm rounded-lg flex items-center justify-center`}
                  >
                    {p.isVideoEnabled ? (
                      <Video className="w-4 h-4" />
                    ) : (
                      <VideoOff className="w-4 h-4" />
                    )}
                  </div>
                </div>
              </Card>
            ))}
        </div>
      </main>

      {/* Controls Footer */}
      <footer className="border-t border-border bg-background">
        <div className="container mx-auto px-6 lg:px-8 py-4">
          <div className="flex items-center justify-center gap-3">
            <Button
              size="icon"
              variant={micMuted ? "destructive" : "outline"}
              onClick={() =>
                setMicMuted((prev) => {
                  const next = !prev;
                  onAudioToggle(!next);
                  return next;
                })
              }
              className="h-10 w-10 rounded-lg"
            >
              {micMuted ? (
                <MicOff className="w-5 h-5" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </Button>
            <Button
              size="icon"
              variant={!isVideo ? "destructive" : "outline"}
              onClick={() =>
                setIsVideo((prevState) => {
                  const next = !prevState;
                  onVideoToggle(next);
                  return next;
                })
              }
              className="h-10 w-10 rounded-lg"
            >
              {!isVideo ? (
                <VideoOff className="w-5 h-5" />
              ) : (
                <Video className="w-5 h-5" />
              )}
            </Button>
            <Button
              size="icon"
              variant="destructive"
              onClick={onLeave}
              className="h-10 w-10 rounded-lg"
            >
              <PhoneOff className="w-5 h-5" />
            </Button>
          </div>
          {fileToSend && (
            <div className="mt-4">
              <div className="text-xs text-muted-foreground mb-2">
                Sending: {fileToSend.name} (
                {(fileToSend.size / 1024 / 1024).toFixed(2)} MB)
              </div>
              <Progress value={uploadProgress} />
            </div>
          )}
          {fileNotice && (
            <div
              className={`mt-2 text-xs ${
                fileNotice === "Sent" ? "text-muted-foreground" : "text-destructive"
              }`}
            >
              {fileNotice}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
};

export default RoomView;
