import { config } from './config.js';

/**
 * Push an intelligence alert to Samaritan for proactive delivery
 * (e.g. Telegram DM via the bot's internal endpoint).
 */
export async function pushAlertToSamaritan(opts: {
  userId: string;
  chatId?: number;
  title: string;
  content: string;
  mediaUrls?: string[];
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${config.SAMARITAN_BASE_URL}/internal/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-samaritan-auth': config.SAMARITAN_AUTH_TOKEN,
      },
      body: JSON.stringify({
        chat_id: opts.chatId,
        text: `🚨 *Intel Alert*\n\n*${opts.title}*\n\n${opts.content}`,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Samaritan returned ${res.status}: ${text}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch a user's intelligence digest from the feeder itself.
 * Called by Samaritan during system prompt assembly.
 */
export async function getDigestForUser(_userId: string, _query?: string): Promise<string | null> {
  // In the feeder service, this would query local DB.
  // When called from Samaritan, it would hit the feeder's /digest endpoint.
  return null;
}

// ── Samaritan AI proxy ──────────────────────────────────────────────────────

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

/**
 * Call Samaritan's internal LLM endpoint.
 * Returns null if Samaritan doesn't expose /internal/ai/chat (404)
 * or if the request fails.
 */
export async function callSamaritanLLM(opts: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
}): Promise<LLMResponse | null> {
  try {
    const res = await fetch(`${config.SAMARITAN_BASE_URL}/internal/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-samaritan-auth': config.SAMARITAN_AUTH_TOKEN,
      },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 404) {
      // Samaritan doesn't expose this endpoint yet
      return null;
    }
    if (!res.ok) {
      console.warn(`[samaritan-client] LLM proxy returned ${res.status}`);
      return null;
    }
    return (await res.json()) as LLMResponse;
  } catch (err) {
    console.warn('[samaritan-client] LLM proxy error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Call Samaritan's internal embedding endpoint.
 * Returns null if Samaritan doesn't expose /internal/ai/embeddings (404)
 * or if the request fails.
 */
export async function callSamaritanEmbedding(opts: {
  model: string;
  input: string;
}): Promise<EmbeddingResponse | null> {
  try {
    const res = await fetch(`${config.SAMARITAN_BASE_URL}/internal/ai/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-samaritan-auth': config.SAMARITAN_AUTH_TOKEN,
      },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 404) {
      // Samaritan doesn't expose this endpoint yet
      return null;
    }
    if (!res.ok) {
      console.warn(`[samaritan-client] Embedding proxy returned ${res.status}`);
      return null;
    }
    return (await res.json()) as EmbeddingResponse;
  } catch (err) {
    console.warn('[samaritan-client] Embedding proxy error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
