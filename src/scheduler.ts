import cron from 'node-cron';
import { listSources, updateSource, recordPollSuccess, recordPollFailure } from './store/sources.js';
import { createEvent, dedupeExists, makeDedupeHash, deleteOldEvents, reserveDedupe, isUniqueViolation, runLineageSweep } from './store/events.js';
import { bus } from './bus.js';
import { computeScore } from './scoring/score.js';
import { trustForKind } from './scoring/sourceTrust.js';
import { nextCooldownUntil, isInCooldown } from './net/circuitBreaker.js';
import { persistCvDetail, persistCvAlerts, insertCvEmbedding } from './store/cv.js';
import { getAdapter } from './adapters/index.js';
import { processTextEvent } from './processors/text.js';
import { embedText } from './processors/embed.js';
import { filterContent, filterLanguage } from './processors/contentFilter.js';
import { routeEventToSubscribers } from './delivery/router.js';
import { enrichEventWithExifLocation } from './processors/exifGeo.js';
import { clusterRecentEvents } from './processors/nlpCluster.js';
import { runConvergence } from './processors/convergence.js';
import { runFreshnessSweep } from './processors/freshness.js';
import { runDigestCycle as synthDigestCycle } from './processors/briefSynth.js';
import { tagLocation } from './geo/countryResolver.js';
import { extractAndLinkEntities } from './store/entities.js';
import { runDomainRecon } from './processors/reconDomain.js';
import { runIpEnrichment } from './processors/reconIp.js';
import { runEmailBreachCheck } from './processors/reconEmail.js';
import { detectMitreTechniques } from './processors/mitreAttack.js';
import { extractDocumentMetadata } from './processors/documentMeta.js';
import { runComboIntel } from './processors/comboIntel.js';
import { runSecretScan } from './processors/secretScan.js';
import { runGitExposureCheck } from './processors/gitExposure.js';
import { runDnstwist } from './processors/dnstwist.js';
import { runPortProbe } from './processors/portProbe.js';
import { runNucleiLite } from './processors/nucleiLite.js';
import { runOsicCombo } from './processors/osicCombo.js';
import { runYaraLite } from './processors/yaraLite.js';
import { runCertMonitor } from './processors/certMonitor.js';
import { runTheHarvester } from './processors/theharvester.js';
import { runMetagoofil } from './processors/metagoofil.js';
import { runPassiveTotal } from './processors/passivetotal.js';
// 006 (SpiderFoot-port layer): declarative rule engine, lineage/data-class
// backfill, risk band, data-class, AOI weighting, and forward-geocode backfill.
import { runRuleEngine } from './processors/ruleEngine.js';
import { deriveRiskBand } from './scoring/severity.js';
import { deriveDataClass } from './lib/dataClass.js';
import { getEnabledAoi, type AoiRule } from './store/aoi.js';
import { aoiScore } from './scoring/aoi.js';
import { extractPlace } from './geo/placeExtract.js';
import { geocodePlace } from './geo/forwardGeocode.js';
import { config } from './config.js';
import type { RawEvent, IntelligenceEvent, SourceKind } from './types.js';
import { randomUUID } from 'crypto';

let pollTask: cron.ScheduledTask | null = null;
let cleanupTask: cron.ScheduledTask | null = null;
let digestTask: cron.ScheduledTask | null = null;
let clusterTask: cron.ScheduledTask | null = null;
let convergenceTask: cron.ScheduledTask | null = null;
let freshnessTask: cron.ScheduledTask | null = null;
let ruleTask: cron.ScheduledTask | null = null;
let lineageTask: cron.ScheduledTask | null = null;
let geocodeTask: cron.ScheduledTask | null = null;

// Re-entrancy guard: node-cron does NOT skip a tick if the prior run is still
// going. CV sidecar round-trips can push a cycle past 60s, so without this two
// poll loops would stack and double-poll sources / starve CPU.
let pollInFlight = false;

