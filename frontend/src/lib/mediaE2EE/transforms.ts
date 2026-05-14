// Apply per-frame AES-GCM transforms to RTCRtpSender / RTCRtpReceiver so
// the SFU forwarder sees opaque bytes only.
//
// We use the in-context TransformStream form (RTCRtpSender.transform =
// new TransformStream({...})), which works in Chromium and avoids a Worker
// round-trip. The standardized RTCRtpScriptTransform (Worker-based) is more
// portable but doubles the moving parts; we'll switch when we need Firefox
// and Safari support.
//
// Frame layout produced by FrameCipher:
//   [12 IV][N ciphertext+tag]
// We replace the encoded frame's data with this blob. The frame container
// metadata (timestamp, type, etc.) is left untouched so the receiver's
// decoder can still depacketize at the SFU layer.
import { FrameCipher } from './frameCipher.js';

// RTCEncodedVideoFrame / RTCEncodedAudioFrame are vendor-typed; declare a
// narrow shape to avoid pulling in @types/webrtc-extensions.
interface EncodedFrame {
  data: ArrayBuffer;
  // mediasoup writes per-frame metadata to a `metadata` property which we
  // don't touch.
}

function makeEncodeTransform(cipher: FrameCipher): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      if (!cipher.hasKey()) {
        // Not yet keyed — drop the frame rather than ship plaintext. The
        // sender will simply not emit until the key arrives.
        return;
      }
      try {
        const wire = await cipher.encrypt(new Uint8Array(frame.data));
        frame.data = wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength);
        controller.enqueue(frame);
      } catch (err) {
        console.warn('[mediaE2EE] encode transform failed:', err);
      }
    },
  });
}

function makeDecodeTransform(
  cipher: FrameCipher,
  getKeyId: () => number,
): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      if (!cipher.hasKey()) {
        // Not yet keyed — drop incoming ciphertext rather than feed it to
        // the decoder. The receiver will show a frozen frame until keying.
        return;
      }
      try {
        const wire = new Uint8Array(frame.data);
        const plain = await cipher.decrypt(wire, getKeyId());
        frame.data = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
        controller.enqueue(frame);
      } catch (err) {
        // Bad tag / wrong key — drop. A future key-rotation could be
        // triggered here, but v1 just logs.
        console.warn('[mediaE2EE] decode transform failed:', err);
      }
    },
  });
}

// Apply outgoing encryption to a sender. The transform setter is a
// Chromium-only path; in other browsers this is a no-op and the SFU will
// see plaintext (acceptable for the demo when running in Chromium).
export function applySenderTransform(sender: RTCRtpSender, cipher: FrameCipher): boolean {
  const s = sender as RTCRtpSender & { transform?: TransformStream<EncodedFrame, EncodedFrame> | null };
  if (typeof (s as { transform?: unknown }).transform === 'undefined') {
    return false;
  }
  try {
    s.transform = makeEncodeTransform(cipher);
    return true;
  } catch (err) {
    console.warn('[mediaE2EE] sender.transform setter failed:', err);
    return false;
  }
}

export function applyReceiverTransform(
  receiver: RTCRtpReceiver,
  cipher: FrameCipher,
  getKeyId: () => number,
): boolean {
  const r = receiver as RTCRtpReceiver & { transform?: TransformStream<EncodedFrame, EncodedFrame> | null };
  if (typeof (r as { transform?: unknown }).transform === 'undefined') {
    return false;
  }
  try {
    r.transform = makeDecodeTransform(cipher, getKeyId);
    return true;
  } catch (err) {
    console.warn('[mediaE2EE] receiver.transform setter failed:', err);
    return false;
  }
}

// Reach into mediasoup-client's transport handler to find the underlying
// RTCPeerConnection. Used to locate the sender/receiver for a given track.
// This is internal-API access; future mediasoup-client versions may rename
// the field. We probe a couple of likely paths.
export function getUnderlyingPc(transport: unknown): RTCPeerConnection | null {
  const t = transport as { handler?: { _pc?: RTCPeerConnection; pc?: RTCPeerConnection } };
  return t?.handler?._pc ?? t?.handler?.pc ?? null;
}
