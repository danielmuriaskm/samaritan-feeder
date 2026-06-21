import { EventEmitter } from 'node:events';
import type { IntelligenceEvent, IntelSignal } from './types.js';

/**
 * In-process event spine. The CPU-only, no-Redis equivalent of the pub/sub
 * channel the old SSE stub assumed ("In production, this would subscribe to a
 * Redis pub/sub channel"). The scheduler emits every persisted event here; SSE
 * routes, a live dashboard, and any in-process consumer subscribe.
 *
 * Single Node process => a plain EventEmitter is sufficient and correct. If the
 * feeder is ever sharded, this is the one seam to swap for a real broker.
 */
class FeederBus extends EventEmitter {
  /** A new intelligence event has been persisted. */
  emitEvent(event: IntelligenceEvent): void {
    this.emit('event', event);
  }
  onEvent(handler: (event: IntelligenceEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  /** A correlation / freshness signal (convergence, silent source, ...) fired. */
  emitSignal(signal: IntelSignal): void {
    this.emit('signal', signal);
  }
  onSignal(handler: (signal: IntelSignal) => void): () => void {
    this.on('signal', handler);
    return () => this.off('signal', handler);
  }
}

export const bus = new FeederBus();

// Many SSE clients may attach; lift the default 10-listener warning cap. 0 = unbounded.
bus.setMaxListeners(0);
