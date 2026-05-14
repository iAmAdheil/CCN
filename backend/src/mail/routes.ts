// /mail/send route. Open relay for the demo's "send link to a friend" flow
// (NOT for password-reset / auth — that lives in auth/routes.ts).

import type { Express, Request, Response } from 'express';
import nodemailer from 'nodemailer';
import { getTransporter } from './transporter.js';

export function registerMailRoutes(app: Express): void {
  app.post('/mail/send', async (req: Request, res: Response) => {
    try {
      // Optional bearer-token gate. Set MAIL_TOKEN to require an Authorization
      // header. Off by default.
      const expectedToken = process.env.MAIL_TOKEN;
      if (expectedToken) {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (token !== expectedToken) return res.status(401).json({ error: 'unauthorized' });
      }
      const { to, subject, text, html } = req.body || {};
      if (!to || !subject || (!text && !html)) {
        return res.status(400).json({
          error: 'Missing required fields: to, subject, and text or html',
        });
      }
      const transporter = await getTransporter();
      const isTest = !process.env.SMTP_HOST;
      const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com';
      const info = await transporter.sendMail({ from, to, subject, text, html });
      const previewUrl = isTest ? nodemailer.getTestMessageUrl(info) : undefined;
      res.json({ ok: true, messageId: info.messageId, previewUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send email';
      res.status(500).json({ ok: false, error: message });
    }
  });
}
