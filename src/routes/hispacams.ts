import { Hono } from 'hono';

const app = new Hono();

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

/**
 * Extract poster image URL from rtsp.me embed page HTML.
 */
function extractPosterUrl(html: string): string | null {
  // poster="https://lon.rtsp.me/.../poster/ID.jpg"
  const m = html.match(/poster="(https:\/\/[^"]+\/poster\/[^"]+\.jpg)"/);
  return m ? m[1] : null;
}

/**
 * Resolve a rtsp.me embed ID to its current HLS URL.
 * rtsp.me tokens expire quickly (~hours), so we resolve on-demand.
 * Also detects dead upstream cameras (rtsp.me returns placeholder segments
 * like XXX-1-403.ts when the source is offline).
 */
app.get('/', async (c) => {
  const embedId = c.req.query('embedId');
  if (!embedId || !/^[a-zA-Z0-9]+$/.test(embedId)) {
    return c.json({ error: 'Missing or invalid embedId' }, 400);
  }

  const embedUrl = `https://rtsp.me/embed/${embedId}/?time=${Math.floor(Date.now() / 1000)}`;

  try {
    const resp = await fetch(embedUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return c.json({ error: `rtsp.me returned ${resp.status}` }, 502);
    }

    const html = await resp.text();

    // Extract HLS URL from the embed page
    const match = html.match(/https:\/\/[^'"\s]+\/hls\/[^'"\s]+\.m3u8\?ip=[0-9.]+/);
    if (!match) {
      return c.json({ error: 'HLS URL not found in embed page' }, 502);
    }

    const hlsUrl = match[0];

    // Fetch the M3U8
    const m3u8Resp = await fetch(hlsUrl, {
      headers: { ...HEADERS, Referer: embedUrl },
      signal: AbortSignal.timeout(10000),
    });

    if (!m3u8Resp.ok) {
      return c.json({ error: `HLS URL returned ${m3u8Resp.status}` }, 502);
    }

    const body = await m3u8Resp.text();
    if (!body.includes('#EXTM3U')) {
      return c.json({ error: 'Invalid M3U8 response' }, 502);
    }

    // Detect dead upstream streams: rtsp.me uses placeholder segments
    // like BrKdaEZT-1-403.ts when the camera is returning 403/404
    const segments = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    if (segments.length === 0) {
      return c.json({ error: 'Empty M3U8 playlist' }, 502);
    }

    const firstSeg = segments[0];
    if (/\-403\./.test(firstSeg) || /\-404\./.test(firstSeg)) {
      // Return poster URL as fallback
      const posterUrl = extractPosterUrl(html);
      if (posterUrl) {
        return c.json({ error: 'Camera offline', posterUrl }, 503);
      }
      return c.json({ error: 'Camera offline (upstream unreachable)' }, 503);
    }

    return c.redirect(hlsUrl, 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Proxy failed', message }, 502);
  }
});

/**
 * Get the poster (last snapshot) image for a camera.
 * Useful fallback when the live HLS stream is offline.
 */
app.get('/poster', async (c) => {
  const embedId = c.req.query('embedId');
  if (!embedId || !/^[a-zA-Z0-9]+$/.test(embedId)) {
    return c.json({ error: 'Missing or invalid embedId' }, 400);
  }

  const embedUrl = `https://rtsp.me/embed/${embedId}/?time=${Math.floor(Date.now() / 1000)}`;

  try {
    const resp = await fetch(embedUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return c.json({ error: `rtsp.me returned ${resp.status}` }, 502);
    }

    const html = await resp.text();
    const posterUrl = extractPosterUrl(html);

    if (!posterUrl) {
      return c.json({ error: 'Poster not found' }, 404);
    }

    return c.redirect(posterUrl, 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Proxy failed', message }, 502);
  }
});

export default app;
