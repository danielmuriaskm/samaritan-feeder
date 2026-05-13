import { config } from '../config.js';
import type { ProcessorResult } from '../types.js';

/**
 * Analyze a video frame using a vision-capable LLM.
 * Returns structured scene description, anomaly detection, and activity level.
 */
export async function processVisionFrame(opts: {
  frameBase64: string;
  sourceName: string;
  previousDescription?: string;
}): Promise<ProcessorResult> {
  if (!config.LLM_API_KEY || !config.LLM_BASE_URL) {
    return {
      title: `Frame from ${opts.sourceName}`,
      content: 'Vision analysis unavailable (no LLM configured).',
      confidence: 0.5,
      tags: { source: opts.sourceName },
      sensitivity: 'public',
    };
  }

  const system = `You are a security camera analyst. Describe what you see in the image concisely. Respond with strict JSON only.`;

  const user = `Analyze this camera frame from "${opts.sourceName}".${opts.previousDescription ? ` Previous frame: "${opts.previousDescription}"` : ''}

Respond with JSON:
{
  "scene_description": "What is visible? Be specific about people, vehicles, weather.",
  "activity_level": "low|medium|high",
  "notable_objects": ["car", "person", "dog"],
  "anomaly_detected": false,
  "weather_conditions": "sunny, cloudy, raining, night, etc.",
  "confidence": 0.0-1.0
}`;

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
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${opts.frameBase64}` } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Vision LLM error: ${res.status}`);
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

  const description = typeof parsed.scene_description === 'string' ? parsed.scene_description : 'No description available.';
  const activity = typeof parsed.activity_level === 'string' ? parsed.activity_level : 'low';
  const objects = Array.isArray(parsed.notable_objects) ? parsed.notable_objects : [];
  const anomaly = parsed.anomaly_detected === true;
  const weather = typeof parsed.weather_conditions === 'string' ? parsed.weather_conditions : 'unknown';
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

  return {
    title: anomaly ? `🚨 Anomaly: ${opts.sourceName}` : `${opts.sourceName}`,
    content: description,
    confidence: Math.min(1, Math.max(0, confidence)),
    tags: {
      activity_level: activity,
      notable_objects: objects,
      anomaly_detected: anomaly,
      weather_conditions: weather,
      processor: 'vision-llm',
    },
    sensitivity: 'public',
  };
}
