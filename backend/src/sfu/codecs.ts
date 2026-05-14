// Router-wide codec advertisement. Clients negotiate against this when they
// load a mediasoup-client Device. VP8 + Opus are the lowest-friction pair —
// every modern browser supports them. VP9/H264/AV1 can be added later for
// simulcast/SVC experiments.
import type { RtpCodecCapability } from 'mediasoup/types';

export const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    preferredPayloadType: 100,
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    preferredPayloadType: 101,
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];
