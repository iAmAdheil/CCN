// Composition root. Wires Express, https/http, socket.io, the SFU + auth
// middleware, and per-connection signaling handlers. Domain logic lives in
// the per-feature modules under src/.

import express from 'express';
import { Server } from 'socket.io';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { registerSfuHandlers } from './sfu/handlers.js';
import { registerAuthRoutes } from './auth/routes.js';
import { attachAuthMiddleware } from './auth/socket.js';
import { registerTurnRoutes } from './turn/routes.js';
import { registerMailRoutes } from './mail/routes.js';
import { getTransporter } from './mail/transporter.js';
import { bindRoomManager, getAllRooms } from './rooms/manager.js';
import { registerRoomHandlers } from './signaling/room.js';
import { registerRelayHandlers } from './signaling/relay.js';
import { registerMetricsRoute } from './observability/routes.js';
import { startMetricsSampler } from './observability/sampler.js';
import { counterSocketEvents } from './observability/metrics.js';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

bindRoomManager(io);
attachAuthMiddleware(io);

app.get('/', (_req, res) => {
  res.json({ msg: 'Hello World' });
});

registerTurnRoutes(app);
registerMailRoutes(app);
registerAuthRoutes(app, {
  getTransporter,
  ...(process.env.MAGIC_LINK_BASE ? { magicLinkBase: process.env.MAGIC_LINK_BASE } : {}),
});
registerMetricsRoute(app);
startMetricsSampler(io, Number(process.env.METRICS_INTERVAL_MS) || 5000);

io.of('/').on('connection', async (socket) => {
  counterSocketEvents.inc({ event: 'connection' });
  const rooms = await getAllRooms();
  socket.emit('fetch active rooms', JSON.stringify(rooms));

  registerSfuHandlers(io, socket);
  registerRoomHandlers(io, socket);
  registerRelayHandlers(io, socket);
});

server.listen(3000, '0.0.0.0', () => {
  const proto = isHttps ? 'https' : 'http';
  console.log(`server running at ${proto}://10.0.11.158:3000`);
});