export function startScheduler(): void {
  if (pollTask) return;

  // Poll every minute
  pollTask = cron.schedule('* * * * *', async () => {
    if (pollInFlight) {
      console.warn('[scheduler] Poll cycle overlap; skipping this tick');
      return;
    }
    pollInFlight = true;
    try {
      await runPollCycle();
    } finally {
      pollInFlight = false;
    }
  });

  // Cleanup old events daily at 3 AM
  cleanupTask = cron.schedule('0 3 * * *', async () => {
    await runCleanup();
  });

  // Digest delivery every hour
  digestTask = cron.schedule('0 * * * *', async () => {
    await runDigestCycle();
  });

  // NLP clustering every 15 minutes
  clusterTask = cron.schedule('*/15 * * * *', async () => {
    await runClustering();
  });

  // Cross-stream convergence every 5 minutes (reads tags.cluster_id from nlpCluster).
  convergenceTask = cron.schedule('*/5 * * * *', async () => {
    try {
      await runConvergence();
    } catch (err) {
      console.error('[scheduler] Convergence failed:', err instanceof Error ? err.message : String(err));
    }
  });

  // Freshness / silent-source sweep every 10 minutes (feeds polling OK but emitting
  // nothing = soft-blocked/dead) + per-source volume anomalies.
  freshnessTask = cron.schedule('*/10 * * * *', async () => {
    try {
      await runFreshnessSweep();
    } catch (err) {
      console.error('[scheduler] Freshness sweep failed:', err instanceof Error ? err.message : String(err));
    }
  });

  // 006: declarative rule engine every 5 min, staggered 2 min after convergence so
  // the two 4k-event scans don't hit the same tick.
  ruleTask = cron.schedule('2-59/5 * * * *', async () => {
    try {
      const r = await runRuleEngine();
      if (r.fired) console.log(`[scheduler] Rule engine: ${r.fired} signal(s) from ${r.scanned} events`);
    } catch (err) {
      console.error('[scheduler] Rule engine failed:', err instanceof Error ? err.message : String(err));
    }
  });

  // 006: lineage + data-class backfill every 15 min (promotes tags.parent_event_id
  // into the event_lineage edge table and fills data_class). Off the hot path.
  lineageTask = cron.schedule('7-59/15 * * * *', async () => {
    try {
      const r = await runLineageSweep(Date.now() - 24 * 60 * 60 * 1000);
      if (r.edges || r.classified) console.log(`[scheduler] Lineage sweep: ${r.edges} edges, ${r.classified} classified`);
    } catch (err) {
      console.error('[scheduler] Lineage sweep failed:', err instanceof Error ? err.message : String(err));
    }
  });

  // 006: forward-geocode backfill every 10 min (resolve place names -> coarse coords
  // for location-less text/alert events so they can join geo-convergence). The
  // geocoder self-rate-limits to <=1 req/s; this runs off the hot path, bounded.
  geocodeTask = cron.schedule('3-59/10 * * * *', async () => {
    await runGeoBackfill();
  });

  // Promote any already-stamped provenance on startup (bounded 7d lookback).
  void runLineageSweep(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .then((r) => { if (r.edges || r.classified) console.log(`[scheduler] Startup lineage sweep: ${r.edges} edges, ${r.classified} classified`); })
    .catch(() => {});

  console.log('[scheduler] Started (poll: 1min, cleanup: 3am, digest: hourly, cluster: 15min, convergence: 5min, freshness: 10min, rules: 5min, lineage: 15min, geocode: 10min)');
}

export function stopScheduler(): void {
  pollTask?.stop();
  cleanupTask?.stop();
  digestTask?.stop();
  clusterTask?.stop();
  convergenceTask?.stop();
  freshnessTask?.stop();
  ruleTask?.stop();
  lineageTask?.stop();
  geocodeTask?.stop();
  pollTask = null;
  cleanupTask = null;
  digestTask = null;
  clusterTask = null;
  convergenceTask = null;
  freshnessTask = null;
  ruleTask = null;
  lineageTask = null;
  geocodeTask = null;
  console.log('[scheduler] Stopped');
}

// Poll sources with bounded concurrency so one slow source (e.g. a clip-mode
// camera whose sidecar call runs to the timeout) can't serially starve every
// source after it, and a per-source wall-clock cap so a hung poll can't consume
// the whole cron tick.
const POLL_CONCURRENCY = 4;
const PER_SOURCE_TIMEOUT_MS = 45000;

async function runPollCycle(): Promise<void> {
  const sources = await listSources(true);
  const now = Date.now();
  const due = sources.filter(
    (s) =>
      now - (s.lastPolledAt ?? 0) >= s.pollIntervalSeconds * 1000 &&
      // Circuit breaker: skip a source that is cooling down after repeated failures.
      !isInCooldown({ cooldownUntil: s.cooldownUntil }, now),
  );

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < due.length) {
      const source = due[cursor++];
      await pollSource(source);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, due.length) }, worker));
}

