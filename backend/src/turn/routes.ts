// /turn-credentials route. Issues short-lived TURN credentials following
// the standard "TURN REST API" pattern:
//   username   = <expiry-unix-timestamp>:<userId>
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
//
// Coturn validates by recomputing the same HMAC, so the secret never
// travels over the wire. If TURN_SECRET / TURN_HOST aren't configured we
// still respond 200 with STUN-only — the app stays usable, just without
// NAT relay fallback.

import type { Express, Request, Response } from 'express';
import crypto from 'crypto';

const STUN_SERVERS: { urls: string }[] = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
  .split(',')
  .map((u) => ({ urls: u.trim() }))
  .filter((s) => s.urls.length > 0);

export function registerTurnRoutes(app: Express): void {
  app.get('/turn-credentials', (req: Request, res: Response) => {
    // Optional bearer-token gate. Set TURN_CREDENTIALS_TOKEN to require an
    // Authorization: Bearer header (or ?token= query param). Off by default.
    const expectedToken = process.env.TURN_CREDENTIALS_TOKEN;
    if (expectedToken) {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ')
        ? auth.slice(7)
        : typeof req.query.token === 'string'
          ? req.query.token
          : '';
      if (token !== expectedToken) return res.status(401).json({ error: 'unauthorized' });
    }

    const secret = process.env.TURN_SECRET;
    const host = process.env.TURN_HOST;

    if (!secret || !host) {
      return res.json({ iceServers: STUN_SERVERS, ttl: 0, expiresAt: 0, turnAvailable: false });
    }

    const requestedTtl = Number(req.query.ttl);
    const ttl =
      Number.isFinite(requestedTtl) && requestedTtl > 0
        ? Math.min(Math.floor(requestedTtl), 24 * 60 * 60)
        : 5 * 60;

    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const userId =
      typeof req.query.userId === 'string' && req.query.userId.length > 0
        ? req.query.userId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
        : 'guest';
    const username = `${expiry}:${userId}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

    const port = process.env.TURN_PORT ?? '3478';
    const tlsPort = process.env.TURN_TLS_PORT ?? '5349';
    const turnUrls = [
      `turn:${host}:${port}?transport=udp`,
      `turn:${host}:${port}?transport=tcp`,
    ];
    if (process.env.TURN_TLS === 'true') {
      turnUrls.push(`turns:${host}:${tlsPort}?transport=tcp`);
    }

    res.json({
      iceServers: [...STUN_SERVERS, { urls: turnUrls, username, credential }],
      ttl,
      expiresAt: expiry * 1000,
      turnAvailable: true,
    });
  });
}
