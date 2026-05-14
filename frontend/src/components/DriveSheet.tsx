import { useState, useRef } from "react";
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
import { Progress } from "@/components/ui/progress";
import { HardDrive, Upload, Download, FileText, AlertCircle } from "lucide-react";
import type { DriveApi } from "@/hooks/useDrive";
import { formatBytes } from "@/hooks/useWebRTCStats";

interface DriveSheetProps {
  drive: DriveApi;
  selfPeerId: string | null;
  // 'mesh' or 'sfu' — drive only works in mesh; we surface the limitation.
  roomMode: "mesh" | "sfu";
}

const DriveSheet = ({ drive, selfPeerId, roomMode }: DriveSheetProps) => {
  const [open, setOpen] = useState(false);
  const [uploadState, setUploadState] = useState<
    | { kind: "idle" }
    | { kind: "running"; name: string; phase: string; stored: number; total: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    if (!drive.ready) {
      setUploadState({ kind: "error", message: "drive identity not ready" });
      return;
    }
    if (roomMode === "sfu") {
      setUploadState({
        kind: "error",
        message: "drive upload is mesh-only in v1; room is in SFU mode",
      });
      return;
    }
    setUploadState({ kind: "running", name: file.name, phase: "sealing", stored: 0, total: 14 });
    try {
      await drive.upload(file, {
        onProgress: (p) =>
          setUploadState({
            kind: "running",
            name: file.name,
            phase: p.phase,
            stored: p.shardsStored,
            total: p.totalShards,
          }),
      });
      setUploadState({ kind: "idle" });
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setUploadState({ kind: "error", message: (err as Error).message });
    }
  };

  const handleDownload = async (
    manifest: DriveApi["manifests"][number],
    isOwner: boolean,
  ) => {
    if (!isOwner) {
      setDownloadError("only the uploader can decrypt their files in v1");
      return;
    }
    setDownloadError(null);
    try {
      const { bytes, name, contentType } = await drive.download(manifest);
      const blob = new Blob([bytes], { type: contentType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setDownloadError((err as Error).message);
    }
  };

  const mySignKey = drive.identity?.sign.publicKeyB64 ?? null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <HardDrive className="w-4 h-4" />
          <span className="hidden sm:inline">Drive</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md p-0">
        <div className="flex flex-col h-full">
          <div className="p-4 border-b">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <HardDrive className="w-4 h-4" /> Distributed drive
              </SheetTitle>
            </SheetHeader>
            <p className="text-[11px] text-muted-foreground mt-1">
              Reed-Solomon (k=10, m=4) · AES-GCM file encryption · ECIES key
              wrap · ECDSA-signed manifests
            </p>
          </div>

          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              <Card className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm">Upload</div>
                  <Badge variant="outline" className="text-[10px]">
                    {roomMode === "mesh" ? "mesh ready" : "SFU mode — disabled"}
                  </Badge>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  disabled={!drive.ready || roomMode === "sfu" || uploadState.kind === "running"}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUpload(file);
                  }}
                  className="block w-full text-xs file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer disabled:opacity-50"
                />
                {uploadState.kind === "running" && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate">{uploadState.name}</span>
                      <span className="text-muted-foreground font-mono">
                        {uploadState.phase} · {uploadState.stored}/{uploadState.total}
                      </span>
                    </div>
                    <Progress value={(uploadState.stored / uploadState.total) * 100} />
                  </div>
                )}
                {uploadState.kind === "error" && (
                  <div className="text-xs text-destructive flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{uploadState.message}</span>
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground">
                  Files are sealed with a per-file AES-GCM key, sharded into
                  14 pieces, distributed across the room's peers,
                  and indexed by a signed manifest broadcast to the room.
                </div>
              </Card>

              <Card className="p-4 space-y-2">
                <div className="font-semibold text-sm">This peer holds</div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <Stat label="Shards" value={String(drive.storeStats.shards)} />
                  <Stat label="Manifests" value={String(drive.storeStats.manifests)} />
                  <Stat label="Storage" value={formatBytes(drive.storeStats.bytes)} />
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Storage is in-memory; reload empties it.
                </div>
              </Card>

              {drive.dht && (
                <Card className="p-4 space-y-2 border-primary/30">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm">Kademlia DHT</div>
                    <Badge variant="outline" className="text-[10px] border-primary/40">
                      k=8 · α=3
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <Stat label="My ID (prefix)" value={drive.dht.selfHex.slice(0, 10) + "…"} />
                    <Stat label="Contacts" value={String(drive.dht.contacts.length)} />
                    <Stat label="Stored keys" value={String(drive.dht.storageKeys.length)} />
                  </div>
                  {drive.dht.contacts.length > 0 && (
                    <div className="text-[10px] font-mono text-muted-foreground space-y-0.5 pt-1">
                      {drive.dht.contacts.slice(0, 4).map((c) => (
                        <div key={c.handle} className="flex items-center justify-between">
                          <span className="truncate" title={c.handle}>
                            {c.idHex.slice(0, 10)}… ({c.handle.slice(0, 6)}…)
                          </span>
                          <span className="text-muted-foreground">b{c.bucket}</span>
                        </div>
                      ))}
                      {drive.dht.contacts.length > 4 && (
                        <div className="text-muted-foreground">+{drive.dht.contacts.length - 4} more</div>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground">
                    Shard lookups try iterative FIND_VALUE before falling back to broadcast,
                    converting O(N) flood into O(log N) routed hops.
                  </div>
                </Card>
              )}

              <Separator />

              <div className="space-y-2">
                <div className="font-semibold text-sm flex items-center justify-between">
                  <span>Catalog</span>
                  <Badge variant="outline" className="text-[10px]">
                    {drive.manifests.length} file{drive.manifests.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                {drive.manifests.length === 0 && (
                  <div className="text-sm text-muted-foreground">
                    No files yet. Upload one or wait for a peer to.
                  </div>
                )}
                {drive.manifests.map((m) => {
                  const isOwner = m.uploaderSignPubKeyB64 === mySignKey;
                  return (
                    <Card key={m.fileId} className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-sm flex items-center gap-1.5 truncate">
                            <FileText className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{m.name}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {formatBytes(m.size)} · k={m.k} m={m.m} ·{" "}
                            {new Date(m.createdAt).toLocaleTimeString()}
                          </div>
                          {isOwner && (
                            <Badge variant="outline" className="text-[10px] mt-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                              you uploaded
                            </Badge>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={!drive.ready || !isOwner || selfPeerId === null}
                          onClick={() => void handleDownload(m, isOwner)}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Get
                        </Button>
                      </div>
                    </Card>
                  );
                })}
                {downloadError && (
                  <div className="text-xs text-destructive flex items-start gap-1.5 pt-1">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{downloadError}</span>
                  </div>
                )}
              </div>
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

export default DriveSheet;
