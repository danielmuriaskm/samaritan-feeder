import type { RawEvent, ProcessorResult } from '../types.js';
import { config } from '../config.js';

/**
 * Summarize and classify a raw text event using a cheap LLM.
 * Falls back to pass-through if no LLM is configured.
 */
export async function processTextEvent(raw: RawEvent): Promise<ProcessorResult> {
  if (!config.LLM_API_KEY || !config.LLM_BASE_URL) {
    // Fallback: just clean up the content
    return {
      title: raw.title ?? 'Untitled',
      content: raw.content.slice(0, 4000),
      confidence: raw.confidence ?? 0.5,
      tags: raw.tags ?? {},
      sensitivity: 'public',
    };
  }

  const system = `You are an intelligence analyst. Summarize the input post for a human analyst. Respond with strict JSON.`;

  const user = `Post title: ${raw.title ?? 'N/A'}\nPost content: ${raw.content.slice(0, 3000)}\n\nRespond with JSON:\n{\n  "summary": "brief summary",\n  "sentiment": "positive|neutral|negative",\n  "entities": ["entity1", "entity2"],\n  "urgency": 0.0-1.0,\n  "topics": ["topic1"],\n  "sensitivity": "public|normal|private"\n}`;

  const res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.LLM_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Text processor LLM error: ${res.status}`);
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? '{}';

  let parsed: Record<string, unknown>;
  try {
    const clean = text.replace(/```json\s*|```\s*$/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    parsed = {};
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary : raw.content.slice(0, 500);
  const sentiment = typeof parsed.sentiment === 'string' ? parsed.sentiment : 'neutral';
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const urgency = typeof parsed.urgency === 'number' ? parsed.urgency : 0.5;
  const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
  const sensitivity = parsed.sensitivity === 'private' || parsed.sensitivity === 'normal' || parsed.sensitivity === 'public'
    ? parsed.sensitivity
    : 'public';

  return {
    title: raw.title ?? `${topics[0] ?? 'Event'} from ${raw.sourceId}`,
    content: summary,
    confidence: Math.min(1, Math.max(0, urgency)),
    tags: {
      ...raw.tags,
      sentiment,
      entities,
      urgency,
      topics,
      processor: 'text-llm',
    },
    sensitivity,
  };
}
