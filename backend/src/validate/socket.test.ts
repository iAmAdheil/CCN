// Validates the zod schemas reject malformed wire payloads. Each failing
// case is a class of message a hostile or buggy client could plausibly
// send — we don't want any of them to flow into a handler.

import { describe, expect, it } from 'vitest';
import {
  AnswerPayload,
  CandidatePayload,
  ChatRelayPayload,
  JoinRoomPayload,
  MediaStateChangePayload,
  OfferPayload,
  PubkeyExchangePayload,
} from './socket.js';

describe('validate/socket', () => {
  describe('JoinRoomPayload', () => {
    it('accepts a non-empty string', () => {
      expect(JoinRoomPayload.safeParse('room-123').success).toBe(true);
    });
    it('rejects empty', () => {
      expect(JoinRoomPayload.safeParse('').success).toBe(false);
    });
    it('rejects very long names', () => {
      expect(JoinRoomPayload.safeParse('x'.repeat(200)).success).toBe(false);
    });
    it('rejects non-string', () => {
      expect(JoinRoomPayload.safeParse(42).success).toBe(false);
    });
  });

  describe('MediaStateChangePayload', () => {
    it('accepts a video toggle', () => {
      expect(
        MediaStateChangePayload.safeParse({ roomName: 'r', kind: 'video', enabled: true }).success,
      ).toBe(true);
    });
    it('rejects unknown kind', () => {
      expect(
        MediaStateChangePayload.safeParse({ roomName: 'r', kind: 'screen', enabled: true }).success,
      ).toBe(false);
    });
    it('rejects missing fields', () => {
      expect(MediaStateChangePayload.safeParse({ roomName: 'r' }).success).toBe(false);
    });
  });

  describe('OfferPayload', () => {
    it('accepts minimal SDP', () => {
      expect(
        OfferPayload.safeParse({ to: 'sock-1', offer: { type: 'offer', sdp: 'v=0' } }).success,
      ).toBe(true);
    });
    it('rejects missing recipient', () => {
      expect(OfferPayload.safeParse({ offer: { type: 'offer' } }).success).toBe(false);
    });
  });

  describe('AnswerPayload', () => {
    it('accepts answer', () => {
      expect(
        AnswerPayload.safeParse({ to: 'sock-1', answer: { type: 'answer', sdp: 'v=0' } }).success,
      ).toBe(true);
    });
  });

  describe('CandidatePayload', () => {
    it('accepts a candidate', () => {
      expect(
        CandidatePayload.safeParse({
          to: 'sock-1',
          candidate: { candidate: 'candidate:foo', sdpMid: '0', sdpMLineIndex: 0 },
        }).success,
      ).toBe(true);
    });
  });

  describe('PubkeyExchangePayload', () => {
    it('accepts a base64-ish key', () => {
      expect(
        PubkeyExchangePayload.safeParse({ to: 'sock-1', pubKey: 'a'.repeat(120) }).success,
      ).toBe(true);
    });
    it('rejects oversized keys', () => {
      expect(
        PubkeyExchangePayload.safeParse({ to: 'sock-1', pubKey: 'a'.repeat(500) }).success,
      ).toBe(false);
    });
  });

  describe('ChatRelayPayload', () => {
    it('accepts a valid chat relay', () => {
      expect(
        ChatRelayPayload.safeParse({
          to: 'sock-1',
          msgId: 'm1',
          iv: 'aaaa',
          ct: 'bbbb',
          ts: Date.now(),
        }).success,
      ).toBe(true);
    });
    it('rejects oversized ct (DoS guard)', () => {
      expect(
        ChatRelayPayload.safeParse({
          to: 'sock-1',
          msgId: 'm1',
          iv: 'aaaa',
          ct: 'b'.repeat(20_000),
        }).success,
      ).toBe(false);
    });
  });
});
