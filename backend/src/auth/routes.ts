// HTTP routes for the magic-link auth flow.
//
//   POST /auth/request-link  body: { email }
//        Generates a 10-minute magic JWT, emails it as a redeem URL.
//   POST /auth/redeem        body: { token }
//        Verifies the magic JWT, marks the jti as redeemed (single-use),
//        and returns a 24h session JWT.
//   GET  /auth/me            header: Authorization: Bearer <session>
//        Echoes the email behind the session token. Useful for UI
//        re-hydration on page reload.
//
// The frontend is responsible for stuffing `?magic=<token>` into the URL
// when constructing the email body — we just send the URL we're given.

import type { Express, Request, Response } from 'express';
import type nodemailer from 'nodemailer';
import {
  isJtiRedeemed,
  markJtiRedeemed,
  signMagicLink,
  signSession,
  verifyToken,
} from './jwt.js';
import { counterMagicLinksSent, counterRedemptions } from '../observability/metrics.js';

interface AuthRouteDeps {
  getTransporter: () => Promise<nodemailer.Transporter>;
  // The base URL the magic link should redirect users to. The frontend will
  // pick `?magic=<token>` off the URL and call /auth/redeem with it.
  // Defaults to inferring from the request's host header.
  magicLinkBase?: string;
  // Where the "from" header lives. Falls back to SMTP_FROM / SMTP_USER /
  // a no-reply default.
  mailFrom?: string;
}

function emailValid(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 3 && s.length <= 320 && s.includes('@');
}

export function registerAuthRoutes(app: Express, deps: AuthRouteDeps): void {
  app.post('/auth/request-link', async (req: Request, res: Response) => {
    try {
      const email = (req.body?.email ?? '').trim().toLowerCase();
      if (!emailValid(email)) {
        return res.status(400).json({ ok: false, error: 'invalid email' });
      }

      const { token, expSeconds } = signMagicLink(email);
      const base = deps.magicLinkBase
        ?? `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`;
      const link = `${base}/?magic=${encodeURIComponent(token)}`;

      const transporter = await deps.getTransporter();
      const isTest = !process.env.SMTP_HOST;
      const from = deps.mailFrom
        ?? process.env.SMTP_FROM
        ?? process.env.SMTP_USER
        ?? 'no-reply@example.com';

      const info = await transporter.sendMail({
        from,
        to: email,
        subject: 'Your sign-in link',
        text:
          `Click to sign in: ${link}\n\n` +
          `This link expires in ${Math.round(expSeconds / 60)} minutes and can only be used once.\n` +
          `If you didn't request this, you can ignore the email.`,
        html:
          `<p>Click to sign in:</p>` +
          `<p><a href="${link}">${link}</a></p>` +
          `<p>This link expires in ${Math.round(expSeconds / 60)} minutes and can only be used once.</p>` +
          `<p>If you didn't request this, you can ignore the email.</p>`,
      });

      // For Ethereal test accounts, expose the preview URL so dev can read
      // the email without configuring real SMTP.
      const previewUrl = isTest
        ? (await import('nodemailer')).default.getTestMessageUrl(info)
        : undefined;

      counterMagicLinksSent.inc({ result: 'ok' });
      res.json({ ok: true, previewUrl });
    } catch (err) {
      counterMagicLinksSent.inc({ result: 'error' });
      const message = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/auth/redeem', (req: Request, res: Response) => {
    try {
      const token = req.body?.token;
      if (typeof token !== 'string' || token.length === 0) {
        counterRedemptions.inc({ result: 'invalid' });
        return res.status(400).json({ ok: false, error: 'missing token' });
      }
      const claims = verifyToken(token, 'magic');
      if (isJtiRedeemed(claims.jti)) {
        counterRedemptions.inc({ result: 'replay' });
        return res.status(409).json({ ok: false, error: 'link already used' });
      }
      markJtiRedeemed(claims.jti);
      const { token: sessionToken, expSeconds } = signSession(claims.sub);
      counterRedemptions.inc({ result: 'ok' });
      res.json({ ok: true, token: sessionToken, email: claims.sub, expSeconds });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid token';
      counterRedemptions.inc({ result: message.includes('expired') ? 'expired' : 'invalid' });
      res.status(401).json({ ok: false, error: message });
    }
  });

  app.get('/auth/me', (req: Request, res: Response) => {
    const auth = req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return res.status(401).json({ ok: false, error: 'missing bearer' });
    try {
      const claims = verifyToken(m[1]!, 'session');
      res.json({ ok: true, email: claims.sub });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid token';
      res.status(401).json({ ok: false, error: message });
    }
  });
}
