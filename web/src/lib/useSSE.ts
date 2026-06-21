import { useEffect, useRef, useState } from 'react';
import { streamUrl } from './api.js';
import type { IntelEvent, IntelSignal } from './types.js';

export interface StreamState {
  events: IntelEvent[];
  signals: IntelSignal[];
  connected: boolean;
}

/**
 * Subscribe to the feeder's live SSE spine (/api/stream/:userId), backed by the
 * in-process event bus. Keeps a bounded rolling buffer of the most recent events
 * and signals. The 'connected'/'heartbeat' control frames are handled internally.
 */
export function useEventStream(
  userId: string,
  opts: { minScore?: number; kinds?: string[]; sourceId?: string; max?: number } = {},
): StreamState {
  const [events, setEvents] = useState<IntelEvent[]>([]);
  const [signals, setSignals] = useState<IntelSignal[]>([]);
  const [connected, setConnected] = useState(false);
  const max = opts.max ?? 200;

  // Stable key so the effect only re-subscribes when the filters actually change.
  const key = `${userId}|${opts.minScore ?? ''}|${(opts.kinds ?? []).join(',')}|${opts.sourceId ?? ''}`;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const o = optsRef.current;
    const es = new EventSource(streamUrl(userId, { minScore: o.minScore, kinds: o.kinds, sourceId: o.sourceId }));

    es.addEventListener('connected', () => setConnected(true));
    es.addEventListener('event', (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as IntelEvent;
        setEvents((prev) => [ev, ...prev].slice(0, max));
      } catch { /* ignore malformed frame */ }
    });
    es.addEventListener('signal', (e) => {
      try {
        const sig = JSON.parse((e as MessageEvent).data) as IntelSignal;
        setSignals((prev) => [sig, ...prev].slice(0, max));
      } catch { /* ignore */ }
    });
    es.onerror = () => setConnected(false);

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, max]);

  return { events, signals, connected };
}
