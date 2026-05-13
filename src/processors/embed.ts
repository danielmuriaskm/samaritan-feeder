import { config } from '../config.js';

/**
 * Generate a 768-dimensional embedding for text.
 * Falls back to null if no embedding provider is configured.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!config.EMBEDDING_API_KEY || !config.EMBEDDING_BASE_URL) {
    return null;
  }

  const res = await fetch(`${config.EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.EMBEDDING_MODEL ?? 'text-embedding-3-small',
      input: text.slice(0, 8000),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error('Embedding request failed:', res.status);
    return null;
  }

  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  if (!vector) return null;

  // Truncate to 768 dimensions (Matryoshka-style)
  return vector.slice(0, 768);
}
