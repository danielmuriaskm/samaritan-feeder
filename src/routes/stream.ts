import { Hono } from 'hono';

const app = new Hono();

// SSE endpoint for real-time event streaming
app.get('/:userId', async (c) => {
  const userId = c.req.param('userId');

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`));

      // In production, this would subscribe to a Redis pub/sub channel
      // or an in-memory event bus scoped to the user.
      const interval = setInterval(() => {
        controller.enqueue(encoder.encode(`event: heartbeat\ndata: {}\n\n`));
      }, 30000);

      // Store cleanup reference on the controller for when client disconnects
      (controller as unknown as Record<string, unknown>).cleanup = () => {
        clearInterval(interval);
      };
    },
    cancel(controller) {
      const cleanup = (controller as unknown as Record<string, (() => void) | undefined>).cleanup;
      if (cleanup) cleanup();
    },
  });

  return c.body(stream);
});

export default app;
