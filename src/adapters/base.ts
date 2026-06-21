import type { RawEvent, SourceAdapter, SourceKind } from '../types.js';

export abstract class BaseAdapter implements SourceAdapter {
  abstract readonly kind: SourceKind;
  abstract readonly name: string;

  abstract validate(config: Record<string, unknown>): { valid: boolean; errors: string[] };
  abstract poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]>;
  abstract health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }>;

  subscribe?(
    _config: Record<string, unknown>,
    _handler: (event: RawEvent) => void,
  ): Promise<() => void> {
    throw new Error(`Subscribe not implemented for ${this.kind}`);
  }

  protected makeEvent(partial: Omit<RawEvent, 'sourceId'> & { sourceId?: string }, sourceId: string): RawEvent {
    return {
      sourceId,
      kind: partial.kind,
      title: partial.title,
      content: partial.content,
      rawData: partial.rawData,
      mediaUrls: partial.mediaUrls,
      eventAt: partial.eventAt ?? Date.now(),
      confidence: partial.confidence ?? 0.5,
      tags: partial.tags,
      location: partial.location,
      dedupeContent: partial.dedupeContent,
      artifactBase64: partial.artifactBase64,
      embeddingVector: partial.embeddingVector,
    };
  }
}
