// SSO with Samaritan. Samaritan issues a stateless HS256 JWT session cookie
// (`samaritan_session`, signed with SESSION_SECRET, falling back to
// SAMARITAN_AUTH_TOKEN, secret padded/truncated to 32 bytes — see Samaritan's
// apps/server/src/auth/session.ts). That cookie is NOT sent to this origin
// (samaritan-feeder.fly.dev ≠ Samaritan's domain), so we use a redirect handshake:
//
//   1. unauthenticated browser hits the feeder → auth middleware 302s to
//      SAMARITAN_SSO_URL?redirect=<feeder>/auth/sso/callback
//   2. Samaritan (user already logged in) mints a short-lived token
//      (aud 'feeder-sso', signed with the SHARED secret) → 302 back to the callback
//   3. the callback verifies it and sets THIS origin's own session cookie
//      (aud 'session') → subsequent same-origin requests carry it
//
// We replicate Samaritan's signing exactly so the shared secret verifies both ways.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Context } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { config } from '../config.js';

const COOKIE = 'samaritan_feeder_session';
const SESSION_TTL_HOURS = 24;

/** Shared secret, padded/truncated to 32 bytes for HS256 — identical to Samaritan. */
function secret(): Uint8Array {
  const raw = config.SESSION_SECRET || config.SAMARITAN_AUTH_TOKEN || '';
  if (!raw) throw new Error('SESSION_SECRET (or SAMARITAN_AUTH_TOKEN) required for SSO');
  return new TextEncoder().encode(raw.length >= 32 ? raw.slice(0, 32) : raw.padEnd(32, '0'));
}

/** SSO is active only when a Samaritan SSO endpoint is configured and we have a secret. */
export function ssoEnabled(): boolean {
  return !!config.SAMARITAN_SSO_URL && !!(config.SESSION_SECRET || config.SAMARITAN_AUTH_TOKEN);
}

export interface FeederSession extends JWTPayload {
  uid: string;
  email?: string;
}

/** Verify the short-lived handshake token Samaritan mints at its /auth/sso endpoint. */
export async function verifyHandshake(token: string): Promise<FeederSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: 'feeder-sso' });
    const uid = String(payload.uid ?? payload.sub ?? '');
    if (!uid) return null;
    return { uid, email: payload.email ? String(payload.email) : undefined };
  } catch {
    return null;
  }
}

/** Issue THIS origin's session cookie after a successful handshake. */
export async function issueFeederSession(c: Context, s: { uid: string; email?: string }): Promise<void> {
  const token = await new SignJWT({ uid: s.uid, email: s.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_HOURS}h`)
    .setAudience('session')
    .sign(secret());
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_HOURS * 3600,
  });
}

/** Read + verify this origin's session cookie. */
export async function readFeederSession(c: Context): Promise<FeederSession | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: 'session' });
    const uid = String(payload.uid ?? '');
    return uid ? { uid, email: payload.email ? String(payload.email) : undefined } : null;
  } catch {
    return null;
  }
}
