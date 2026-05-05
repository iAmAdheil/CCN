import { useState, useEffect, useRef, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import UsernameModal from "@/components/UsernameModal";
import RoomLobby from "@/components/RoomLobby";
import RoomView from "@/components/RoomView";
import { fetchRtcConfig, getCachedRtcConfig, rtcConfigIsFresh } from "@/../utils";
import {
  generateChatKeypair,
  deriveSharedKey,
  encryptText,
  decryptText,
  type ChatKeypair,
} from "@/lib/chatCrypto";
import { ArpSession } from "@/lib/arpSession";

type AppState = "username" | "lobby" | "room";

// File-transfer wire protocol
//
// Control frames travel as DataChannel string messages (JSON):
//   { type: "file-meta",     id, name, size, hash, totalChunks, chunkSize }
//   { type: "file-complete", id }
//
// Data chunks travel as DataChannel binary messages (ArrayBuffer) with an
// 8-byte big-endian header:
//   bytes 0..3 : transferId  (uint32)
//   bytes 4..7 : sequence    (uint32)
//   bytes 8..N : payload
//
// `id` / `transferId` is a per-sender monotonically increasing uint32, so
// concurrent transfers on the same channel are demultiplexed on the receiver.
// The channel is created with { ordered: true }, so chunks arrive in order.
const FILE_HEADER_BYTES = 8;
const FILE_CHUNK_SIZE = 64 * 1024;
const FILE_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

function writeFileFrame(transferId: number, seq: number, payload: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(FILE_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out);
  view.setUint32(0, transferId, false);
  view.setUint32(4, seq, false);
  new Uint8Array(out, FILE_HEADER_BYTES).set(new Uint8Array(payload));
  return out;
}

function readFileFrameHeader(buf: ArrayBuffer): { transferId: number; seq: number; payload: ArrayBuffer } | null {
  if (buf.byteLength < FILE_HEADER_BYTES) return null;
  const view = new DataView(buf);
  return {
    transferId: view.getUint32(0, false),
    seq: view.getUint32(4, false),
    payload: buf.slice(FILE_HEADER_BYTES),
  };
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

export interface Room {
  id: string;
  name: string;
  activeUsers: {
    id: string;
    username: string;
  }[];
}

export interface RoomUser {
  id: string;
  username: string;
  videoStream: MediaStream | null;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
}

export interface ChatMessage {
  msgId: string;
  id: string;
  username: string;
  text: string;
  ts: number;
}

const Index = () => {
  const [appState, setAppState] = useState<AppState>("username");
  const [username, setUsername] = useState("");
  const [currentRoomName, setCurrentRoomName] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomUsers, setRoomUsers] = useState<RoomUser[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const socketRef = useRef<Socket>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Record<string, RTCPeerConnection>>({});
  const dcsRef = useRef<Record<string, RTCDataChannel>>({});
  // Separate DataChannel per peer for ARP — must be unreliable + unordered so
  // SCTP doesn't paper over the loss/reorder we want to demonstrate handling
  // ourselves. Held in its own ref so the existing file-transfer / chat path
  // never sees ARP frames.
  const arpDcsRef = useRef<Record<string, RTCDataChannel>>({});
  // Per-peer ArpSession kept alive for the lifetime of the ARP DC. Both sides
  // need it so the receiver can ACK regardless of whether the user has the
  // visualizer open. Sender-side stats are read from the session snapshot.
  const arpSessionsRef = useRef<Record<string, ArpSession>>({});
  const [arpChannelTick, setArpChannelTick] = useState(0); // bumps on add/remove — re-renders dependent UI
  const incomingRef = useRef<Record<string, {
    name: string;
    size: number;
    hash: string;
    totalChunks: number;
    chunks: ArrayBuffer[];
    receivedBytes: number;
    from: string;
  }>>({});
  const nextTransferIdRef = useRef<number>(1);
  const seenChatIdsRef = useRef<Set<string>>(new Set());
  const chatKeypairRef = useRef<ChatKeypair | null>(null);
  const peerKeysRef = useRef<Record<string, { theirPubKeyB64: string; sharedKey: CryptoKey }>>({});
  // Messages waiting on a shared key. Drained in flushPendingChats once
  // peer-pubkey arrives and the key is derived.
  const pendingChatRef = useRef<Record<string, Array<{ msgId: string; text: string; ts: number }>>>({});

  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [receivedFiles, setReceivedFiles] = useState<Array<{ name: string; size: number; url: string; error?: string }>>([]);
  // UI mirrors of the E2EE refs above. Refs stay the source of truth so
  // crypto operations have synchronous access; these states exist so React
  // re-renders the safety-number panel when keys are exchanged.
  const [myPubKey, setMyPubKey] = useState<string | null>(null);
  const [peerPubKeys, setPeerPubKeys] = useState<Record<string, string>>({});

  const ensureLocalStream = useCallback(async () => {
    if (streamRef.current) {
      return streamRef.current;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      streamRef.current = stream;
      return stream;
    } catch (error) {
      console.error("Error accessing user media", error);
      throw error;
    }
  }, []);

  // Re-fetch ICE config (TURN credentials) if the cached copy is stale.
  // Called immediately before any RTCPeerConnection is created.
  const ensureRtcConfig = useCallback(async () => {
    if (!rtcConfigIsFresh()) {
      await fetchRtcConfig(username || undefined);
    }
  }, [username]);

  // Stable callback used by both the socket relay path and the DataChannel
  // path — dedupes by msgId so a message that arrives via both paths only
  // shows up once. The Set is bounded so it can't grow forever.
  const addChatMessage = useCallback((msg: ChatMessage) => {
    if (!msg.msgId || seenChatIdsRef.current.has(msg.msgId)) return;
    seenChatIdsRef.current.add(msg.msgId);
    if (seenChatIdsRef.current.size > 500) {
      const arr = Array.from(seenChatIdsRef.current);
      seenChatIdsRef.current = new Set(arr.slice(arr.length - 500));
    }
    setChatMessages((prev) => [...prev, msg]);
  }, []);

  // Encrypt a chat message under the per-peer ECDH-derived AES-GCM key, then
  // dispatch via DataChannel if open, otherwise via the server relay (which
  // only sees ciphertext). If we don't have a shared key for this peer yet,
  // queue the message — flushPendingChats will drain the queue when the key
  // arrives.
  const encryptAndDispatchChat = useCallback(
    async (peerId: string, msgId: string, text: string, ts: number) => {
      const entry = peerKeysRef.current[peerId];
      if (!entry) {
        const queue = pendingChatRef.current[peerId] ?? [];
        queue.push({ msgId, text, ts });
        pendingChatRef.current[peerId] = queue;
        return;
      }

      let blob;
      try {
        blob = await encryptText(entry.sharedKey, text);
      } catch (e) {
        console.warn("Encrypt failed for peer", peerId, e);
        return;
      }

      const dc = dcsRef.current[peerId];
      if (dc && dc.readyState === "open") {
        try {
          dc.send(JSON.stringify({ type: "chat-enc", msgId, username, iv: blob.iv, ct: blob.ct, ts }));
          return;
        } catch (e) {
          console.warn("DataChannel send failed; falling through to relay", e);
        }
      }
      socketRef.current?.emit("chat-relay", { to: peerId, msgId, iv: blob.iv, ct: blob.ct, ts });
    },
    [username]
  );

  const flushPendingChats = useCallback(
    async (peerId: string) => {
      const queue = pendingChatRef.current[peerId];
      if (!queue || queue.length === 0) return;
      delete pendingChatRef.current[peerId];
      for (const m of queue) {
        await encryptAndDispatchChat(peerId, m.msgId, m.text, m.ts);
      }
    },
    [encryptAndDispatchChat]
  );

  // Pre-warm the ICE config on mount and refresh well before TTL expires.
  useEffect(() => {
    if (!username) return;
    void fetchRtcConfig(username);
    // Default backend TTL is 5 minutes; refresh every 4 minutes.
    const handle = window.setInterval(() => {
      void fetchRtcConfig(username);
    }, 4 * 60 * 1000);
    return () => window.clearInterval(handle);
  }, [username]);

  useEffect(() => {
    const startListening = async () => {
      console.log("activating socket!");

      // Fresh ephemeral ECDH keypair per session. Private key never leaves
      // SubtleCrypto; public key is announced via signaling.
      try {
        const kp = await generateChatKeypair();
        chatKeypairRef.current = kp;
        setMyPubKey(kp.publicKeyB64);
      } catch (e) {
        console.error("Failed to generate chat keypair — chat will fall back to plaintext-broken state.", e);
      }

      const SIGNAL_URL =
        (import.meta as any).env?.VITE_SIGNAL_URL ?? `http://${window.location.hostname}:3000`;
      socketRef.current = io(SIGNAL_URL, {
        auth: {
          username: username,
        },
      });

      socketRef.current?.on("fetch active rooms", (roomsStr) => {
        const rooms = JSON.parse(roomsStr) as Room[];
        setRooms(rooms);
      });

      socketRef.current?.on("add new room user", (userStr) => {
        const incoming = JSON.parse(userStr) as {
          id: string;
          username: string;
          isVideoEnabled?: boolean;
          isAudioEnabled?: boolean;
        };
        setRoomUsers((prev) => {
          const updated = [
            ...prev,
            {
              id: incoming.id,
              username: incoming.username,
              videoStream: null,
              isVideoEnabled: incoming.isVideoEnabled ?? true,
              isAudioEnabled: incoming.isAudioEnabled ?? true,
            },
          ];
          return updated;
        });
        // Send our pubkey to the joiner. They'll send theirs back via
        // peer-pubkey, and both sides will independently derive the same
        // AES-GCM key via ECDH.
        if (chatKeypairRef.current) {
          socketRef.current?.emit("pubkey-exchange", {
            to: incoming.id,
            pubKey: chatKeypairRef.current.publicKeyB64,
          });
        }
      });

      socketRef.current?.on("fetch room users", async (usersStr) => {
        const users = JSON.parse(usersStr) as Array<{
          id: string;
          username: string;
          isVideoEnabled?: boolean;
          isAudioEnabled?: boolean;
        }>;
        setRoomUsers((_) => {
          return [
            ...users.map((user) => ({
              id: user.id,
              username: user.username,
              videoStream: null,
              isVideoEnabled: user.isVideoEnabled ?? true,
              isAudioEnabled: user.isAudioEnabled ?? true,
            })),
            {
              id: socketRef.current?.id || "",
              username: username,
              videoStream: null,
              isVideoEnabled: true,
              isAudioEnabled: true,
            },
          ];
        });
        setAppState("room");

        try {
          await ensureLocalStream();
        } catch (error) {
          console.error(
            "Failed to prepare local media before creating offers",
            error
          );
          // Continue without local media; join should not be blocked
        }
        await ensureRtcConfig();

        // Announce our pubkey to every existing peer in this room. Once each
        // peer replies with their own pubkey via peer-pubkey, both sides can
        // derive the per-pair shared key.
        if (chatKeypairRef.current) {
          for (const user of users) {
            socketRef.current?.emit("pubkey-exchange", {
              to: user.id,
              pubKey: chatKeypairRef.current.publicKeyB64,
            });
          }
        }

        for (const user of users) {
          console.log("sending an offer to:", user.id);
          const pc = createPC(user.id, true);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current?.emit("offer", {
            to: user.id,
            offer: offer,
          });
        }
      });

      socketRef.current?.on(
        "offer",
        async (data: { from: string; offer: RTCSessionDescriptionInit }) => {
          console.log("received an offer from:", data.from);
          try {
            await ensureLocalStream();
          } catch (error) {
            console.error(
              "Failed to prepare local media before answering offer",
              error
            );
            // Continue answering without local media
          }
          await ensureRtcConfig();
          const pc = createPC(data.from, false);
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current?.emit("answer", {
            to: data.from,
            answer: pc.localDescription,
          });
        }
      );

      socketRef.current?.on(
        "answer",
        async (data: { from: string; answer: RTCSessionDescriptionInit }) => {
          console.log("received an answer from:", data.from);
          const pc = pcsRef.current[data.from];
          pc.setRemoteDescription(data.answer);
        }
      );

      socketRef.current?.on(
        "peer-pubkey",
        async (data: { from: string; pubKey: string }) => {
          if (!data?.from || !data?.pubKey) return;
          if (!chatKeypairRef.current) return;
          // Race-safety: if we've already derived a key for this peer with the
          // same pubkey, skip. A different pubkey means the peer regenerated;
          // overwrite (the old conversation can no longer be decrypted, but
          // pending messages will be re-encrypted under the new key).
          const existing = peerKeysRef.current[data.from];
          if (existing && existing.theirPubKeyB64 === data.pubKey) return;
          try {
            const sharedKey = await deriveSharedKey(chatKeypairRef.current.privateKey, data.pubKey);
            peerKeysRef.current[data.from] = { theirPubKeyB64: data.pubKey, sharedKey };
            setPeerPubKeys((prev) => ({ ...prev, [data.from]: data.pubKey }));
            void flushPendingChats(data.from);
          } catch (e) {
            console.warn("Failed to derive shared key with peer", data.from, e);
          }
        }
      );

      socketRef.current?.on(
        "chat message",
        async (msg: { msgId: string; id: string; username: string; iv: string; ct: string; ts: number }) => {
          if (!msg?.msgId || typeof msg.iv !== "string" || typeof msg.ct !== "string") return;
          const entry = peerKeysRef.current[msg.id];
          if (!entry) {
            console.warn("Received encrypted chat from peer with no shared key:", msg.id);
            return;
          }
          try {
            const text = await decryptText(entry.sharedKey, msg.iv, msg.ct);
            addChatMessage({
              msgId: msg.msgId,
              id: msg.id,
              username: msg.username,
              text,
              ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
            });
          } catch (e) {
            console.warn("Failed to decrypt chat from", msg.id, e);
          }
        }
      );

      socketRef.current?.on("candidate", async ({ from, candidate }) => {
        const pc = pcsRef.current[from];
        if (!pc || !candidate) return;
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn("Error adding ICE candidate", err);
        }
      });

      socketRef.current?.on(
        "media state change",
        (data: {
          userId: string;
          kind: "video" | "audio";
          enabled: boolean;
        }) => {
          setRoomUsers((prev) =>
            prev.map((user) => {
              if (user.id !== data.userId) return user;

              if (data.kind === "video") {
                return { ...user, isVideoEnabled: data.enabled };
              }
              if (data.kind === "audio") {
                return { ...user, isAudioEnabled: data.enabled };
              }
              return user;
            })
          );
        }
      );

      socketRef.current?.on("remove room user", (userId: string) => {
        setRoomUsers((prev) => prev.filter((user) => user.id !== userId));
        const pc = pcsRef.current[userId];
        if (pc) {
          try {
            pc.close();
          } catch (error) {
            console.warn(
              "Error closing RTCPeerConnection for user",
              userId,
              error
            );
          }
          delete pcsRef.current[userId];
        }
        delete peerKeysRef.current[userId];
        delete pendingChatRef.current[userId];
        setPeerPubKeys((prev) => {
          if (!(userId in prev)) return prev;
          const next = { ...prev };
          delete next[userId];
          return next;
        });
        const arpDc = arpDcsRef.current[userId];
        if (arpDc) {
          try {
            arpDc.close();
          } catch {
            /* ignore */
          }
        }
        const arpSession = arpSessionsRef.current[userId];
        if (arpSession) {
          arpSession.destroy();
          delete arpSessionsRef.current[userId];
        }
        if (arpDcsRef.current[userId]) {
          delete arpDcsRef.current[userId];
          setArpChannelTick((t) => t + 1);
        }
      });
    };

    if (appState === "username" && socketRef.current !== null) {
      socketRef.current?.disconnect();
      socketRef.current = null;
    } else if (socketRef.current === null && appState !== "username") {
      startListening();
    }
  }, [addChatMessage, appState, ensureLocalStream, ensureRtcConfig, flushPendingChats, username]);

  const cleanupPeerConnections = useCallback(() => {
    Object.values(pcsRef.current).forEach((pc) => {
      try {
        pc.close();
      } catch (error) {
        console.warn("Error closing RTCPeerConnection", error);
      }
    });
    pcsRef.current = {};
    Object.values(arpSessionsRef.current).forEach((s) => s.destroy());
    arpSessionsRef.current = {};
    arpDcsRef.current = {};
    setArpChannelTick((t) => t + 1);
  }, []);

  const stopLocalStream = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (error) {
        console.warn("Error stopping media track", error);
      }
    });

    streamRef.current = null;
  }, []);

  const broadcastMediaState = useCallback(
    (kind: "video" | "audio", enabled: boolean) => {
      if (!socketRef.current || !currentRoomName) return;
      socketRef.current.emit("media state change", {
        roomName: currentRoomName,
        kind,
        enabled,
      });
    },
    [currentRoomName]
  );

  const handleVideoToggle = useCallback(
    (enabled: boolean) => {
      const stream = streamRef.current;
      if (stream) {
        stream.getVideoTracks().forEach((track) => {
          track.enabled = enabled;
        });
      }

      Object.values(pcsRef.current).forEach((pc) => {
        pc.getSenders().forEach((sender) => {
          if (sender.track?.kind === "video") {
            sender.track.enabled = enabled;
          }
        });
      });

      setRoomUsers((prev) =>
        prev.map((user) =>
          user.id === socketRef.current?.id
            ? { ...user, isVideoEnabled: enabled }
            : user
        )
      );

      broadcastMediaState("video", enabled);
    },
    [broadcastMediaState]
  );

  const handleAudioToggle = useCallback(
    (enabled: boolean) => {
      const stream = streamRef.current;
      if (stream) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = enabled;
        });
      }

      Object.values(pcsRef.current).forEach((pc) => {
        pc.getSenders().forEach((sender) => {
          if (sender.track?.kind === "audio") {
            sender.track.enabled = enabled;
          }
        });
      });

      setRoomUsers((prev) =>
        prev.map((user) =>
          user.id === socketRef.current?.id
            ? { ...user, isAudioEnabled: enabled }
            : user
        )
      );

      broadcastMediaState("audio", enabled);
    },
    [broadcastMediaState]
  );

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  const handleUsernameSubmit = useCallback((name: string) => {
    setUsername(name);
    setAppState("lobby");
  }, []);

  const handleJoinRoom = useCallback(
    (roomName: string) => {
      setCurrentRoomName(roomName);
      setChatMessages([]);
      seenChatIdsRef.current.clear();
      // Emit join immediately; media can be acquired later
      socketRef.current?.emit("join room", roomName);
      // Try to prepare media in background, but don't block join flow
      ensureLocalStream().catch((error) => {
        console.error(
          "Failed to acquire local media before joining room",
          error
        );
      });
    },
    [ensureLocalStream]
  );

  const handleLeaveRoom = useCallback(() => {
    if (currentRoomName) {
      socketRef.current?.emit("leave room", currentRoomName);
    }

    cleanupPeerConnections();
    stopLocalStream();
    setRoomUsers([]);
    setChatMessages([]);
    seenChatIdsRef.current.clear();
    peerKeysRef.current = {};
    pendingChatRef.current = {};
    setPeerPubKeys({});
    setUploadProgress(0);
    setReceivedFiles([]);
    setCurrentRoomName("");
    setAppState("lobby");
  }, [cleanupPeerConnections, currentRoomName, stopLocalStream]);

  const handleLogout = useCallback(() => {
    if (currentRoomName) {
      socketRef.current?.emit("leave room", currentRoomName);
    }

    cleanupPeerConnections();
    stopLocalStream();

    setRoomUsers([]);
    setRooms([]);
    setChatMessages([]);
    seenChatIdsRef.current.clear();
    peerKeysRef.current = {};
    pendingChatRef.current = {};
    chatKeypairRef.current = null;
    setMyPubKey(null);
    setPeerPubKeys({});
    setUploadProgress(0);
    setReceivedFiles([]);
    setCurrentRoomName("");
    setUsername("");
    setAppState("username");

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, [cleanupPeerConnections, currentRoomName, stopLocalStream]);

  function createPC(remoteId: string, isOfferer: boolean) {
    const pc = new RTCPeerConnection(getCachedRtcConfig());
    // receive remote tracks (attach to a video element)
    pc.addEventListener("track", (ev) => {
      const remoteStream = ev.streams[0];
      if (!remoteStream) {
        console.log("remote stream is empty!");
      }
      setRoomUsers((prev) => {
        const updated = prev.map((user) => {
          if (user.id === remoteId) {
            return { ...user, videoStream: remoteStream };
          }
          return user;
        });
        return updated;
      });
    });

    pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) {
        socketRef.current?.emit("candidate", {
          to: remoteId,
          candidate: ev.candidate,
        });
      }
    });

    // add local audio+video tracks (recommended over addStream)
    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, streamRef.current as MediaStream));
    } else {
      console.warn("No local stream available when creating RTCPeerConnection");
    }

    pcsRef.current[remoteId] = pc;

    if (isOfferer) {
      const dc = pc.createDataChannel("file-transfer", { ordered: true });
      attachDataChannel(remoteId, dc);
      // ARP runs on a parallel channel that explicitly forfeits SCTP's
      // reliability and ordering — that's the whole point: we re-implement
      // those properties at the application layer to demonstrate ARQ +
      // congestion control.
      const arpDc = pc.createDataChannel("arp", { ordered: false, maxRetransmits: 0 });
      attachArpChannel(remoteId, arpDc);
    } else {
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "arp") {
          attachArpChannel(remoteId, ev.channel);
        } else {
          attachDataChannel(remoteId, ev.channel);
        }
      };
    }

    return pc;
  }

  function attachArpChannel(remoteId: string, dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    arpDcsRef.current[remoteId] = dc;
    const session = new ArpSession(dc);
    arpSessionsRef.current[remoteId] = session;
    setArpChannelTick((t) => t + 1);

    if (dc.readyState === "open") session.start();
    else dc.addEventListener("open", () => session.start());

    dc.addEventListener("close", () => {
      session.destroy();
      if (arpDcsRef.current[remoteId] === dc) {
        delete arpDcsRef.current[remoteId];
        delete arpSessionsRef.current[remoteId];
        setArpChannelTick((t) => t + 1);
      }
    });
  }

  function attachDataChannel(remoteId: string, dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    dcsRef.current[remoteId] = dc;
    dc.onclose = () => {
      if (dcsRef.current[remoteId] === dc) {
        delete dcsRef.current[remoteId];
      }
    };
    dc.onmessage = (ev) => {
      try {
        if (typeof ev.data === "string") {
          handleControlFrame(remoteId, ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          handleDataFrame(remoteId, ev.data);
        }
      } catch (e) {
        console.warn("Error handling data channel message", e);
      }
    };
  }

  function handleControlFrame(remoteId: string, raw: string) {
    const msg = JSON.parse(raw);
    if (msg.type === "file-meta") {
      const key = `${remoteId}:${msg.id}`;
      incomingRef.current[key] = {
        name: msg.name,
        size: msg.size,
        hash: msg.hash,
        totalChunks: msg.totalChunks,
        chunks: new Array(msg.totalChunks),
        receivedBytes: 0,
        from: remoteId,
      };
    } else if (msg.type === "file-complete") {
      const key = `${remoteId}:${msg.id}`;
      const entry = incomingRef.current[key];
      if (!entry) return;
      delete incomingRef.current[key];
      void finalizeIncomingFile(entry);
    } else if (msg.type === "chat-enc") {
      if (typeof msg.msgId !== "string" || typeof msg.iv !== "string" || typeof msg.ct !== "string") return;
      const entry = peerKeysRef.current[remoteId];
      if (!entry) {
        // No shared key (yet) — almost always a timing race during join.
        // Drop silently; the sender's queue will retry once keys exchange.
        return;
      }
      void (async () => {
        try {
          const text = await decryptText(entry.sharedKey, msg.iv, msg.ct);
          addChatMessage({
            msgId: msg.msgId,
            id: remoteId,
            username: typeof msg.username === "string" ? msg.username : "unknown",
            text,
            ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
          });
        } catch (e) {
          console.warn("Failed to decrypt DC chat from", remoteId, e);
        }
      })();
    }
  }

  function handleDataFrame(remoteId: string, buf: ArrayBuffer) {
    const frame = readFileFrameHeader(buf);
    if (!frame) return;
    const key = `${remoteId}:${frame.transferId}`;
    const entry = incomingRef.current[key];
    if (!entry) return;
    if (frame.seq < entry.totalChunks && !entry.chunks[frame.seq]) {
      entry.chunks[frame.seq] = frame.payload;
      entry.receivedBytes += frame.payload.byteLength;
    }
  }

  async function finalizeIncomingFile(entry: {
    name: string;
    size: number;
    hash: string;
    totalChunks: number;
    chunks: ArrayBuffer[];
  }) {
    // Detect missing chunks (defensive — DataChannel is ordered+reliable so this
    // shouldn't happen, but worth catching if the protocol assumptions ever change).
    for (let i = 0; i < entry.totalChunks; i++) {
      if (!entry.chunks[i]) {
        setReceivedFiles((prev) => [
          ...prev,
          { name: entry.name, size: entry.size, url: "", error: `Missing chunk ${i}` },
        ]);
        return;
      }
    }

    const blob = new Blob(entry.chunks, { type: "application/octet-stream" });
    const computed = bufferToHex(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    );
    if (computed !== entry.hash) {
      setReceivedFiles((prev) => [
        ...prev,
        { name: entry.name, size: entry.size, url: "", error: "Integrity check failed" },
      ]);
      return;
    }
    const url = URL.createObjectURL(blob);
    setReceivedFiles((prev) => [...prev, { name: entry.name, size: entry.size, url }]);
  }

  const sendFileToAll = useCallback(async (file: File) => {
    const peers = Object.values(dcsRef.current).filter((dc) => dc.readyState === "open");
    if (peers.length === 0) return;

    setUploadProgress(0);

    // Read file once, hash it, then send slices of the same buffer (no double-read).
    const fullBuffer = await file.arrayBuffer();
    const hash = bufferToHex(await crypto.subtle.digest("SHA-256", fullBuffer));

    const transferId = nextTransferIdRef.current++;
    const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE) || 1;

    const meta = JSON.stringify({
      type: "file-meta",
      id: transferId,
      name: file.name,
      size: file.size,
      hash,
      totalChunks,
      chunkSize: FILE_CHUNK_SIZE,
    });
    for (const dc of peers) dc.send(meta);

    const waitForBuffer = (dc: RTCDataChannel) => {
      if (dc.bufferedAmount < FILE_BACKPRESSURE_BYTES) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const handler = () => {
          if (dc.bufferedAmount < FILE_BACKPRESSURE_BYTES) {
            dc.removeEventListener("bufferedamountlow", handler);
            resolve();
          }
        };
        dc.bufferedAmountLowThreshold = Math.floor(FILE_BACKPRESSURE_BYTES / 2);
        dc.addEventListener("bufferedamountlow", handler);
      });
    };

    for (let seq = 0; seq < totalChunks; seq++) {
      const offset = seq * FILE_CHUNK_SIZE;
      const end = Math.min(offset + FILE_CHUNK_SIZE, file.size);
      const frame = writeFileFrame(transferId, seq, fullBuffer.slice(offset, end));

      for (const dc of peers) {
        if (dc.readyState !== "open") continue;
        await waitForBuffer(dc);
        dc.send(frame);
      }

      setUploadProgress(Math.floor((end / file.size) * 100));
      // Yield to UI periodically; with 64KB chunks this is ~once per MB.
      if ((seq & 15) === 15) await new Promise((r) => setTimeout(r, 0));
    }

    const complete = JSON.stringify({ type: "file-complete", id: transferId });
    for (const dc of peers) {
      if (dc.readyState !== "open") continue;
      await waitForBuffer(dc);
      dc.send(complete);
    }
    setUploadProgress(100);
  }, []);

  // P2P-first end-to-end-encrypted chat. Each recipient gets the message
  // encrypted under their own per-pair key (ECDH-derived). Delivery prefers
  // the DataChannel; the signaling server sees only ciphertext on the relay
  // path. Recipients with no shared key yet have the message queued and
  // sent when their pubkey arrives.
  const sendChatMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!currentRoomName || !socketRef.current) return;

      const myId = socketRef.current.id ?? "";
      const msgId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ts = Date.now();

      // Local echo — sender sees their own plaintext immediately, and the
      // dedup ref blocks any future copy that might still be in flight.
      addChatMessage({ msgId, id: myId, username, text: trimmed, ts });

      for (const peer of roomUsers) {
        if (peer.id === myId) continue;
        void encryptAndDispatchChat(peer.id, msgId, trimmed, ts);
      }
    },
    [addChatMessage, currentRoomName, encryptAndDispatchChat, roomUsers, username]
  );

  return (
    <>
      {appState === "username" && (
        <UsernameModal open={true} onSubmit={handleUsernameSubmit} />
      )}

      {appState === "lobby" && (
        <RoomLobby
          username={username}
          onJoinRoom={handleJoinRoom}
          onLogout={handleLogout}
          rooms={rooms}
        />
      )}

      {appState === "room" && (
        <RoomView
          roomName={currentRoomName}
          username={username}
          participants={roomUsers}
          onLeave={handleLeaveRoom}
          streamRef={streamRef}
          pcsRef={pcsRef}
          onVideoToggle={handleVideoToggle}
          onAudioToggle={handleAudioToggle}
          chatMessages={chatMessages}
          onSendChat={sendChatMessage}
          onSendFile={sendFileToAll}
          uploadProgress={uploadProgress}
          receivedFiles={receivedFiles}
          myPubKey={myPubKey}
          peerPubKeys={peerPubKeys}
          arpSessionsRef={arpSessionsRef}
          arpChannelTick={arpChannelTick}
        />
      )}
    </>
  );
};

export default Index;
