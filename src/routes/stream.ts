import { Hono } from 'hono';
import { bus } from '../bus.js';
import type { IntelligenceEvent, IntelSignal } from '../types.js';

const app = new Hono();

/**
 * SSE endpoint for real-time event + signal streaming.
 *
 * Now backed by the in-process event bus (src/bus.ts) instead of the old
 * heartbeat-only stub. The scheduler emits every persisted event on `bus`; this
 * route relays them to connected clients. Single-process EventEmitter is the
 * CPU-only, no-Redis equivalent of the pub/sub the stub comment assumed.
 *
 * Optional query filters: ?minScore=0.6&kinds=alert,anomaly&sourceId=abc
 */
app.get('/:userId', async (c) => {
  const userId = c.req.param('userId');
  const minScore = c.req.query('minScore') ? Number(c.req.query('minScore')) : undefined;
  const sourceId = c.req.query('sourceId') || undefined;
  const kinds = c.req.query('kinds')?.split(',').map((s) => s.trim()).filter(Boolean);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no'); // disable proxy buffering so events flush immediately

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller closed; cleanup runs on cancel */
        }
      };

      send('connected', { userId });

      const passesEvent = (e: IntelligenceEvent): boolean => {
        if (sourceId && e.sourceId !== sourceId) return false;
        if (kinds?.length && !kinds.includes(e.kind)) return false;
        if (typeof minScore === 'number' && (e.score ?? e.confidence) < minScore) return false;
        return true;
      };

      const offEvent = bus.onEvent((e) => {
        if (passesEvent(e)) send('event', compactEvent(e));
      });
      const offSignal = bus.onSignal((s: IntelSignal) => {
        if (s.triageState === 'dismissed') return; // 006: never stream operator-dismissed signals
        if (typeof minScore !== 'number' || s.score >= minScore) send('signal', s);
      });

      const interval = setInterval(() => send('heartbeat', { t: Date.now() }), 30000);

      (controller as unknown as Record<string, unknown>).cleanup = () => {
        clearInterval(interval);
        offEvent();
        offSignal();
      };
    },
    cancel(controller) {
      const cleanup = (controller as unknown as Record<string, (() => void) | undefined>).cleanup;
      if (cleanup) cleanup();
    },
  });

  return c.body(stream);
});

/** Trim heavy fields (raw embeddings/rawData) before pushing over the wire. */
function compactEvent(e: IntelligenceEvent): Record<string, unknown> {
  return {
    id: e.id,
    sourceId: e.sourceId,
    kind: e.kind,
    title: e.title,
    content: e.content.slice(0, 500),
    score: e.score,
    confidence: e.confidence,
    tags: e.tags,
    location: e.location,
    eventAt: e.eventAt,
  };
}

export default app;
