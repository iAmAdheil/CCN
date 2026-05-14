// Per-connection relay handlers — chat-relay (E2EE chat fallback when DC
// isn't open yet) and pubkey-exchange (ECDH public key courier). Both
// gate strictly on shared room membership so the signaling server can't be
// turned into an open DM channel between unrelated users.

import type { Server, Socket } from 'socket.io';
import { ChatRelayPayload, PubkeyExchangePayload } from '../validate/socket.js';
import { counterSocketEvents } from '../observability/metrics.js';

function shareRoom(socket: Socket, target: Socket | undefined): boolean {
  if (!target) return false;
  for (const r of socket.rooms) {
    if (r !== socket.id && target.rooms.has(r)) return true;
  }
  return false;
}

export function registerRelayHandlers(io: Server, socket: Socket): void {
  // ECDH public-key exchange between two peers in a shared room. The
  // server is a stateless courier — never stores keys and cannot derive
  // the shared secret without a private key (which never leaves the
  // browser).
  socket.on('pubkey-exchange', (raw: unknown) => {
    const parsed = PubkeyExchangePayload.safeParse(raw);
    if (!parsed.success) return;
    const target = io.sockets.sockets.get(parsed.data.to);
    if (!shareRoom(socket, target)) return;
    target!.emit('peer-pubkey', { from: socket.id, pubKey: parsed.data.pubKey });
  });

  // Chat is sent peer-to-peer over RTCDataChannels. The server only relays
  // a message to a specific recipient when the sender's DataChannel to that
  // peer isn't open yet. The payload is already AES-GCM-encrypted under a
  // per-pair ECDH-derived key — the server sees opaque bytes only.
  // Receivers dedupe by msgId, so it's safe for a message to arrive via
  // both DC and relay.
  socket.on('chat-relay', (raw: unknown) => {
    counterSocketEvents.inc({ event: 'chat_relay' });
    const parsed = ChatRelayPayload.safeParse(raw);
    if (!parsed.success) return;
    const data = parsed.data;
    const target = io.sockets.sockets.get(data.to);
    if (!shareRoom(socket, target)) return;
    target!.emit('chat message', {
      msgId: data.msgId,
      id: socket.id,
      username: socket.handshake.auth.username,
      iv: data.iv,
      ct: data.ct,
      ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    });
  });
}
