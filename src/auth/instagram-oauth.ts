/**
 * Instagram Basic Display API OAuth flow.
 * Allows users to connect their Instagram accounts for private content access.
 */

const INSTAGRAM_AUTH_URL = 'https://api.instagram.com/oauth/authorize';
const INSTAGRAM_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const INSTAGRAM_GRAPH_URL = 'https://graph.instagram.com';

export interface InstagramAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export interface InstagramToken {
  accessToken: string;
  userId: string;
  expiresIn?: number;
  obtainedAt: number;
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  media_url: string;
  permalink: string;
  timestamp: string;
}

/**
 * Build the Instagram OAuth authorization URL.
 */
export function getAuthorizationUrl(cfg: InstagramAuthConfig, state?: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    scope: 'user_profile,user_media',
    response_type: 'code',
  });
  if (state) params.set('state', state);
  return `${INSTAGRAM_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 */
export async function exchangeCodeForToken(
  cfg: InstagramAuthConfig,
  code: string,
): Promise<InstagramToken> {
  const formData = new URLSearchParams();
  formData.append('client_id', cfg.appId);
  formData.append('client_secret', cfg.appSecret);
  formData.append('grant_type', 'authorization_code');
  formData.append('redirect_uri', cfg.redirectUri);
  formData.append('code', code);

  const res = await fetch(INSTAGRAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Instagram token exchange failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { access_token: string; user_id: number };

  return {
    accessToken: json.access_token,
    userId: String(json.user_id),
    obtainedAt: Date.now(),
  };
}

/**
 * Refresh a long-lived token (Instagram Basic Display tokens are valid for 60 days).
 */
export async function refreshLongLivedToken(accessToken: string): Promise<InstagramToken> {
  const url = `${INSTAGRAM_GRAPH_URL}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Instagram token refresh failed: ${res.status}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };

  return {
    accessToken: json.access_token,
    userId: '', // Not returned on refresh
    expiresIn: json.expires_in,
    obtainedAt: Date.now(),
  };
}

/**
 * Fetch user's recent media posts.
 */
export async function fetchUserMedia(
  token: InstagramToken,
  limit = 25,
): Promise<InstagramMedia[]> {
  const url = `${INSTAGRAM_GRAPH_URL}/me/media?fields=id,caption,media_type,media_url,permalink,timestamp&limit=${limit}&access_token=${encodeURIComponent(token.accessToken)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Instagram media fetch failed: ${res.status}`);
  }

  const json = (await res.json()) as { data?: InstagramMedia[] };
  return json.data ?? [];
}

/**
 * Store Instagram token securely (placeholder — in production, encrypt with FEEDER_ENCRYPTION_KEY).
 */
export async function storeToken(userId: string, token: InstagramToken): Promise<void> {
  const { exec } = await import('../db.js');
  await exec(
    `INSERT INTO instagram_tokens (user_id, access_token, instagram_user_id, obtained_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       instagram_user_id = EXCLUDED.instagram_user_id,
       obtained_at = EXCLUDED.obtained_at,
       expires_at = EXCLUDED.expires_at`,
    [
      userId,
      token.accessToken,
      token.userId,
      token.obtainedAt,
      token.expiresIn ? token.obtainedAt + token.expiresIn * 1000 : null,
    ],
  );
}
