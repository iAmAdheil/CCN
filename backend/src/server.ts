// server.ts
import express from "express";
import { Server } from 'socket.io';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { registerSfuHandlers } from './sfu/handlers.js';
import { modeForSize, type RoomMode } from './sfu/mode.js';

// Per-room mode. Derived from peer count but kept in a map so we can emit
// transitions (mesh -> sfu and back) exactly when the count crosses the
// threshold, not on every join/leave.
const roomMode = new Map<string, RoomMode>();

function roomSize(roomName: string): number {
  return io.sockets.adapter.rooms.get(roomName)?.size ?? 0;
}

// Mode is one-way ratchet: once a room reaches SFU, it stays SFU until the
// last peer leaves. The bidirectional case (downgrading mid-session) is
// solvable but doubles the orchestration complexity (every peer would have
// to rebuild mesh PCs in lockstep). For a first cut the demo is cleaner —
// and the bandwidth-comparison story still works because we measure at the
// up-crossing.
function reconcileMode(roomName: string): RoomMode {
  const size = roomSize(roomName);
  const prev = roomMode.get(roomName);
  if (size === 0) {
    roomMode.delete(roomName);
    return 'mesh';
  }
  const naive = modeForSize(size);
  const next: RoomMode = prev === 'sfu' ? 'sfu' : naive;
  if (prev !== next) {
    roomMode.set(roomName, next);
    if (prev !== undefined) {
      io.to(roomName).emit('room-mode', { roomName, mode: next, size });
    }
  }
  return next;
}

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const keyPath = path.resolve(__dirname, '../../localhost+1-key.pem');
const certPath = path.resolve(__dirname, '../../localhost+1.pem');

const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

let isHttps = false;
let server: https.Server | http.Server;
try {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    server = https.createServer(httpsOptions, app);
    isHttps = true;
  } else {
    server = http.createServer(app);
  }
} catch {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

async function getTransporter() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true' || false,
      auth: (process.env.SMTP_USER && process.env.SMTP_PASS)
        ? { user: process.env.SMTP_USER as string, pass: process.env.SMTP_PASS as string }
        : undefined,
    });
  }
  const testAccount = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
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
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
}

async function getAllRooms(): Promise<Room[]> {
  const rooms: Room[] = [];
  const allRooms = io.of("/").adapter.rooms;

  for (const [roomName, socketIds] of allRooms) {
    // Filter out socket's own rooms (each socket has a room with its ID)
    if (!io.of("/").sockets.has(roomName)) {
      // Get actual socket instances to extract user data
      const sockets = await io.in(roomName).fetchSockets();

      const activeUsers = sockets.map(socket =>
      ({
        id: socket.id,
        username: socket.handshake.auth.username
      })
      );

      rooms.push({
        id: roomName,
        name: roomName, // or extract from roomName if it's like "project:123"
        activeUsers: activeUsers
      });
    }
  }

  return rooms;
}


app.get('/', (req, res) => {
  res.json({
    msg: "Hello World"
  })
});

// Always-available STUN servers. TURN is added on top when TURN_SECRET is set.
const STUN_SERVERS: { urls: string }[] = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
  .split(',')
  .map((u) => ({ urls: u.trim() }))
  .filter((s) => s.urls.length > 0);

