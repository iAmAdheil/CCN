// Zod schemas for every socket payload the server accepts. Keeping these
// in one file makes it easy to grep for "what shapes does the wire trust?"
// and is the seam for any future fuzzing.
//
// Each handler picks the relevant schema and `.safeParse`s the incoming
// payload. On failure we ignore the message rather than disconnecting,
// matching the pre-refactor behavior.

import { z } from 'zod';

const socketId = z.string().min(1).max(64);

// Backward-compatible: the legacy guest path emits a bare string room name.
// Password-protected rooms emit { roomName, password? }.
export const JoinRoomPayload = z.union([
  z.string().min(1).max(128),
  z.object({
    roomName: z.string().min(1).max(128),
    password: z.string().min(1).max(128).optional(),
  }),
]);

export const CreateRoomPayload = z.object({
  roomName: z.string().min(1).max(128),
  password: z.string().min(1).max(128).optional(),
});

export const MediaStateChangePayload = z.object({
  roomName: z.string().min(1).max(128),
  kind: z.enum(['video', 'audio']),
  enabled: z.boolean(),
});

export const OfferPayload = z.object({
  to: socketId,
  offer: z.object({
    type: z.string(),
    sdp: z.string().optional(),
  }),
});

export const AnswerPayload = z.object({
  to: socketId,
  answer: z.object({
    type: z.string(),
    sdp: z.string().optional(),
  }),
});

export const CandidatePayload = z.object({
  to: socketId,
  candidate: z.object({
    candidate: z.string().optional(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().int().nullable().optional(),
    usernameFragment: z.string().nullable().optional(),
  }),
});

export const PubkeyExchangePayload = z.object({
  to: socketId,
  pubKey: z.string().min(1).max(200),
});

export const ChatRelayPayload = z.object({
  to: socketId,
  msgId: z.string().min(1).max(128),
  iv: z.string().min(1).max(64),
  ct: z.string().min(1).max(8192),
  ts: z.number().optional(),
});

export const LeaveRoomPayload = z.string().min(1).max(128).optional();

export type JoinRoom = z.infer<typeof JoinRoomPayload>;
export type MediaStateChange = z.infer<typeof MediaStateChangePayload>;
export type Offer = z.infer<typeof OfferPayload>;
export type Answer = z.infer<typeof AnswerPayload>;
export type Candidate = z.infer<typeof CandidatePayload>;
export type PubkeyExchange = z.infer<typeof PubkeyExchangePayload>;
export type ChatRelay = z.infer<typeof ChatRelayPayload>;
