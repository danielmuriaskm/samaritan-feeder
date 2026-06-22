import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Access control for the operator console + API (app layer; pair with Fly-private
 * networking for defense in depth).
 *
 * - `/health` is always public (Fly/uptime checks).
 * - OPTIONS preflight passes (CORS handles it).
 * - `Authorization: Bearer <FEEDER_SERVICE_TOKEN>` → server-to-server callers
 *   (Samaritan radar/discovery, /ingest). Bypasses the browser challenge.
 * - Otherwise HTTP Basic against CONSOLE_USER/CONSOLE_PASSWORD. The browser caches
 *   the credential, so same-origin EventSource (the Live SSE feed) authenticates
 *   automatically — which a custom bearer header could not do.
 * - If NEITHER CONSOLE_PASSWORD nor FEEDER_SERVICE_TOKEN is set, the gate is
 *   disabled (local dev) and a one-time warning is logged.
 */

let warnedOpen = false;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (c.req.method === 'OPTIONS') return next();
  const path = c.req.path;
  if (path === '/health' || path.startsWith('/health') || path === '/api/health' || path.startsWith('/api/health')) {
    return next();
  }

  const password = config.CONSOLE_PASSWORD;
  const serviceToken = config.FEEDER_SERVICE_TOKEN;

  // Dev / unconfigured: allow all, warn once.
  if (!password && !serviceToken) {
    if (!warnedOpen) {
      warnedOpen = true;
      console.warn('[auth] CONSOLE_PASSWORD and FEEDER_SERVICE_TOKEN are unset — API/console is OPEN. Set them before public exposure.');
    }
    return next();
  }

  const authz = c.req.header('authorization') ?? '';

  // Server-to-server auth, compared to FEEDER_SERVICE_TOKEN. Accept BOTH:
  //  - `Authorization: Bearer <token>`
  //  - `x-feeder-api-key: <token>`  ← Samaritan's intelligence client sends this
  //    (apps/server/src/intelligence/client.ts), so radar/discovery authenticate.
  if (serviceToken) {
    if (authz.startsWith('Bearer ') && safeEqual(authz.slice(7).trim(), serviceToken)) return next();
    const apiKey = c.req.header('x-feeder-api-key');
    if (apiKey && safeEqual(apiKey.trim(), serviceToken)) return next();
  }

  // Operator console Basic auth.
  if (password && authz.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (safeEqual(user, config.CONSOLE_USER) && safeEqual(pass, password)) return next();
    }
  }

  if (password) c.header('WWW-Authenticate', 'Basic realm="Samaritan Feeder Console"');
  return c.json({ error: 'Unauthorized' }, 401);
}
