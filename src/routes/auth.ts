import { Hono } from 'hono';
import {
  getAuthorizationUrl,
  exchangeCodeForToken,
  InstagramAuthConfig,
} from '../auth/instagram-oauth.js';

const app = new Hono();

const INSTAGRAM_APP_ID = process.env['INSTAGRAM_APP_ID'] ?? '';
const INSTAGRAM_APP_SECRET = process.env['INSTAGRAM_APP_SECRET'] ?? '';
const INSTAGRAM_REDIRECT_URI = process.env['INSTAGRAM_REDIRECT_URI'] ?? 'http://localhost:3000/auth/instagram/callback';

function getConfig(): InstagramAuthConfig | null {
  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) return null;
  return {
    appId: INSTAGRAM_APP_ID,
    appSecret: INSTAGRAM_APP_SECRET,
    redirectUri: INSTAGRAM_REDIRECT_URI,
  };
}

app.get('/instagram', (c) => {
  const cfg = getConfig();
  if (!cfg) {
    return c.json({ error: 'Instagram OAuth not configured. Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.' }, 400);
  }
  const state = c.req.query('userId') ?? 'anonymous';
  const url = getAuthorizationUrl(cfg, state);
  return c.redirect(url);
});

app.get('/instagram/callback', async (c) => {
  const cfg = getConfig();
  if (!cfg) {
    return c.json({ error: 'Instagram OAuth not configured' }, 400);
  }

  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code) {
    return c.json({ error: 'Authorization code missing' }, 400);
  }

  try {
    const token = await exchangeCodeForToken(cfg, code);
    const { storeToken } = await import('../auth/instagram-oauth.js');
    await storeToken(state ?? 'anonymous', token);

    return c.json({
      success: true,
      userId: token.userId,
      message: 'Instagram account connected successfully.',
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'OAuth failed' }, 400);
  }
});

export default app;
