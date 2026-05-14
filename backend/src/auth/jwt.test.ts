// Vitest equivalent of __smoke_jwt.ts. Exercises the magic/session JWT
// flow without touching the network.

import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.AUTH_JWT_SECRET = 'test-secret-at-least-16-chars';
});

describe('auth/jwt', () => {
  it('round-trips a magic-link token', async () => {
    const { signMagicLink, verifyToken } = await import('./jwt.js');
    const { token, jti } = signMagicLink('alice@example.com');
    expect(token.split('.').length).toBe(3);
    const claims = verifyToken(token, 'magic');
    expect(claims.sub).toBe('alice@example.com');
    expect(claims.jti).toBe(jti);
  });

  it('round-trips a session token', async () => {
    const { signSession, verifyToken } = await import('./jwt.js');
    const { token, jti } = signSession('bob@example.com');
    const claims = verifyToken(token, 'session');
    expect(claims.sub).toBe('bob@example.com');
    expect(claims.jti).toBe(jti);
  });

  it('rejects a magic token presented as a session', async () => {
    const { signMagicLink, verifyToken } = await import('./jwt.js');
    const { token } = signMagicLink('c@d.e');
    expect(() => verifyToken(token, 'session')).toThrow();
  });

  it('tracks redeemed jtis to prevent replay', async () => {
    const { isJtiRedeemed, markJtiRedeemed } = await import('./jwt.js');
    expect(isJtiRedeemed('jwt-fresh-aaa')).toBe(false);
    markJtiRedeemed('jwt-fresh-aaa');
    expect(isJtiRedeemed('jwt-fresh-aaa')).toBe(true);
    expect(isJtiRedeemed('jwt-fresh-bbb')).toBe(false);
  });

  it('rejects a tampered token', async () => {
    const { signSession, verifyToken } = await import('./jwt.js');
    const { token } = signSession('eve@example.com');
    const parts = token.split('.');
    const broken = parts[0]! + '.' + parts[1]!.replace(/.$/, 'X') + '.' + parts[2]!;
    expect(() => verifyToken(broken, 'session')).toThrow();
  });
});
