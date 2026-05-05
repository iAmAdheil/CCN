🌐 Project Summary (in plain English)

You’re building a mini communication platform — like a simplified mix of Zoom + Google Drive + WhatsApp + Gmail,
but everything runs peer-to-peer (P2P) using Computer Communication Networks (CCN) concepts.

So instead of depending heavily on big servers, your app makes two (or more) devices talk directly to each other over the network.

🧱 Main Parts (Simple View)
1. 💬 Messaging / Chat

Two users open the same “room”.

They can type and send messages instantly.

Messages go directly from one device to another (not through a central database).

✅ Like a WhatsApp DM — but you built the connection yourself.

2. 📞 Call / Meeting

You use the webcam and microphone.

One user creates a “meeting room”; another joins it.

Your app connects them directly using WebRTC → video and audio flow P2P.

✅ Like a mini Zoom — built by you.

3. 📁 Send Big Files

Instead of uploading to Google Drive, the file is broken into small chunks.

Those chunks are sent directly between devices.

You can see upload and download progress.

✅ Like AirDrop — but over the internet.

4. ☁️ Distributed Cloud Drive (the cool new feature)

You can store files across multiple peers (friends/devices).

Each file is split, encrypted, and parts are sent to different peers.

Later, you can rebuild the file using those pieces.

Even if one peer goes offline, others still have the fragments.

✅ Like a “Peer-to-Peer Google Drive” — you control your data.

5. 📧 Mails (Optional / later)

Add a small “send mail” feature using SMTP (Node.js mailer).

Just to show integration of traditional communication (email) with your network.

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

