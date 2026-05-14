// Nodemailer transporter resolver. Real SMTP when SMTP_HOST is set;
// otherwise an Ethereal test account so dev still gets a preview URL.
//
// The transporter is created lazily and cached so we don't pay the
// Ethereal handshake every send. Reset is exposed for tests.

import nodemailer from 'nodemailer';

let cachedTransporter: nodemailer.Transporter | null = null;

export async function getTransporter(): Promise<nodemailer.Transporter> {
  if (cachedTransporter) return cachedTransporter;
  if (process.env.SMTP_HOST) {
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true' || false,
      auth: process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    return cachedTransporter;
  }
  const testAccount = await nodemailer.createTestAccount();
  cachedTransporter = nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  return cachedTransporter;
}

export function resetTransporter(): void {
  cachedTransporter = null;
}
