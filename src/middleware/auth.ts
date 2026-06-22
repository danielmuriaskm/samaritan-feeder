import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { ssoEnabled, readFeederSession } from '../auth/feederSession.js';

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
  // SSO handshake landing — public; it verifies the Samaritan-signed token itself.
  if (path === '/auth/sso/callback') {
    return next();
  }

  const password = config.CONSOLE_PASSWORD;
  const serviceToken = config.FEEDER_SERVICE_TOKEN;
  const sso = ssoEnabled();

  // Dev / unconfigured: allow all, warn once.
  if (!password && !serviceToken && !sso) {
    if (!warnedOpen) {
      warnedOpen = true;
      console.warn('[auth] CONSOLE_PASSWORD and FEEDER_SERVICE_TOKEN are unset — API/console is OPEN. Set them before public exposure.');
    }
    return next();
  }

  // Single sign-on: a valid Samaritan-issued session cookie on this origin (set by the
  // /auth/sso/callback handshake) lets a Samaritan-logged-in user in with no prompt.
  if (sso) {
    const session = await readFeederSession(c);
    if (session) return next();
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

  // Unauthenticated. With SSO on, redirect a browser page-load to Samaritan's login
  // (single sign-on) rather than popping the Basic dialog; non-document requests get 401.
  if (sso && config.SAMARITAN_SSO_URL) {
    const accept = c.req.header('accept') ?? '';
    if (c.req.method === 'GET' && accept.includes('text/html')) {
      // The feeder is served over HTTPS publicly (fly force_https); behind the proxy the
      // internal request URL is http, so build the callback from Host + forwarded proto.
      const host = c.req.header('host') ?? new URL(c.req.url).host;
      const proto = c.req.header('x-forwarded-proto') ?? 'https';
      const cb = `${proto}://${host}/auth/sso/callback`;
      const sep = config.SAMARITAN_SSO_URL.includes('?') ? '&' : '?';
      return c.redirect(`${config.SAMARITAN_SSO_URL}${sep}redirect=${encodeURIComponent(cb)}`, 302);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (password) c.header('WWW-Authenticate', 'Basic realm="Samaritan Feeder Console"');
  return c.json({ error: 'Unauthorized' }, 401);
}