async function pollSource(source: Awaited<ReturnType<typeof listSources>>[number]): Promise<void> {
  const adapter = getAdapter(source.kind);
  if (!adapter) {
    console.warn(`[scheduler] No adapter for kind: ${source.kind}`);
    return;
  }
  const last = source.lastPolledAt ?? 0;
  const startedAt = Date.now();

  try {
    // Augment the raw config blob with source identity/metadata. The DB stores
    // only `config` (JSONB); adapters (e.g. CV region gating, per-source zones)
    // need sourceId/kind/name which are not otherwise threaded in.
    const pollPromise = adapter.poll(
      { ...source.config, sourceId: source.id, kind: source.kind, name: source.name },
      String(last),
    );
    const rawEvents = await withTimeout(pollPromise, PER_SOURCE_TIMEOUT_MS, `poll ${source.id}`);
    // Success resets the breaker (failures + cooldown) and records latency.
    await recordPollSuccess(source.id, Date.now() - startedAt);

    for (const raw of rawEvents) {
      await ingestRawEvent(source.id, raw, source.kind);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Poll failed for ${source.id}:`, msg);
    // Open the breaker once consecutive failures cross the threshold.
    const failures = (source.consecutiveFailures ?? 0) + 1;
    const cooldownUntil = nextCooldownUntil(failures, Date.now());
    await recordPollFailure(source.id, msg, cooldownUntil);
    if (cooldownUntil) {
      console.warn(`[scheduler] ${source.id} breaker open until ${new Date(cooldownUntil).toISOString()} (${failures} fails)`);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function ingestRawEvent(sourceId: string, raw: RawEvent, sourceKind?: SourceKind): Promise<void> {
  // Deduplication (CV events supply a time-bucketed dedupeContent so identical
  // consecutive readings still yield one observation per poll window).
  // Dedupe key. When an adapter supplies a STABLE upstream id (dedupeContent, e.g.
  // `nws:<id>` / `usgs:<id>` — globally unique at the upstream), hash it WITHOUT the
  // sourceId so the same upstream record collapses across overlapping feeds (e.g. an
  // NWS alert that appears in both the tornado and severe+ feeds). Without a stable
  // id, fall back to per-source content hashing — keeping byte-identical content from
  // different sources as distinct events preserves cross-source corroboration.
  const dedupeHash = raw.dedupeContent
    ? makeDedupeHash('', raw.dedupeContent)
    : makeDedupeHash(sourceId, raw.content);
  if (await dedupeExists(dedupeHash)) {
    return;
  }
  // Close the dedupeExists()→createEvent() race: the two are separated by the long
  // enrichment pipeline below, so concurrent same-hash items in one poll would all
  // pass the check above and all insert. Reserve the hash synchronously here.
  if (!reserveDedupe(dedupeHash)) {
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

  // MITRE ATT&CK technique detection
  try {
    const mitreTags = await detectMitreTechniques(result.title, result.content);
    if (Object.keys(mitreTags).length > 0) {
      result.tags = { ...result.tags, ...mitreTags };
    }
  } catch (err) {
    console.error(`[scheduler] MITRE detection failed:`, err instanceof Error ? err.message : String(err));
  }

  // Rate limit guard (checked BEFORE embedding so rejected events don't pay the
  // embedding cost). Alerts are EXEMPT — they're already throttled by their
  // time-bucketed dedupe, and dropping the high-value alert because routine
  // detections filled the budget would defeat the whole P2 layer.
  if (raw.kind !== 'alert') {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentCount = await queryRecentEventCount(sourceId, hourAgo);
    if (recentCount >= config.MAX_EVENTS_PER_SOURCE_PER_HOUR) {
      console.warn(`[scheduler] Rate limit hit for source ${sourceId}`);
      return;
    }
  }

  // Embedding
  const embeddingVector = await embedText(`${result.title ?? ''} ${result.content}`);

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
    location: raw.location,
    eventAt: raw.eventAt,
    createdAt: Date.now(),
    dedupeHash,
  };

  // Composite importance score (005). Corroboration is unknown at ingest (cluster
  // membership is computed later); the convergence/cluster passes refine it. Source
  // trust comes from the kind's tier.
  const { score, components } = computeScore({
    event: { kind: event.kind, confidence: event.confidence, tags: event.tags, eventAt: event.eventAt },
    sourceTrust: sourceKind ? trustForKind(sourceKind) : undefined,
  });
  event.score = score;
  event.scoreComponents = components;

  // Offline geo enrichment: turn the stored lat/lon into filterable/correlatable
  // tags (ISO2 country + coarse strategic region). Pure, dep-free, no network.
  if (event.location) {
    const geoTags = tagLocation({ location: event.location });
    if (Object.keys(geoTags).length > 0) {
      event.tags = { ...event.tags, ...geoTags };
    }
  }

  // EXIF geolocation enrichment for visual events with media.
  // Skip CV events: their mediaUrls point at the LIVE camera stream, and fetching
  // it to scrape EXIF GPS would derive location FROM imagery — exactly what the
  // privacy posture forbids. CV location comes from source config, never pixels.
  const isCvEvent = !!event.tags && Object.prototype.hasOwnProperty.call(event.tags, 'cv');
  if (event.kind === 'visual' && event.mediaUrls && event.mediaUrls.length > 0 && !event.location && !isCvEvent) {
    try {
      const exifLoc = await enrichEventWithExifLocation(event.mediaUrls);
      if (exifLoc) {
        event.location = exifLoc;
      }
    } catch {
      // ignore EXIF errors
    }
  }

  // 006: Area-of-Interest weighting — nudge in-AOI events up and tag them. Pure
  // predicate over cached rules; best-effort (never blocks the insert).
  try {
    const aoiRules = await getAoiRulesCached(Date.now());
    if (aoiRules.length) {
      const a = aoiScore(
        { tags: event.tags, location: event.location, title: event.title, content: event.content },
        aoiRules,
      );
      if (a.matched) {
        const prior = event.score ?? 0;
        const AOI_WEIGHT = 0.2; // gentle upward nudge toward 1, proportional to AOI strength
        event.score = Math.max(0, Math.min(1, prior + AOI_WEIGHT * a.score * (1 - prior)));
        event.scoreComponents = {
          ...(event.scoreComponents ?? { severity: 0, threat: 0, corroboration: 0, sourceTrust: 0, freshness: 0, base: 0 }),
          aoi: a.score,
        };
        event.tags = { ...event.tags, aoi: true, aoi_rules: a.matchedRuleIds };
      }
    }
  } catch (err) {
    console.error('[scheduler] AOI scoring failed:', err instanceof Error ? err.message : String(err));
  }

  // 006: discrete risk band (from the FINAL score, after any AOI nudge) + finding-class label.
  event.riskBand = deriveRiskBand(event.score);
  event.dataClass = deriveDataClass(event);

  try {
    await createEvent(event);
  } catch (err) {
    // A concurrent insert won the race and the dedupe-hash unique index (migration
    // 007) rejected this duplicate — drop it silently rather than surface an error
    // and never emit it onto the live bus or run downstream enrichment for a dup.
    if (isUniqueViolation(err)) return;
    throw err;
  }
  await updateSource(sourceId, { lastEventAt: Date.now() });

  // Live spine: notify in-process consumers (SSE clients, dashboard, correlation).
  // Single-process EventEmitter — the CPU-only, no-Redis equivalent of pub/sub.
  bus.emitEvent(event);

  // Persist CV detail. Any event carrying alertFirings -> cv_alerts (the redacted
  // artifact is only attached to the push alert event). Routine detection events
  // -> cv_track_events / cv_zone_counts. A record-only firing rides the routine
  // event, so it persists to BOTH.
  if (event.tags && Object.prototype.hasOwnProperty.call(event.tags, 'cv')) {
    try {
      if (event.tags.alertFirings) {
        await persistCvAlerts(event, event.kind === 'alert' ? raw.artifactBase64 : undefined);
      }
      if (event.kind !== 'alert') {
        await persistCvDetail(event);
      }
    } catch (err) {
      console.error(`[scheduler] CV detail persist failed for ${event.id}:`, err instanceof Error ? err.message : String(err));
    }
    // Semantic-search embedding — separate path with its own error handling so a
    // missing pgvector table can never break alert/detail persistence above.
    if (event.kind === 'alert' && raw.embeddingVector) {
      try {
        await insertCvEmbedding(event, raw.embeddingVector);
      } catch (err) {
        console.error(`[scheduler] CV embedding persist failed for ${event.id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Extract and link entities
  try {
    await extractAndLinkEntities(event);
  } catch (err) {
    console.error(`[scheduler] Entity extraction failed for ${event.id}:`, err instanceof Error ? err.message : String(err));
  }

  // Document metadata extraction
  try {
    await extractDocumentMetadata(event);
  } catch (err) {
    console.error(`[scheduler] Document metadata extraction failed for ${event.id}:`, err instanceof Error ? err.message : String(err));
  }

  // Reconnaissance processors (fire-and-forget to avoid blocking)
  Promise.resolve().then(async () => {
    try { await runDomainRecon(event); } catch (err) { console.error(`[scheduler] Domain recon failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runIpEnrichment(event); } catch (err) { console.error(`[scheduler] IP enrichment failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runEmailBreachCheck(event); } catch (err) { console.error(`[scheduler] Email breach check failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runComboIntel(event); } catch (err) { console.error(`[scheduler] Combo intel failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runSecretScan(event); } catch (err) { console.error(`[scheduler] Secret scan failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runGitExposureCheck(event); } catch (err) { console.error(`[scheduler] Git exposure check failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runDnstwist(event); } catch (err) { console.error(`[scheduler] Dnstwist failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runPortProbe(event); } catch (err) { console.error(`[scheduler] Port probe failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runNucleiLite(event); } catch (err) { console.error(`[scheduler] Nuclei lite failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runOsicCombo(event); } catch (err) { console.error(`[scheduler] OSIC combo failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runYaraLite(event); } catch (err) { console.error(`[scheduler] YARA lite failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runCertMonitor(event); } catch (err) { console.error(`[scheduler] Cert monitor failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runTheHarvester(event); } catch (err) { console.error(`[scheduler] TheHarvester failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runMetagoofil(event); } catch (err) { console.error(`[scheduler] Metagoofil failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
    try { await runPassiveTotal(event); } catch (err) { console.error(`[scheduler] PassiveTotal failed for ${event.id}:`, err instanceof Error ? err.message : String(err)); }
  });

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

  // 006: purge orphaned lineage edges past retention + expired signal mutes.
  await exec(`DELETE FROM event_lineage WHERE created_at < $1`, [before]);
  await exec(`DELETE FROM signal_mutes WHERE muted_until IS NOT NULL AND muted_until < $1`, [Date.now()]);

  // Purge any REDACTED CV best-frames at the same 7-day window (keeps the
  // anonymity argument real: imagery gone, aggregate rows survive to 30d and
  // then cascade-delete with their parent event).
  try {
    const { purgeCvRawOlderThan } = await import('./store/cv.js');
    const purged = await purgeCvRawOlderThan(rawBefore);
    if (purged > 0) console.log(`[scheduler] Purged ${purged} CV best-frames`);
  } catch (err) {
    console.error('[scheduler] CV best-frame purge failed:', err instanceof Error ? err.message : String(err));
  }
}

async function runDigestCycle(): Promise<void> {
  // Grounded brief synthesis: build a last-hour window of the top-scored events,
  // synthesize a fabrication-checked brief, and persist it. Retrieved via the
  // /brief/:userId route + the MCP `intelligence_brief` tool (pull delivery).
  try {
    const brief = await synthDigestCycle();
    if (brief) {
      console.log(`[scheduler] Digest brief ${brief.id} synthesized from ${brief.eventCount} events`);
    }
  } catch (err) {
    console.error('[scheduler] Digest cycle failed:', err instanceof Error ? err.message : String(err));
  }
}

async function runClustering(): Promise<void> {
  try {
    await clusterRecentEvents(24, 0.55);
  } catch (err) {
    console.error('[scheduler] Clustering failed:', err instanceof Error ? err.message : String(err));
  }
}

async function queryRecentEventCount(sourceId: string, since: number): Promise<number> {
  const { one } = await import('./db.js');
  const row = await one<{ count: string }>(
    `SELECT COUNT(*) as count FROM intelligence_events WHERE source_id = $1 AND created_at >= $2`,
    [sourceId, since],
  );
  return Number(row?.count ?? 0);
}

// 006: AOI rules are consulted on every ingest, so cache them briefly rather than
// hitting the DB per event. Best-effort — on error reuse the last good set (or empty).
let aoiCache: { rules: AoiRule[]; at: number } | null = null;
const AOI_CACHE_TTL_MS = 60_000;
async function getAoiRulesCached(now: number): Promise<AoiRule[]> {
  if (aoiCache && now - aoiCache.at < AOI_CACHE_TTL_MS) return aoiCache.rules;
  try {
    const rules = await getEnabledAoi();
    aoiCache = { rules, at: now };
    return rules;
  } catch {
    return aoiCache?.rules ?? [];
  }
}

// 006: resolve coarse coordinates for location-less text/alert events from an
// extracted place name so they can join geo-convergence. Off the hot path; the
// geocoder enforces Nominatim's <=1 req/s, so this is bounded per run.
async function runGeoBackfill(): Promise<void> {
  try {
    const { query, exec } = await import('./db.js');
    const since = Date.now() - 6 * 60 * 60 * 1000;
    const rows = await query<{ id: string; title: string | null; content: string; tags: unknown }>(
      `SELECT id, title, content, tags FROM intelligence_events
        WHERE location_lat IS NULL AND event_at >= $1
          AND kind IN ('text','social_post','alert','anomaly')
        ORDER BY event_at DESC LIMIT 25`,
      [since],
    );
    let geocoded = 0;
    for (const r of rows) {
      const place = extractPlace(r.title ?? undefined, r.content);
      if (!place || place.confidence < 0.6) continue;
      const coords = await geocodePlace(place.name);
      if (!coords) continue;
      const geoTags = tagLocation({ location: coords });
      const tags =
        r.tags == null ? {} : typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags as Record<string, unknown>);
      const merged = { ...tags, ...geoTags, geocoded_place: place.name, geocoded: true };
      await exec(
        `UPDATE intelligence_events SET location_lat = $1, location_lon = $2, tags = $3 WHERE id = $4 AND location_lat IS NULL`,
        [coords.lat, coords.lon, JSON.stringify(merged), r.id],
      );
      geocoded++;
    }
    if (geocoded) console.log(`[scheduler] Geo-backfill resolved ${geocoded} event location(s)`);
  } catch (err) {
    console.error('[scheduler] Geo backfill failed:', err instanceof Error ? err.message : String(err));
  }
}
