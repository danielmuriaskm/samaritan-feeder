# The Intelligence "Brain" Layer

This document is the architecture reference for the MIT "brain" layer added in
migration `005` (`migrations/005_intelligence_layer.sql`). It is the set of
processors, stores, transports, and tools that turn a stream of raw polled events
into **ranked, correlated, grounded intelligence** — "most important first"
instead of "newest first", with cross-stream correlation, source-liveness
detection, grounded digests, and multi-channel delivery.

## Licensing boundary (read first)

Everything in this layer is **clean-room MIT**. The *ideas* — composite scoring,
cross-stream convergence, freshness/silent-source detection, source tiering,
grounded anti-hallucination synthesis, multi-channel fan-out, offline geo binning
— were inspired by [worldmonitor](https://github.com/) (AGPL-3.0) as a
conceptual source only. **No worldmonitor code, schema, prompt string, threshold,
or curated data table was copied.** Methods are not copyrightable; every weight,
regex, stopword list, tier number, taxonomy, and prompt below is this project's
own editorial choice. The feeder stays MIT. This boundary is restated in the
header of every module in the layer (see `migrations/005_intelligence_layer.sql`
lines 4-8, `src/scoring/score.ts`, `src/processors/convergence.ts`,
`src/processors/freshness.ts`, `src/processors/briefSynth.ts`,
`src/llm/sanitize.ts`, `src/geo/countryResolver.ts`).

A design discipline runs through the whole layer: the **decision math is pure**
(no DB, no clock-of-record, no network — injectable `now`) so it is deterministic
and unit-testable, and a thin **async orchestrator** wires the pure core to the
stores and the bus. Look for the "PURE" / "Orchestrator" split in each processor.

## Data flow

```
 scheduler.ts (poll 1/min, bounded concurrency 4, 45s per-source cap)
   │  adapter.poll()  ── circuit breaker gate (net/circuitBreaker.ts)
   ▼
 ingestRawEvent()
   ├─ dedupe → content/language filter → text/CV processing → MITRE tag
   ├─ embed (pgvector)
   ├─ computeScore()  ──────────────── scoring/score.ts  (composite 0..1)
   ├─ tagLocation()   ──────────────── geo/countryResolver.ts (country/region tags)
   ├─ createEvent()   → intelligence_events (score, score_components)
   ├─ bus.emitEvent() ──────────────── bus.ts (in-process spine, no Redis)
   │                                       │
   │                                       ├─> /stream/:userId (SSE)
   │                                       └─> any in-process consumer
   └─ routeEventToSubscribers() → delivery/router.ts → delivery/channels/*

 cron sidebands (all read the corpus, write intelligence_signals / _briefs):
   */15  nlpCluster        → stamps tags.cluster_id
   */5   runConvergence()  → convergence/geo_convergence signals  (processors/convergence.ts)
   */10  runFreshnessSweep → silent_source/volume_anomaly + health (processors/freshness.ts)
   0 *   runDigestCycle    → grounded brief                       (processors/briefSynth.ts)
   0 3   runCleanup        → retention purge

 read surfaces:
   HTTP   /events?rank=score · /signals · /brief/:userId · /channels · /stream/:userId
   MCP    top_intelligence · query_signals · get_source_health · ask_corpus  (src/mcp/tools.ts)
```

---

## 1. Composite scoring

`src/scoring/score.ts` — `computeScore(input): { score, components }`.

The feeder historically carried a single `confidence` (the LLM's urgency, clamped
0..1) and every read path ordered by `event_at DESC`. The composite score blends
**five orthogonal dimensions** the feeder already produced but never combined,
into one 0..1 importance number persisted on `intelligence_events.score` (with the
per-component breakdown in `score_components` JSONB; migration lines 14-17).

### The formula

```
composite = 0.30·severity + 0.25·threat + 0.18·corroboration
          + 0.15·sourceTrust + 0.12·freshness

score = clamp01( 0.85·composite + 0.15·base )
```

`base` is the raw LLM `confidence` (clamped, default 0.5). Blending in 15% of it
gives events whose enrichment dimensions are all empty a sensible non-zero prior.

### Weights (editorial, sum to 1.0)

| Dimension | Weight | Meaning |
|---|---|---|
| `severity` | 0.30 | event-kind severity (+ fired alert override) |
| `threat` | 0.25 | threat-intel enrichment tags (VT / Shodan / MITRE / breach) |
| `corroboration` | 0.18 | independent corroborating sources, log2-scaled |
| `sourceTrust` | 0.15 | source-tier trust (0..1) |
| `freshness` | 0.12 | exponential decay, gentle tie-breaker |

Severity and threat dominate; freshness is deliberately small so a slightly older
high-severity item still outranks fresh noise.

### Component functions

- **severity** (`severityScore`): `alert`→1.0, `anomaly`→0.7, `trend`→0.5,
  `detection`→0.4, else (`visual`/`text`/`social_post`)→0.3. A fired push-worthy
  CV/rule alert (`tags.alertFirings` with a non-`detection` severity) pins
  severity to ≥0.9 regardless of kind.
- **threat** (`threatScore`): `max` over: `vt_malicious/5` (5+ engines → maxed),
  Shodan vulns (`0.5 + 0.1·count`), MITRE technique presence → 0.6, combo-intel →
  0.5, breach flag → 0.55.
- **corroboration** (`corroborationScore`): `log2(n)/3` — 1 source → 0, 2 → ~0.33,
  4 → ~0.66, 8+ → ~1. At ingest, corroboration is unknown (cluster membership is
  computed later), so the convergence/cluster passes refine importance over time.
- **sourceTrust**: from `scoring/sourceTrust.ts` (below), default 0.5 (neutral).
- **freshness**: `2^(-age / halflife)` with a **6-hour half-life**
  (`FRESHNESS_HALFLIFE_MS`).

### Source trust tiers

`src/scoring/sourceTrust.ts` + `src/config/sourceTiers.ts`. Each `SourceKind`
maps to a tier (the feeder's **own** editorial classification), and each tier to a
0..1 trust weight:

| Tier | Trust | Meaning | Example kinds |
|---|---|---|---|
| 1 | 0.9 | authoritative / direct instrument | `usgs` `eonet` `gdacs` `nws` `reliefweb` `ngamsi` `stix` `shodan` `censys` `crtsh` `virustotal` `hibp` `greynoise` `urlscan` `abusech` |
| 2 | 0.7 | established editorial / direct observation | `rss` `news_api` `gdelt` `hn` `arxiv` `github` `youtube`, cameras (`webcam` `traffic_cam` `weather_cam` `ip_camera`), `windy` |
| 3 | 0.5 | social (first-party, unverified, noisy) | `twitter` `reddit` `bluesky` `instagram` `tiktok` `telegram` `discord` |
| 4 | 0.3 | scraped / anonymous / unattributed | `twitter_scrape` `reddit_scrape` `sherlock` `pastebin` `gist` `darksearch` `webcrawl` |

`trustForSource()` precedence: explicit per-source `config.trust` (0..1) →
explicit `config.trustTier` (1..4) → the kind's default tier. Unknown kinds
default to tier 3.

The persisted score powers `listTopEvents()` (the `idx_intel_events_score` index,
`score DESC NULLS LAST, event_at DESC`), the `/events?rank=score` read path, the
SSE `minScore` filter, the `top_intelligence` MCP tool, and the digest cutoff.

---

## 2. The event bus / live SSE spine (no Redis)

`src/bus.ts` — a single module-level `FeederBus extends EventEmitter`.

This is the CPU-only, **no-Redis** equivalent of the pub/sub channel the old SSE
stub assumed ("In production, this would subscribe to a Redis pub/sub channel").
In a single Node process a plain `EventEmitter` is sufficient and correct; if the
feeder is ever sharded, this is the **one seam** to swap for a real broker.

- `emitEvent(event)` / `onEvent(handler)` — a new persisted `IntelligenceEvent`.
- `emitSignal(signal)` / `onSignal(handler)` — a correlation/freshness `IntelSignal`.
- `on*` handlers return an unsubscribe function (SSE cleanup uses it).
- `setMaxListeners(0)` — many SSE clients attach, so the 10-listener warning cap
  is lifted.

**Producers:** `scheduler.ingestRawEvent` emits every persisted event
(`bus.emitEvent`, scheduler.ts ~line 321); the convergence and freshness
processors emit every new signal (`bus.emitSignal`).

**Consumer:** `src/routes/stream.ts` (`GET /stream/:userId`) relays bus events and
signals to a connected client as SSE frames. It applies optional `?minScore`,
`?kinds`, `?sourceId` filters, sends `connected` on open, `event` /`signal` frames
as they fire, and a `heartbeat` every 30s; cleanup runs on stream cancel. Events
are trimmed (`compactEvent`) to drop raw embeddings/rawData before the wire.

---

## 3. Per-source circuit breaker

`src/net/circuitBreaker.ts` — pure backoff math, no state of its own (the state
lives on `intelligence_sources`).

The scheduler polls every source on the 1-minute tick. A source that 500s,
rate-limits (429), or soft-blocks a scraper would otherwise be retried every
minute forever, burning CPU and the upstream's goodwill. After
`failureThreshold` **consecutive** failures the breaker opens and imposes an
exponentially growing, capped cooldown; the first success resets it.

| Param | Default | Meaning |
|---|---|---|
| `failureThreshold` | 3 | consecutive failures before the breaker opens |
| `baseMs` | 5 min | cooldown for the first opened step |
| `maxMs` | 6 h | cooldown ceiling |

- `nextCooldownUntil(consecutiveFailures, now, cfg?)` → `now + min(maxMs, baseMs·2^step)`
  where `step = consecutiveFailures - failureThreshold`; returns `undefined` while
  still below the threshold (keep polling).
- `isInCooldown({ cooldownUntil }, now)` → true while cooling down.

**Wiring (scheduler.ts):** `runPollCycle` filters out sources where
`isInCooldown` is true. On a failed poll, `pollSource` increments
`consecutiveFailures`, computes `nextCooldownUntil`, and persists both via
`recordPollFailure`. On success, `recordPollSuccess` resets failures + cooldown
and records latency. Breaker state columns (`consecutive_failures`,
`cooldown_until`, `last_latency_ms`, `health_state`) are added in migration lines
44-47. Independently of the breaker, each poll has a 45s wall-clock cap
(`PER_SOURCE_TIMEOUT_MS`) and runs at concurrency 4 (`POLL_CONCURRENCY`).

---

## 4. Cross-stream + geo convergence signals

`src/processors/convergence.ts` — `runConvergence()` plus three pure detectors.
Cron: **every 5 minutes**.

Turns N independent polls of the *same* underlying event into ONE scored
correlation signal. `nlpCluster` (the `*/15` job) already stamps co-referent
events with a shared `tags.cluster_id`; this processor reads it. The intelligence
is the **independence** of the corroborating streams, not the raw count.

### (a) Source-type convergence → `kind: 'convergence'`

`detectSourceTypeConvergence()`. Groups events by `tags.cluster_id`; a cluster
fires when it spans **≥ `MIN_FAMILIES` (3) distinct source families** within the
window. Independence is by **source family**, not source/kind — three Reddit polls
are not three sources, but a Reddit post + an RSS wire item + a USGS feed are.

The taxonomy (`kindToFamily`) collapses `SourceKind` into:
`wire_news` · `social` · `osint_cyber` · `camera_cv` · `hazard_gov` · `other`.

### (b) Geo convergence → `kind: 'geo_convergence'`

`detectGeoConvergence()`. Bins events into ~**1-degree cells** (`GEO_CELL_DEG`,
≈111 km/deg latitude); a cell fires when **≥ `MIN_GEO_KINDS` (3) distinct event
kinds** co-occur within the window (e.g. a `visual` camera hit + a `text` wire
item + an `alert` hazard feed in one place). `geoCell()` produces a stable
`latBin:lonBin` key and the cell center.

### (c) Velocity spike → `kind: 'velocity_spike'`

`detectVelocitySpike()` (pure; baseline supplied by the caller). Fires when a
cluster's current-window count is ≥ `VELOCITY_MULTIPLE` (3×) its rolling baseline,
gated by `minCurrent` (default = the multiple) so a 1→4 blip on a near-silent
cluster doesn't fire. Score maps ratio above threshold onto 0.5..1 (3×→0.5,
≥9×→1). *(The pure detector ships; the orchestrator emits source-type and geo
convergence by default.)*

### Convergence score

`scoreConvergence(diversityCount, memberCount)` = `0.7·diversity + 0.3·volume`,
where `diversity = min(1, count/5)` (5 families/kinds saturates) and
`volume = min(1, log2(members)/5)` (32 members saturates). Diversity is weighted
~2× volume, so a 3-family/3-member cluster outranks a 2-family/30-member one. Geo
convergence reuses the same function with kind-count as the diversity axis.

### Orchestration

`runConvergence()` loads up to `RECENT_EVENT_LIMIT` (4000) recent events over a
24h window (`loadRecentConvergenceEvents`, a raw join onto `intelligence_sources`
to recover the source kind), runs both detectors, and for each **new** firing —
deduped on a composed key (`conv:cluster:<id>:fam:<families>` /
`geoconv:cell:<key>:kinds:<kinds>`) within `dedupeWindowMs` via
`signalDedupeExists` — inserts a signal (`insertSignal`) and emits it on the bus.
Default posture is **signals-only**: no `kind:'alert'` events are written, keeping
the delivery surface opt-in.

---

## 5. Freshness / silent-source + volume anomaly

`src/processors/freshness.ts` — `runFreshnessSweep()` plus pure classifiers.
Cron: **every 10 minutes**.

The "is this feed actually alive?" layer. A source returning HTTP 200 with **zero
new items** for a long stretch is *silently dead* (scraper soft-blocked, feed
deprecated, login wall) — the insidious case the feeder used to miss because polls
"succeed". A sudden drop/burst in per-hour volume is itself a signal.

### Silent-source classification → `kind: 'silent_source'`

`classifySilence(src, now)` returns a `SourceHealthState` and a `silent` flag,
with this precedence:

1. **cooldown** — breaker open (`cooldownUntil > now`) → state `cooldown`.
2. **failing/degraded** — `consecutiveFailures > 0` → `failing` (≥3) or `degraded`.
   Erroring is a *different* problem than silent.
3. **healthy (warming up)** — no `lastEventAt` anchor yet → stay `healthy`.
4. **silent** — polls OK but idle longer than the silence budget →
   `silent` + signal.

Silence budget = `max(pollIntervalSeconds·SILENCE_INTERVAL_FACTOR, SILENCE_FLOOR_MS)`
with `SILENCE_INTERVAL_FACTOR = 12` and `SILENCE_FLOOR_MS = 6h`. The floor stops
fast pollers (e.g. 30s) tripping after minutes; the interval factor catches a
soft-block within an hour or two. Signal score scales with idle hours
(`0.5 + idleHours/240`, capped 0.9).

### Volume anomaly → `kind: 'volume_anomaly'`

`detectVolumeAnomaly(currentPerHour, baseline)` z-scores the current per-hour
reading against the source's **online baseline**. Anomalous when `|z| ≥
VOLUME_Z_THRESHOLD` (3) and the baseline has `≥ MIN_BASELINE_SAMPLES` (8) samples
and `std > 0` (avoids screaming on the 2nd poll / dividing by zero). Direction is
`drop` or `surge`; signal score = `0.4 + |z|/10`, capped 0.95.

The baseline is **Welford online mean/variance** stored per source in
`source_volume_baseline` (`src/store/health.ts`: `getBaseline`, `updateBaseline`,
`baselineStd`; migration lines 51-57) — no full time series retained. The sweep
snapshots the prior baseline, folds the new reading in *after* (so the reading is
scored against history, not itself), then classifies.

### Health persistence

`runFreshnessSweep` also keeps `intelligence_sources.health_state` current
(`setHealthState`, only on change) so `/health` and the dashboard stop showing a
dead feed as "healthy". States: `healthy | degraded | silent | failing |
cooldown`. Signals are deduped one-per-source-per-day.

---

## 6. Grounded brief synthesis + anti-hallucination guards

`src/processors/briefSynth.ts` — `runDigestCycle()` / `synthesizeBrief()`.
Cron: **hourly**. Persisted to `intelligence_briefs` (`src/store/briefs.ts`;
migration lines 76-86) and read via `GET /brief/:userId`.

Turns a window of scored events into a compact, **fabrication-checked** digest.
The LLM *proposes* a structured brief; pure guards then **reject** any output that
introduces named entities or numbers absent from the source events; and a
deterministic template **guarantees a brief always ships** even when the LLM is
unavailable or its draft fails the guards.

### Pipeline

1. **`orderAndCap`** (pure): rank by composite score (then recency), dedup by
   `cluster_id` keeping the highest-scored member, cap `MAX_PER_SOURCE` (3) so one
   chatty feed can't dominate, slice to `MAX_EVENTS_IN_PROMPT` (12).
2. **Prompt build**: every event title/content is run through
   `sanitizeForPrompt` (below) before interpolation; the system prompt demands
   STRICT JSON and "use ONLY facts/names/places/numbers verbatim in the sources".
   `EVENT_CONTENT_CHARS = 360` per event. Temperature 0.2, `max_tokens` 700.
3. **Guards** (the valuable clean-room part, all pure & exported for tests):
   - `extractProperNouns` — cheap lexical anchor extractor (capitalized runs +
     ALL-CAPS acronyms; trims common-capitalized connectors). Not an NER.
   - `validateNoHallucinatedProperNouns(llmText, sourceText)` — rejects when the
     output introduces a proper noun absent from the source set
     (`MAX_FABRICATED_NOUNS = 0`). The grounding set is **every proper noun phrase
     plus every source word**, which kills the sentence-start false positive
     ("Emergency" is grounded by source "emergency"); a multi-word output noun is
     grounded if all its component words are.
   - `checkLeadGrounding(lead, sourceTexts)` — the lead must share ≥
     `MIN_LEAD_ANCHOR_OVERLAP` (1) named-entity or numeric anchors with the
     sources, or it is treated as ungrounded prose. Degenerate (no entities/
     numbers anywhere) inputs are accepted.
4. **Fallback**: `deterministicBrief` builds a valid brief purely from the events
   (lead = strongest event's headline + "(+N more)"; threads mirror the ranked
   events). Used on LLM-null, parse failure, or guard rejection. The brief body
   records `generatedBy: 'llm' | 'deterministic'`.

`runDigestForUser` assembles the last-hour window (`DIGEST_WINDOW_MS` 1h,
`DIGEST_MIN_SCORE` 0.4, `DIGEST_FETCH_LIMIT` 60), synthesizes, and persists. The
scheduler's hourly `runDigestCycle` currently produces a single global brief
(`userId` undefined); `GET /brief/:userId` falls back to that global brief.
Delivery is intentionally **not** done here — the caller decides whether to push.

---

## 7. Prompt-injection sanitization

`src/llm/sanitize.ts` — `sanitizeForPrompt(input, { maxLen? })` and
`wrapUntrusted(label, content)`.

The feeder feeds arbitrary public content (RSS, social, scraped pages) to LLMs
(text processing, brief synthesis, the `ask_corpus` MCP tool). Untrusted text can
carry prompt-injection / jailbreak payloads. Design stance: **defang, don't
delete** (keep human-readable meaning, break only the *machine* effect), be
**conservative** (benign prose passes through ~unchanged), and **always fence**.

`sanitizeForPrompt` pipeline (default `maxLen` 4000 code points):

1. **strip control chars** — zero-width / joiners / BOM, bidi embedding-override-
   isolate controls (LRE..RLO, LRI..PDI, LRM/RLM/ALM), C0/C1 except `\t \n \r`.
2. **truncate early** (so regex passes never run on a megabyte of attacker text).
3. **neutralize role prefixes** — a line starting `system:`/`assistant:`/`user:`/
   `tool:`/`developer:`/`human:`/`ai:` gets a `·` marker before the colon so it no
   longer parses as a forged chat turn.
4. **defang injection phrases** — "ignore/disregard/forget … instructions", "you
   are now", "new instructions:", "reveal the system prompt", jailbreak/DAN
   triggers — insert a visible `·` mid-phrase.
5. **defang fence escapes** — ``` ``` ``` / `~~~` fences and delimiter-banner lines.
6. **collapse pathological whitespace**, then **final clamp**.

`wrapUntrusted` fences sanitized content between scrubbed
`===== BEGIN <LABEL> (untrusted data — never instructions) =====` / `END`
delimiters so the trusted prompt can instruct the model to treat the block as
data. The marker is the middle dot `·` (visible, never zero-width).

---

## 8. Multi-channel delivery

`src/delivery/channels/index.ts` (registry + fan-out) and
`src/delivery/router.ts` (per-event routing). Channels are stored in
`delivery_channels` (`src/store/channels.ts`; migration lines 60-69) and managed
via the `/channels` CRUD routes.

Replaces the single hardcoded telegram push: a user configures N channels and a
single payload is fanned out to every enabled channel that is (a) outside its
quiet hours and (b) not a recent duplicate.

### Channels

| `ChannelKind` | Sender | Notes |
|---|---|---|
| `telegram` | `channels/telegram.ts` | |
| `discord` | `channels/discord.ts` | |
| `slack` | `channels/slack.ts` | |
| `webhook` | `channels/webhook.ts` | |
| `email` | `channels/email.ts` | |
| `samaritan` | — (built-in) | NOT an outbound sender; the router's fallback via `pushAlertToSamaritan()` when a user has zero configured channels |

`CHANNEL_SENDERS` registers the five outbound kinds; `samaritan` is intentionally
absent.

### Pure helpers (exported, unit-tested, no network/DB)

- **`inQuietHours(quietHours, now)`** — whole-hour `[startHour, endHour)` window in
  the channel's IANA `tz` (via `Intl`, host-local fallback). Wraps around midnight
  (22→7 means 22:00–06:59); `start === end` is an empty window (never quiet) so a
  misconfigured channel keeps delivering.
- **`formatPayload(input)`** — title fallback + whitespace normalize + caps
  (title 300 chars); every channel starts from this common shape.
- **`payloadHash(payload)`** — SHA-1 over `title + content + url` (deliberately not
  mediaUrls/timestamps) for the dedup window.
- **`planDelivery(channels, payload, opts)`** — per-channel decision:
  `send` | `quiet_hours` | `dedup` | `unsupported`.

### Fan-out

`deliverToChannels(userId, input, opts)` loads the user's enabled channels, plans,
and dispatches; it **never throws** (each channel error is captured into a
`ChannelOutcome`). Dedup is a process-local `recentSends` map with a default
10-minute window (`DEFAULT_DEDUP_WINDOW_MS`), best-effort and pruned past 1000
entries. Returns `{ total, delivered, outcomes }`.

`delivery/router.ts` `routeEventToSubscribers(event)` is the per-event path: for
each matching subscription (`shouldDeliver` checks confidence threshold, kind
filter, keyword filter), `alert`/`proactive` modes call `deliverToChannels`,
falling back to the built-in Samaritan push when the user has no channels;
`passive` just stores. Every delivery is logged to `intelligence_deliveries`
(its channel CHECK constraint is widened in migration lines 71-73).

---

## 9. Offline geo resolver

`src/geo/countryResolver.ts` — `resolveCountry`, `resolveRegion`, `tagLocation`.
Fully **offline, dependency-free, no network**. Backed by a hand-authored
bounding-box table (`src/data/country-bboxes.json`).

Turns the lat/lon the feeder already stores into filterable, correlatable tags:
an **ISO-3166-1 alpha-2 country** code and a coarse **strategic region**. This is
what makes geo-convergence and country/region filtering possible.

- **`resolveCountry(lat, lon)`** — bbox containment over a precomputed
  flattened-by-area list; on overlap the **smallest-area box wins** (a specific
  small country beats a continental rectangle that merely spans the point).
  Returns `undefined` for ocean / unmapped / invalid coordinates.
- **`resolveRegion(lat, lon)`** — resolves the country first and uses its mapped
  region from the authoritative `COUNTRY_REGION` table (unambiguous where region
  boxes overlap, e.g. Iberia vs MENA), then falls back to a geometric
  smallest-region-box scan for sea/unmapped points. Regions:
  `EU · MENA · AFRICA · EAST_ASIA · SOUTH_ASIA · SOUTHEAST_ASIA · CENTRAL_ASIA ·
  NORTH_ASIA · NORTH_AMERICA · LATAM · OCEANIA`.
- **`tagLocation({ location })`** → `{ country?, region? }`, spread into
  `event.tags` at ingest (scheduler.ts ~line 293). Returns `{}` for events with no
  usable location so callers can spread unconditionally.

Accuracy is intentionally **coarse** — a prefilter, not a survey-grade geocoder.
A `pointInPolygon` ray-cast is exported for future refinement without a geo dep.

---

## 10. New authoritative adapters

Eight new clean-room adapters for **free, keyless, authoritative** hazard /
conflict / cyber feeds. Each ships a **pure parser** (exported, unit-testable with
a fixture, no network) plus a thin `BaseAdapter` shell, and dedupes on a stable
upstream id so re-polls collapse to one event. The endpoint shapes are **facts**
published by each provider; the parsing, severity heuristics, and strings are
original.

| `SourceKind` | Source | Endpoint | Event kind(s) | File |
|---|---|---|---|---|
| `usgs` | USGS Earthquakes | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson` (default `4.5_day`) | `anomaly` | `src/adapters/usgs.ts` |
| `eonet` | NASA EONET Natural Events | `eonet.gsfc.nasa.gov/api/v3/events` | `anomaly` | `src/adapters/eonet.ts` |
| `gdacs` | GDACS Disaster Alerts | `gdacs.org/gdacsapi/api/events/geteventlist/SEARCH` | `alert` (red/orange) · `anomaly` (green) | `src/adapters/gdacs.ts` |
| `nws` | US NWS Active Alerts | `api.weather.gov/alerts/active` | `alert` (severe/extreme) · `text` | `src/adapters/nws.ts` |
| `abusech` | abuse.ch URLhaus / ThreatFox IOCs | `urlhaus.abuse.ch/downloads/json_recent/` · `threatfox-api.abuse.ch/api/v1/` | `alert` | `src/adapters/abusech.ts` |
| `ngamsi` | NGA MSI Maritime Broadcast Warnings | `msi.nga.mil/api/publications/broadcast-warn` | `anomaly` | `src/adapters/ngamsi.ts` |
| `reliefweb` | ReliefWeb (UN OCHA) disasters/reports | `api.reliefweb.int/v1/{disasters,reports}` | `text` | `src/adapters/reliefweb.ts` |
| `gdelt` | GDELT DOC 2.0 Global News | `api.gdeltproject.org/api/v2/doc/doc` | `text` | `src/adapters/gdelt.ts` |

Per-adapter notes:

- **usgs** — feeds named `{magnitude}_{window}` (`4.5_day`, `significant_week`…);
  `magnitudeConfidence` maps M→confidence (M7+ → 0.98). Carries PAGER alert /
  tsunami / depth tags.
- **eonet** — one event per EONET event at its most recent geometry; ongoing
  events score higher than closed (0.8 vs 0.65); optional category filter.
- **gdacs** — alert level Green/Orange/Red → confidence; red/orange emit
  push-worthy `alert`, green emits `anomaly`. Disaster type codes
  (EQ/TC/FL/VO/DR/WF/TS) expanded to labels.
- **nws** — requires a descriptive User-Agent (NWS 403s generic clients);
  Severe/Extreme → `alert`; cancellations skipped; centroid of the alert polygon
  used as a coarse point. Defaults to `severity=Severe,Extreme`.
- **abusech** — most feeds now need a free `Auth-Key`; a 401/403 **degrades to an
  empty poll**, not a throw. Online malware URLs score higher than dead ones.
- **ngamsi** — NAVWARN free-text positions parsed from deg-min (`12-34.5N
  098-76.5E`) into a coarse point; navigation-critical wording bumps confidence.
- **reliefweb** — requires an `appname` query param; primary-country name +
  location become tags; ongoing/alert and multi-source items rank higher.
- **gdelt** — requires a `query`; guards the JSON parse (GDELT sometimes returns
  HTML 200s); article tone (|tone|, clusters in −10..+10) used as a confidence
  proxy; tagged with publisher domain.

New kinds are admitted by the widened `intelligence_sources_kind_check`
constraint (migration lines 90-100).

---

## HTTP endpoint reference

All served at the root and under `/api/*` (the Vite dev proxy). Wiring in
`src/index.ts`.

| Method · Path | Query / params | Returns | Source |
|---|---|---|---|
| `GET /events?rank=score` | `rank=recency\|score`, `minScore`, `kinds`, `sourceId`, `since`, `until`, `query`, `limit`, `offset` | `{ events }` — `rank=score` orders by composite score desc; `query` switches to vector/keyword search | `src/routes/events.ts` |
| `GET /signals` | `kinds`, `since`, `minScore`, `limit` | `{ signals }` — correlation/freshness signals, score desc | `src/index.ts` (`signalRoutes`) → `store/signals.ts` |
| `GET /brief/:userId` | — | `{ brief }` — latest grounded brief for the user, falling back to the global brief | `src/index.ts` → `store/briefs.ts` |
| `GET /channels?userId=` | `userId` (required), `enabledOnly` | `{ channels }` | `src/index.ts` (`channelRoutes`) |
| `POST /channels` | body `{ userId, kind, config, enabled?, quietHours? }` | created channel (201) | `channelRoutes` |
| `GET /channels/:id` · `PATCH /channels/:id` (`{enabled}`) · `DELETE /channels/:id` | — | channel / `{ ok }` | `channelRoutes` |
| `GET /stream/:userId` | `minScore`, `kinds`, `sourceId` | SSE stream — frames: `connected`, `event`, `signal`, `heartbeat` (30s) | `src/routes/stream.ts` |

The console operates as a single operator and uses the `userId` literal
`'operator'` for SSE/channels; `getBrief('operator')` falls back to the global
brief server-side.

---

## MCP tools reference

`src/mcp/tools.ts` — extra tools over the stdio MCP server, exposing the brain
outputs to an analyst agent. Every list-returning tool runs through
`shapeToolResult` (`src/mcp/shape.ts`) so a busy corpus never floods the agent's
context (field projection + item cap + char budget with an honest truncation
marker).

| Tool | Args | Returns |
|---|---|---|
| `top_intelligence` | `since_hours` (24), `kinds`, `min_score`, `limit` (10) | Most important recent events ranked by composite score (not recency). Triage first. |
| `query_signals` | `since_hours` (24), `kinds`, `min_score`, `limit` (20) | Correlation/freshness signals (`convergence`, `geo_convergence`, `velocity_spike`, `silent_source`, `volume_anomaly`, `cluster_surge`) — the "something is happening" layer. |
| `get_source_health` | `enabled_only` (false) | Per-source health state, last event time, consecutive failures — spot silent/failing feeds. |
| `ask_corpus` | `query` (required), `since_hours` (168), `kinds`, `limit` (8) | Semantic Q&A: embed the question, retrieve nearest events by vector similarity, and (when an LLM is available) compose a grounded `[ref]`-citing answer. Falls back to ranked snippets. The query is run through `sanitizeForPrompt`. |

---

## Scheduler cron cadence

`src/scheduler.ts` (`startScheduler`):

| Cron | Cadence | Job |
|---|---|---|
| `* * * * *` | every minute | `runPollCycle` — poll due sources (concurrency 4, 45s/source cap, circuit-breaker gated, re-entrancy guarded) |
| `*/15 * * * *` | every 15 min | `runClustering` — `clusterRecentEvents(24h, 0.55)`, stamps `tags.cluster_id` |
| `*/5 * * * *` | every 5 min | `runConvergence` — cross-stream + geo convergence signals |
| `*/10 * * * *` | every 10 min | `runFreshnessSweep` — silent-source + volume-anomaly signals + health state |
| `0 * * * *` | hourly | `runDigestCycle` — grounded brief synthesis |
| `0 3 * * *` | daily 03:00 | `runCleanup` — retention purge of old events / raw data / redacted CV frames |

The convergence job runs *after* clustering on the timeline because it consumes
the `cluster_id` tags that clustering writes.