// Issue short-lived TURN credentials using the standard "TURN REST API" pattern:
//   username   = <expiry-unix-timestamp>:<userId>
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
// Coturn validates by recomputing the same HMAC, so the secret never travels
// over the wire. If TURN_SECRET / TURN_HOST aren't configured we still respond
// 200 with STUN-only — the app stays usable, just without NAT relay fallback.
app.get('/turn-credentials', (req, res) => {
  const expectedToken = process.env.TURN_CREDENTIALS_TOKEN;
  if (expectedToken) {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7)
      : (typeof req.query.token === 'string' ? req.query.token : '');
    if (token !== expectedToken) return res.status(401).json({ error: 'unauthorized' });
  }
  const secret = process.env.TURN_SECRET;
  const host = process.env.TURN_HOST;

  if (!secret || !host) {
    return res.json({ iceServers: STUN_SERVERS, ttl: 0, expiresAt: 0, turnAvailable: false });
  }

  const requestedTtl = Number(req.query.ttl);
  const ttl = Number.isFinite(requestedTtl) && requestedTtl > 0
    ? Math.min(Math.floor(requestedTtl), 24 * 60 * 60)
    : 5 * 60;

  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const userId = typeof req.query.userId === 'string' && req.query.userId.length > 0
    ? req.query.userId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
    : 'guest';
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

  const port = process.env.TURN_PORT ?? '3478';
  const tlsPort = process.env.TURN_TLS_PORT ?? '5349';
  const turnUrls = [
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`,
  ];
  if (process.env.TURN_TLS === 'true') {
    turnUrls.push(`turns:${host}:${tlsPort}?transport=tcp`);
  }

  res.json({
    iceServers: [
      ...STUN_SERVERS,
      { urls: turnUrls, username, credential },
    ],
    ttl,
    expiresAt: expiry * 1000,
    turnAvailable: true,
  });
});

app.post('/mail/send', async (req, res) => {
  const expectedToken = process.env.MAIL_TOKEN;
  if (expectedToken) {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== expectedToken) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { to, subject, text, html } = req.body || {};
    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, and text or html' });
    }

    const transporter = await getTransporter();
    const isTest = !process.env.SMTP_HOST;
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com';
    const info = await transporter.sendMail({ from, to, subject, text, html });
    const previewUrl = isTest ? nodemailer.getTestMessageUrl(info) : undefined;
    res.json({ ok: true, messageId: info.messageId, previewUrl });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to send email' });
  }
});

io.of("/").on("connection", async (socket) => {
  const rooms = await getAllRooms();
  socket.emit("fetch active rooms", JSON.stringify(rooms));
  socket.data.mediaState = {
    videoEnabled: true,
    audioEnabled: true
  };

  registerSfuHandlers(io, socket);

  socket.on("join room", async (roomName: string) => {
    await socket.join(roomName);
    const mode = reconcileMode(roomName);
    socket.emit('room-mode', { roomName, mode, size: roomSize(roomName) });
    const rooms = await getAllRooms();
    io.except(roomName).emit("fetch active rooms", JSON.stringify(rooms));

    const newUser: RoomUser = {
      id: socket.id,
      username: socket.handshake.auth.username,
      isVideoEnabled: socket.data.mediaState.videoEnabled ?? true,
      isAudioEnabled: socket.data.mediaState.audioEnabled ?? true
    };
    io.to(roomName).except(socket.id).emit("add new room user", JSON.stringify(newUser));

    const clientIDs = io.sockets.adapter.rooms.get(roomName) || new Set();
    // 2. Prepare an array to hold the client details (ID and Username)
    const clientsWithUsernames = [];
    // 3. Iterate over the client IDs to find the corresponding socket and its handshake data
    for (const clientID of clientIDs) {
      if (clientID === socket.id) continue;
      // Get the actual Socket object for the client ID
      const s = io.sockets.sockets.get(clientID);
      if (s) {
        // Access the username from the handshake.auth object
        // Assuming the client sends { auth: { username: '...' } }
        const username = s.handshake.auth.username;

        clientsWithUsernames.push({
          id: clientID, // socketID
          username: username,
          isVideoEnabled: s.data.mediaState?.videoEnabled ?? true,
          isAudioEnabled: s.data.mediaState?.audioEnabled ?? true,
        });
      }
    }

    socket.emit("fetch room users", JSON.stringify(clientsWithUsernames));
  });

  socket.on("media state change", async (data: { roomName: string, kind: "video" | "audio", enabled: boolean }) => {
    if (data.kind === "video") {
      socket.data.mediaState.videoEnabled = data.enabled;
    } else if (data.kind === "audio") {
      socket.data.mediaState.audioEnabled = data.enabled;
    }
    socket.to(data.roomName).emit("media state change", {
      userId: socket.id,
      kind: data.kind,
      enabled: data.enabled,
    });
  });

  socket.on("offer", async (data: { to: string, offer: RTCSessionDescriptionInit }) => {
    const s = io.sockets.sockets.get(data.to);
    if (s) {
      s.emit("offer", {
        from: socket.id,
        offer: data.offer,
      });
    } else {
      console.log("User not found");
    }
  });

  socket.on("answer", async (data: { to: string, answer: RTCSessionDescriptionInit }) => {
    io.to(data.to).emit("answer", {
      from: socket.id,
      answer: data.answer,
    });
  });

  socket.on("candidate", async (data: { to: string, candidate: RTCIceCandidateInit }) => {
    io.to(data.to).emit("candidate", {
      from: socket.id,
      candidate: data.candidate,
    });
  });

  // Returns true iff `socket` and `target` are in at least one shared room.
  // Used to gate per-recipient relays so the signaling server can't be turned
  // into an open DM channel between unrelated users.
  const shareRoom = (target: ReturnType<typeof io.sockets.sockets.get>) => {
    if (!target) return false;
    for (const r of socket.rooms) {
      if (r !== socket.id && target.rooms.has(r)) return true;
    }
    return false;
  };

  // ECDH public-key exchange between two peers in a shared room. The server
  // is a stateless courier — it never stores keys and cannot derive the
  // shared secret without a private key (which never leaves the browser).
  socket.on("pubkey-exchange", (data: { to: string; pubKey: string }) => {
    if (!data || typeof data.to !== "string" || typeof data.pubKey !== "string") return;
    if (data.pubKey.length === 0 || data.pubKey.length > 200) return;
    const target = io.sockets.sockets.get(data.to);
    if (!shareRoom(target)) return;
    target!.emit("peer-pubkey", { from: socket.id, pubKey: data.pubKey });
  });

  // Chat is sent peer-to-peer over RTCDataChannels. The server only relays a
  // message to a specific recipient when the sender's DataChannel to that peer
  // isn't open yet (e.g. a peer that joined moments ago). The payload is
  // already AES-GCM-encrypted under a per-pair ECDH-derived key — the server
  // sees opaque bytes only. Receivers dedupe by msgId, so it's safe for a
  // message to arrive via both DC and relay.
  socket.on("chat-relay", (data: { to: string; msgId: string; iv: string; ct: string; ts: number }) => {
    if (!data || typeof data.to !== "string" || typeof data.msgId !== "string") return;
    if (typeof data.iv !== "string" || typeof data.ct !== "string") return;
    if (data.iv.length === 0 || data.iv.length > 64) return;
    // Generous upper bound — base64 of (4096 bytes of plaintext + 16-byte AES-GCM tag).
    if (data.ct.length === 0 || data.ct.length > 8192) return;
    const target = io.sockets.sockets.get(data.to);
    if (!shareRoom(target)) return;
    target!.emit("chat message", {
      msgId: data.msgId,
      id: socket.id,
      username: socket.handshake.auth.username,
      iv: data.iv,
      ct: data.ct,
      ts: typeof data.ts === "number" ? data.ts : Date.now(),
    });
  });

  socket.on("leave room", async (roomName: string) => {
    if (!roomName) {
      return;
    }

    if (socket.rooms.has(roomName)) {
      socket.to(roomName).emit("remove room user", socket.id);
      await socket.leave(roomName);
      reconcileMode(roomName);
    }

    const rooms = await getAllRooms();
    io.emit("fetch active rooms", JSON.stringify(rooms));
  });

  socket.on("disconnecting", () => {
    for (const roomName of socket.rooms) {
      if (roomName === socket.id) continue;
      socket.to(roomName).emit("remove room user", socket.id);
      // Recompute *after* the socket is removed from the room. Socket.io
      // performs the actual removal between disconnecting and disconnect,
      // so defer the reconcile by a tick.
      setImmediate(() => reconcileMode(roomName));
    }
  });

  socket.on("disconnect", async () => {
    const rooms = await getAllRooms();
    io.emit("fetch active rooms", JSON.stringify(rooms));
  });
});


server.listen(3000, '0.0.0.0', () => {
  const proto = isHttps ? 'https' : 'http';
  console.log(`server running at ${proto}://10.0.11.158:3000`);
});