// useMediaE2EE — owns the shared media-encryption key for the current room.
//
// The key is a raw 32-byte AES-GCM secret. The first peer who asks (and
// doesn't get an answer from any other peer in ROOM_JOIN_GRACE_MS)
// generates one. Later joiners send a `media-key-request` to any peer
// they share a chat pubkey with, and the responder wraps the raw key
// under the per-pair chat AES-GCM key and replies with `media-key-enc`.
//
// The hook returns a stable FrameCipher that useSfu binds into the
// produce / consume transform path — when the cipher gets keyed, frames
// start flowing encrypted; before then, the encode transform drops
// outbound frames rather than ship plaintext.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FrameCipher,
  generateRawMediaKey,
  importMediaKey,
} from '@/lib/mediaE2EE/frameCipher';
import {
  generateMediaKeyState,
  unwrapMediaKey,
  wrapMediaKey,
  type MediaKeyEnvelope,
  type MediaKeyState,
} from '@/lib/mediaE2EE/groupKey';

export interface MediaE2EEApi {
  cipher: FrameCipher;
  keyId: number | null;
  hasKey: boolean;
  // Called when a `media-key-request` arrives from a peer we share a
  // chat-pair key with. Returns null if we have no key to share yet.
  wrapForPeer: (pairKey: CryptoKey) => Promise<MediaKeyEnvelope | null>;
  // Adopt a key received from a peer via `media-key-enc`. No-op if we
  // already hold a key with the same keyId (idempotent under retries).
  adoptFromEnvelope: (env: MediaKeyEnvelope, pairKey: CryptoKey) => Promise<void>;
  // Generate a fresh local key. Called by the first peer who can't find
  // anyone else holding one.
  generateLocal: () => Promise<void>;
  // Reset on room leave so a fresh join starts cleanly.
  reset: () => void;
}

export function useMediaE2EE(): MediaE2EEApi {
  const [keyId, setKeyId] = useState<number | null>(null);
  const stateRef = useRef<MediaKeyState | null>(null);
  // FrameCipher is mutable and reused — keep it stable across renders so
  // the transforms in useSfu don't need to be reattached on every key
  // change.
  const cipher = useMemo(() => new FrameCipher(), []);

  const applyState = useCallback(
    async (state: MediaKeyState) => {
      if (stateRef.current && stateRef.current.keyId === state.keyId) return;
      const cryptoKey = await importMediaKey(state.rawKey);
      stateRef.current = state;
      cipher.setKey({ keyId: state.keyId, cryptoKey });
      setKeyId(state.keyId);
    },
    [cipher],
  );

  const wrapForPeer = useCallback<MediaE2EEApi['wrapForPeer']>(
    async (pairKey) => {
      const state = stateRef.current;
      if (!state) return null;
      return wrapMediaKey(state, pairKey);
    },
    [],
  );

  const adoptFromEnvelope = useCallback<MediaE2EEApi['adoptFromEnvelope']>(
    async (env, pairKey) => {
      if (stateRef.current && stateRef.current.keyId === env.keyId) return;
      const state = await unwrapMediaKey(env, pairKey);
      await applyState(state);
    },
    [applyState],
  );

  const generateLocal = useCallback<MediaE2EEApi['generateLocal']>(
    async () => {
      if (stateRef.current) return;
      // Use the raw key generator (32 bytes); importMediaKey happens inside applyState.
      const raw = await generateRawMediaKey();
      const id = (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0;
      await applyState({ keyId: id, rawKey: raw });
    },
    [applyState],
  );

  const reset = useCallback(() => {
    stateRef.current = null;
    cipher.clearKey();
    setKeyId(null);
  }, [cipher]);

  // On unmount, clear any references.
  useEffect(() => {
    return () => {
      stateRef.current = null;
    };
  }, []);

  return {
    cipher,
    keyId,
    hasKey: keyId !== null,
    wrapForPeer,
    adoptFromEnvelope,
    generateLocal,
    reset,
  };
}
