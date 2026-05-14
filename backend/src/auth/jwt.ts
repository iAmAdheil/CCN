// JWT sign/verify with two token kinds:
//   - magic   (10 min): emailed to the user, single-use, redeemed for a
//                       session token.
//   - session (24h):    long-lived bearer attached to the socket.io
//                       handshake.
//
// Secret comes from AUTH_JWT_SECRET in env. We don't auto-generate one in
// production-style configs because that would invalidate every issued token
// on every restart; if the env var is absent we fall back to a per-process
// random secret AND warn loudly so dev still works without configuration.

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';

let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  const ephemeral = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[auth] AUTH_JWT_SECRET is unset or too short — using a per-process ephemeral secret.\n' +
      '       Tokens will be invalidated on every server restart.',
  );
  cachedSecret = ephemeral;
  return cachedSecret;
}

export type TokenKind = 'magic' | 'session';

export interface AuthClaims extends JwtPayload {
  sub: string; // email
  kind: TokenKind;
  jti: string;
}

const MAGIC_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export function signMagicLink(email: string): { token: string; jti: string; expSeconds: number } {
  const jti = crypto.randomUUID();
  const opts: SignOptions = { expiresIn: MAGIC_TTL_SECONDS };
  const token = jwt.sign({ sub: email, kind: 'magic' as TokenKind, jti }, getSecret(), opts);
  return { token, jti, expSeconds: MAGIC_TTL_SECONDS };
}

export function signSession(email: string): { token: string; jti: string; expSeconds: number } {
  const jti = crypto.randomUUID();
  const opts: SignOptions = { expiresIn: SESSION_TTL_SECONDS };
  const token = jwt.sign({ sub: email, kind: 'session' as TokenKind, jti }, getSecret(), opts);
  return { token, jti, expSeconds: SESSION_TTL_SECONDS };
}

export function verifyToken(token: string, expectedKind: TokenKind): AuthClaims {
  const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || decoded.kind !== expectedKind) {
    throw new Error('token kind mismatch');
  }
  if (typeof decoded.sub !== 'string') {
    throw new Error('token missing subject');
  }
  if (typeof decoded.jti !== 'string') {
    throw new Error('token missing jti');
  }
  return decoded as AuthClaims;
}

// Magic-link tokens are single-use. We track redeemed jtis in memory so a
// stolen link can't be replayed within its 10-minute window. (For a multi-
// instance deployment this would need to be Redis-backed.)
const redeemedJtis = new Map<string, number>();
const REDEEM_RETENTION_MS = MAGIC_TTL_SECONDS * 1000 * 2;

export function markJtiRedeemed(jti: string): void {
  redeemedJtis.set(jti, Date.now());
  // Lazy GC — every set sweeps a few stale entries.
  if (redeemedJtis.size > 1024) {
    const cutoff = Date.now() - REDEEM_RETENTION_MS;
    for (const [k, t] of redeemedJtis) {
      if (t < cutoff) redeemedJtis.delete(k);
      if (redeemedJtis.size <= 512) break;
    }
  }
}

export function isJtiRedeemed(jti: string): boolean {
  return redeemedJtis.has(jti);
}
