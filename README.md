# 🖧 Decentralized LAN Communication Suite  
**Peer-to-Peer Chat • Video Calls • File Transfer • Distributed Drive • (Optional) SMTP Mail**  
*A CCN-based communication platform running entirely on a LAN environment.*

---

## 🚀 Overview

This project is a **fully decentralized communication system** built using **Computer Communication Networks (CCN)** concepts.  
Instead of routing communication through heavy centralized servers, devices inside a **Local Area Network (LAN)** communicate **directly** using **P2P connections**.

Think of it as a simplified combination of:

- 🟢 WhatsApp → Messaging  
- 🔵 Zoom → Video/Audio Calls  
- 🟣 AirDrop → File Transfer  
- 🟠 Google Drive → Shared Distributed Storage  
- 🟡 Gmail → Optional SMTP Mail Integration  

But everything runs **peer-to-peer** — private, fast, and independent of the internet.

---

## 🧱 Features

### 1️⃣ Real-Time Chat (P2P)
- One-to-one and group chat.
- Messages sent over **WebRTC Data Channels** → direct device-to-device.
- Zero message storage on the server.
- Automatic fallback via Socket.IO when WebRTC channels fail.

### 2️⃣ Video & Audio Calls (Mini Zoom)
- Real-time media streaming using **WebRTC**.
- Direct encrypted P2P transmission.
- Multi-peer meeting rooms with signaling server coordination.
- Low latency since media does not pass through backend.

### 3️⃣ Fast File Transfer (AirDrop-like)
- Large files split into chunks.
- Chunks transferred via WebRTC Data Channels.
- Receiver reassembles the file in sequence.
- Encryption before sending.
- Real-time progress UI.
- Fallback server upload/download if P2P breaks.

### 4️⃣ Distributed Shared Drive (P2P Google Drive)
- Files encrypted → split into fragments → stored across multiple peers.
- Backend holds metadata mapping fragments to peer devices.
- Redundant fragments ensure availability even when peers go offline.
- Enables a private, self-controlled cloud drive experience inside a LAN.

### 5️⃣ Optional SMTP Email Integration
- Basic email sending using **NodeMailer (SMTP)**.
- Shows integration of classic communication with P2P architecture.

---

## 🏗 System Architecture

### 🔹 Hybrid Client–Server + Peer-to-Peer Model

The backend server performs **only**:
- Peer discovery  
- Room management  
- Forwarding WebRTC signaling messages (SDP offer/answer + ICE candidates)  
- Distributed storage metadata management  

📌 **Actual chat, calls, and file data never go to the server.**  
All real communication is **direct P2P**.

---

## 🛠 Tech Stack

### **Frontend**
- React.js  
- Vite  
- WebRTC (Media Streams + Data Channels)  

### **Backend**
- Node.js  
- Express.js  
- Socket.IO  
- Metadata storage utilities  
- File chunking + encryption utilities  

---

## 🔄 WebRTC Connection Flow

1. Peer A joins a room and creates an **SDP Offer**  
2. Offer is sent to Peer B through the signaling server  
3. Peer B responds with an **SDP Answer**  
4. Both peers exchange **ICE Candidates**  
5. Direct encrypted **P2P channel** established  
6. Chat, calls, files flow directly between peers  

---

✅ Like Gmail built into your system.

---

## 🌍 Running the TURN server (NAT traversal)

Plain WebRTC works peer-to-peer when both sides can reach each other directly.
When one peer sits behind a symmetric NAT or a strict firewall, the connection
silently fails. A TURN server fixes that by relaying media for the unlucky
peer. We use [coturn](https://github.com/coturn/coturn) with the standard TURN
REST API auth pattern (HMAC-SHA1 over `<expiry>:<userId>` keyed by a shared
secret) so credentials are short-lived and never long-term-stored.

### Quick start (local dev)

```bash
# 1. Generate a long random secret
openssl rand -hex 32

# 2. Copy the env templates and paste the secret into TURN_SECRET in BOTH:
cp .env.example .env                  # consumed by docker-compose
cp backend/.env.example backend/.env  # consumed by the signaling server

# 3. Start coturn
docker compose up -d coturn

# 4. Start the signaling server and frontend as usual
cd backend && npm run start
cd ../frontend && npm run dev
```

### Verifying TURN is actually being used

1. Open two browser tabs, join the same room.
2. Click the **Network** button in the room header to open the diagnostics
   panel.
3. Each peer card shows the selected ICE candidate path. With both peers on
   the same LAN you'll usually see `host ↔ host` (direct). To force a
   relayed path for testing, block UDP egress on one tab's profile, or set
   `iceTransportPolicy: "relay"` temporarily in `frontend/utils.ts`. You
   should then see a `relay` candidate chosen and the description switch to
   *"Relayed via TURN…"*.

### Production notes

- **Linux + host networking** is strongly preferred for coturn. UDP relay
  through `docker-proxy` is slow on Windows/macOS Docker Desktop. The
  compose file has commented instructions to swap to `network_mode: host`.
- Set `EXTERNAL_IP` in `.env` to the **public** IP your TURN server is
  reachable at — this is the address coturn advertises in relay candidates.
- For TLS, configure cert paths in `coturn/turnserver.conf` and set
  `TURN_TLS=true` in `backend/.env` so the credential endpoint also returns
  `turns:` URLs.

---

## 📁 File Transfer Process

- File is divided into small chunks  
- Chunks are streamed over WebRTC DataChannel  
- Receiver reassembles them in order  
- Encryption ensures privacy  
- Real-time progress tracking  
- Server fallback for failure recovery  

---

## ☁️ Distributed Storage Workflow

1. File encrypted  
2. File split into fragments  
3. Fragments distributed across multiple peer devices  
4. Backend stores mapping:

---

## ▶️ Running the Project

### **Backend**
```bash
cd backend
npm install
node server.js
```
### **Frontend**
```bash
cd frontend
npm install
npm run dev
