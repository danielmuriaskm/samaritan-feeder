import { listSources, updateSource } from './store/sources.js';
import { getAdapter } from './adapters/index.js';
import { createEvent, dedupeExists, makeDedupeHash, reserveDedupe, isUniqueViolation } from './store/events.js';
import { filterContent, filterLanguage } from './processors/contentFilter.js';
import { randomUUID } from 'crypto';

async function runPoll() {
  const sources = await listSources(true);
  const now = Date.now();
  let totalEvents = 0;

  for (const source of sources) {
    if (!source.enabled) continue;
    const adapter = getAdapter(source.kind);
    if (!adapter) continue;
    if (source.kind !== 'rss') continue;
    // Skip Reuters which is broken
    if (source.name.includes('Reuters')) continue;

    try {
      const rawEvents = await adapter.poll(source.config, "0");
      let sourceEvents = 0;
      for (const raw of rawEvents) {
        const dedupeHash = makeDedupeHash(source.id, raw.content);
        if (await dedupeExists(dedupeHash)) continue;
        if (!reserveDedupe(dedupeHash)) continue;
        const filterResult = filterContent(raw.title ?? '', raw.content);
        if (!filterResult.pass) continue;
        const langResult = filterLanguage(raw.content);
        if (!langResult.pass) continue;
        try {
          await createEvent({
            id: randomUUID(), sourceId: source.id, kind: raw.kind ?? 'text',
            title: raw.title, content: raw.content, rawData: raw.rawData,
            mediaUrls: raw.mediaUrls, confidence: raw.confidence ?? 0.5,
            sensitivity: 'public', tags: raw.tags ?? {},
            eventAt: typeof raw.eventAt === 'number' ? raw.eventAt : Date.now(),
            dedupeHash,
          });
        } catch (err) {
          if (isUniqueViolation(err)) continue;
          throw err;
        }
        sourceEvents++;
        totalEvents++;
      }
      console.log(`[poll] ${source.name}: ${sourceEvents}/${rawEvents.length}`);
      await updateSource(source.id, { lastPolledAt: now });
    } catch (err) {
      console.error(`[poll] ${source.name} failed:`, (err as Error).message);
    }
  }
  console.log(`[poll] Total: ${totalEvents}`);
}

runPoll().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
