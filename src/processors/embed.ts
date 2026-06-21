import { config } from '../config.js';
import { callSamaritanEmbedding } from '../samaritan-client.js';
import { makeRotator, isRetryableStatus } from '../llm/keyPool.js';

// Embedding key pool rotator (own cursor, independent of the chat pool).
const rotateEmbedKeys = makeRotator();

/**
 * Generate a 768-dimensional embedding for text.
 * Priority:
 *   1. Samaritan internal AI proxy (/internal/ai/embeddings)
 *   2. Direct embedding provider (OpenAI, Ollama, etc.)
 *   3. Null fallback (semantic search disabled)
 */
export async function embedText(text: string): Promise<number[] | null> {
  const input = text.slice(0, 8000);
  const model = config.EMBEDDING_MODEL ?? 'text-embedding-3-small';

  // ── Attempt 1: Samaritan AI proxy ───────────────────────────────────────
  const samaritanResult = await callSamaritanEmbedding({ model, input });
  if (samaritanResult?.data?.[0]?.embedding) {
    return samaritanResult.data[0].embedding.slice(0, 768);
  }

  // ── Attempt 2: Direct embedding provider ────────────────────────────────
  return callDirectEmbedding(input, model);
}

async function callDirectEmbedding(input: string, model: string): Promise<number[] | null> {
  const keys = config.EMBEDDING_API_KEYS;
  const first = keys[0] ?? '';
  const usable =
    keys.length > 0 &&
    !!config.EMBEDDING_BASE_URL &&
    !first.includes('your-') &&
    !first.includes('placeholder') &&
    !first.includes('sk-xxxx');

  if (!usable) {
    return null;
  }

  const body = JSON.stringify({ model, input });

  // Round-robin across the embedding key pool (e.g. several Jina free accounts),
  // failing over to the next account on a throttle/quota status.
  const order = rotateEmbedKeys(keys);
  for (let i = 0; i < order.length; i++) {
    const last = i === order.length - 1;
    try {
      const res = await fetch(`${config.EMBEDDING_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${order[i]}`,
        },
        body,
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
        const vector = json.data?.[0]?.embedding;
        if (!vector) return null;
        // Truncate to 768 dimensions (Matryoshka-style)
        return vector.slice(0, 768);
      }
      if (isRetryableStatus(res.status) && !last) {
        continue; // this key is throttled/exhausted — try the next account
      }
      console.warn(`[embed] Direct embedding error: ${res.status}${keys.length > 1 ? ` (key ${i + 1}/${order.length})` : ''}`);
      return null;
    } catch (err) {
      if (!last) continue; // transient network error — try the next key
      console.warn('[embed] Direct embedding request failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return null;
}
