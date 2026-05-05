// arpSession.ts — binds the pure ARP protocol to a real WebRTC DataChannel.
//
// The DataChannel must be configured with { ordered: false, maxRetransmits: 0 }
// so SCTP doesn't quietly add the reliability we want to demonstrate building
// ourselves. The session:
//
//   - splits app-level send() input into MSS-sized segments and feeds them
//     into ArpSender
//   - dispatches inbound DataChannel frames to ArpReceiver (DATA) or
//     ArpSender (ACK)
//   - drives sender.tick() at ~50 Hz so RTO timers fire promptly
//   - keeps a bounded ring buffer of the last N packets for the visualizer
//   - supports an injectable outgoing-loss probability — the dropped frame
//     is logged but never reaches the wire, simulating network loss

import {
  ArpSender,
  ArpReceiver,
  encodeFrame,
  decodeFrame,
  ARP_FRAME_DATA,
  ARP_FRAME_ACK,
  ARP_MSS,
  type PacketLogEntry,
  type SenderSnapshot,
  type ReceiverSnapshot,
  type ArpFrame,
} from "./arpProtocol";

const TICK_INTERVAL_MS = 20;
const PACKET_LOG_MAX = 200;

export interface ArpSessionSnapshot {
  sender: SenderSnapshot;
  receiver: ReceiverSnapshot;
  packetLog: PacketLogEntry[];
  lossPct: number;
  channelState: RTCDataChannelState;
}

export class ArpSession {
  readonly sender: ArpSender;
  readonly receiver: ArpReceiver;

  private timer: number | null = null;
  private packetLog: PacketLogEntry[] = [];
  // Outgoing-side loss probability (0..1). Lets the visualizer demonstrate
  // congestion-control reactions without needing a flaky network.
  outboundLossPct = 0;

  // Called when an in-order, fully-delivered byte chunk arrives from the peer.
  onMessage: ((data: Uint8Array) => void) | null = null;

  constructor(public readonly dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";

    const log = (e: PacketLogEntry) => {
      this.packetLog.push(e);
      if (this.packetLog.length > PACKET_LOG_MAX) {
        this.packetLog.splice(0, this.packetLog.length - PACKET_LOG_MAX);
      }
    };

    this.sender = new ArpSender({
      send: (frame) => this.transmit(frame),
      log,
      now: () => performance.now(),
    });
    this.receiver = new ArpReceiver({
      send: (frame) => this.transmit(frame),
      deliver: (payload) => this.onMessage?.(payload),
      log,
      now: () => performance.now(),
    });

    dc.addEventListener("message", this.handleMessage);
    dc.addEventListener("close", this.stop);
  }

  // App API: takes arbitrary bytes, splits into MSS-sized segments, hands
  // each to the sender.
  send(bytes: Uint8Array): void {
    for (let off = 0; off < bytes.byteLength; off += ARP_MSS) {
      const slice = bytes.subarray(off, Math.min(off + ARP_MSS, bytes.byteLength));
      // Copy because the sender holds the buffer until ACKed.
      const owned = new Uint8Array(slice.byteLength);
      owned.set(slice);
      this.sender.enqueue(owned);
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.sender.tick(), TICK_INTERVAL_MS);
  }

  stop = () => {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  };

  destroy(): void {
    this.stop();
    this.dc.removeEventListener("message", this.handleMessage);
    this.dc.removeEventListener("close", this.stop);
  }

  snapshot(): ArpSessionSnapshot {
    return {
      sender: this.sender.snapshot(),
      receiver: this.receiver.snapshot(),
      packetLog: this.packetLog.slice(),
      lossPct: this.outboundLossPct,
      channelState: this.dc.readyState,
    };
  }

  private transmit(frame: ArpFrame): boolean {
    if (this.dc.readyState !== "open") return false;
    if (frame.type === ARP_FRAME_DATA && Math.random() < this.outboundLossPct) {
      // Loss injection: protocol is told its frame went out, but we never
      // touch the wire. The receiver will eventually trigger fast retransmit
      // or the sender's RTO will fire.
      return false;
    }
    try {
      this.dc.send(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage = (ev: MessageEvent) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const frame = decodeFrame(ev.data);
    if (!frame) return;
    if (frame.type === ARP_FRAME_DATA) {
      this.receiver.onData(frame);
    } else if (frame.type === ARP_FRAME_ACK) {
      this.sender.onAck(frame.ack, frame.window);
    }
  };
}
