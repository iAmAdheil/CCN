// socket.io connect-time middleware. Reads handshake.auth.token (a session
// JWT) and attaches the decoded email to socket.data. When AUTH_REQUIRED is
// set, connections without a valid token are rejected; otherwise auth is
// best-effort so the existing username-only flow keeps working.

import type { Server, Socket } from 'socket.io';
import { verifyToken } from './jwt.js';

const REQUIRE_AUTH = process.env.AUTH_REQUIRED === 'true';

export interface AuthedData {
  authEmail?: string;
}

export function attachAuthMiddleware(io: Server): void {
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      if (REQUIRE_AUTH) return next(new Error('auth required'));
      return next();
    }
    try {
      const claims = verifyToken(token, 'session');
      (socket.data as AuthedData).authEmail = claims.sub;
      next();
    } catch (err) {
      if (REQUIRE_AUTH) {
        const message = err instanceof Error ? err.message : 'invalid session';
        return next(new Error(`auth failed: ${message}`));
      }
      next();
    }
  });
}
