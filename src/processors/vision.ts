import { config } from '../config.js';
import type { ProcessorResult } from '../types.js';

/**
 * Classify a video frame using a vision-capable LLM, returning ONLY de-identified
 * scene enums (no free-text description, no identifiable detail).
 *
 * PRIVACY: this is intended to run on a REDACTED (pixelated) thumbnail produced
 * by the CV sidecar, never a raw frame. The prompt forbids describing or
 * identifying any individual, face, clothing, or readable text (plates/names),
 * and the output is restricted to enum fields so no PII can ride along.
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

  const system = `You are a scene classifier for public webcams. You output ONLY de-identified, aggregate scene attributes. You MUST NOT describe, identify, or characterise any individual person, face, clothing, gender, age, or any readable text such as license plates or names. Never transcribe text in the image. Respond with strict JSON only.`;

  const user = `Classify this camera scene from "${opts.sourceName}". Do NOT describe individuals or readable text.

Respond with JSON (enums only, no free text):
{
  "activity_level": "low|medium|high",
  "weather_conditions": "sunny|cloudy|rain|snow|fog|night|unknown",
  "scene_label": "street|road|square|coast|nature|indoor|other",
  "anomaly_detected": false,
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

  // Enum allowlists — anything off-list collapses to a safe default, so no
  // free-text can leak through even if the model ignores the instructions.
  const ACTIVITY = ['low', 'medium', 'high'];
  const WEATHER = ['sunny', 'cloudy', 'rain', 'snow', 'fog', 'night', 'unknown'];
  const SCENE = ['street', 'road', 'square', 'coast', 'nature', 'indoor', 'other'];

  const activity = ACTIVITY.includes(parsed.activity_level as string) ? (parsed.activity_level as string) : 'low';
  const weather = WEATHER.includes(parsed.weather_conditions as string) ? (parsed.weather_conditions as string) : 'unknown';
  const sceneLabel = SCENE.includes(parsed.scene_label as string) ? (parsed.scene_label as string) : 'other';
  const anomaly = parsed.anomaly_detected === true;
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

  // Deterministic, de-identified content built from enums only.
  const content = `Scene: ${sceneLabel}; weather ${weather}; activity ${activity}.`;

  return {
    title: anomaly ? `Anomaly: ${opts.sourceName}` : `${opts.sourceName}`,
    content,
    confidence: Math.min(1, Math.max(0, confidence)),
    tags: {
      activity_level: activity,
      weather_conditions: weather,
      scene_label: sceneLabel,
      anomaly_detected: anomaly,
      processor: 'vision-llm',
    },
    sensitivity: 'public',
  };
}
