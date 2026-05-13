import cron from 'node-cron';
import { listSources, updateSource } from './store/sources.js';
import { createEvent, dedupeExists, makeDedupeHash, deleteOldEvents } from './store/events.js';
import { getAdapter } from './adapters/index.js';
import { processTextEvent } from './processors/text.js';
import { embedText } from './processors/embed.js';
import { filterContent, filterLanguage } from './processors/contentFilter.js';
import { routeEventToSubscribers } from './delivery/router.js';
import { config } from './config.js';
import type { RawEvent, IntelligenceEvent } from './types.js';
import { randomUUID } from 'crypto';

let pollTask: cron.ScheduledTask | null = null;
let cleanupTask: cron.ScheduledTask | null = null;
let digestTask: cron.ScheduledTask | null = null;

export function startScheduler(): void {
  if (pollTask) return;

  // Poll every minute
  pollTask = cron.schedule('* * * * *', async () => {
    await runPollCycle();
  });

  // Cleanup old events daily at 3 AM
  cleanupTask = cron.schedule('0 3 * * *', async () => {
    await runCleanup();
  });

  // Digest delivery every hour
  digestTask = cron.schedule('0 * * * *', async () => {
    await runDigestCycle();
  });

  console.log('[scheduler] Started (poll: 1min, cleanup: 3am, digest: hourly)');
}

export function stopScheduler(): void {
  pollTask?.stop();
  cleanupTask?.stop();
  digestTask?.stop();
  pollTask = null;
  cleanupTask = null;
  digestTask = null;
  console.log('[scheduler] Stopped');
}

async function runPollCycle(): Promise<void> {
  const sources = await listSources(true);
  const now = Date.now();

  for (const source of sources) {
    const last = source.lastPolledAt ?? 0;
    const intervalMs = source.pollIntervalSeconds * 1000;
    if (now - last < intervalMs) continue;

    const adapter = getAdapter(source.kind);
    if (!adapter) {
      console.warn(`[scheduler] No adapter for kind: ${source.kind}`);
      continue;
    }

    try {
      const rawEvents = await adapter.poll(source.config, String(last));
      await updateSource(source.id, { lastPolledAt: now });

      for (const raw of rawEvents) {
        await ingestRawEvent(source.id, raw);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Poll failed for ${source.id}:`, msg);
      await updateSource(source.id, {
        errorCount: source.errorCount + 1,
        lastError: msg.slice(0, 500),
      });
    }
  }
}

async function ingestRawEvent(sourceId: string, raw: RawEvent): Promise<void> {
  // Deduplication
  const dedupeHash = makeDedupeHash(sourceId, raw.content);
  if (await dedupeExists(dedupeHash)) {
    return;
  }

  // Content filtering
  const filterResult = filterContent(raw.title ?? '', raw.content);
  if (!filterResult.pass) {
    console.log(`[scheduler] Filtered event from ${sourceId}: ${filterResult.reason}`);
    return;
  }

  const langResult = filterLanguage(raw.content);
  if (!langResult.pass) {
    console.log(`[scheduler] Filtered event from ${sourceId}: ${langResult.reason}`);
    return;
  }

  // Processing
  let result: { title?: string; content: string; confidence: number; tags: Record<string, unknown>; sensitivity: IntelligenceEvent['sensitivity'] };

  if (raw.kind === 'text' || raw.kind === 'social_post') {
    const processed = await processTextEvent(raw);
    result = processed;
  } else {
    result = {
      title: raw.title,
      content: raw.content.slice(0, 4000),
      confidence: raw.confidence ?? 0.5,
      tags: raw.tags ?? {},
      sensitivity: 'public',
    };
  }

  // Embedding
  const embeddingVector = await embedText(`${result.title ?? ''} ${result.content}`);

  // Rate limit guard
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recentCount = await queryRecentEventCount(sourceId, hourAgo);
  if (recentCount >= config.MAX_EVENTS_PER_SOURCE_PER_HOUR) {
    console.warn(`[scheduler] Rate limit hit for source ${sourceId}`);
    return;
  }

  // Store
  const event: IntelligenceEvent = {
    id: randomUUID(),
    sourceId,
    kind: raw.kind,
    title: result.title,
    content: result.content,
    rawData: raw.rawData,
    mediaUrls: raw.mediaUrls,
    embedding: embeddingVector ? Buffer.from(new Float32Array(embeddingVector).buffer) : undefined,
    vectorV: embeddingVector ?? undefined,
    confidence: result.confidence,
    sensitivity: result.sensitivity,
    tags: result.tags,
    eventAt: raw.eventAt,
    createdAt: Date.now(),
    dedupeHash,
  };

  await createEvent(event);
  await updateSource(sourceId, { lastEventAt: Date.now() });

  // Route to subscribers
  await routeEventToSubscribers(event);
}

async function runCleanup(): Promise<void> {
  const before = Date.now() - config.DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const count = await deleteOldEvents(before);
  console.log(`[scheduler] Cleaned up ${count} old events`);

  // Also clean raw data older than 7 days
  const rawBefore = Date.now() - config.RAW_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const { exec } = await import('./db.js');
  await exec(
    `UPDATE intelligence_events SET raw_data = NULL WHERE created_at < $1`,
    [rawBefore],
  );
}

async function runDigestCycle(): Promise<void> {
  // TODO: Implement cron-based digest delivery for subscriptions with digest_cron set
  console.log('[scheduler] Digest cycle running (placeholder)');
}

async function queryRecentEventCount(sourceId: string, since: number): Promise<number> {
  const { one } = await import('./db.js');
  const row = await one<{ count: string }>(
    `SELECT COUNT(*) as count FROM intelligence_events WHERE source_id = $1 AND created_at >= $2`,
    [sourceId, since],
  );
  return Number(row?.count ?? 0);
}
