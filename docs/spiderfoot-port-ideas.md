# SpiderFoot → samaritan-feeder: portable ideas & features

A senior-engineer brief on what's worth lifting from SpiderFoot (Python, MIT v4.0)
into samaritan-feeder (TS/Hono, MIT). Decision-ready, grounded in a multi-agent
cross-analysis of both codebases (SpiderFoot `spiderfoot/`, `correlations/`,
`modules/` vs samaritan-feeder `src/`). Every claim is tied to a real file.

> SpiderFoot was cloned to `C:/Users/Admin/spiderfoot-ref` for reference. It is
> **not** a dependency — this doc records what to build natively.

## TL;DR — the highest-leverage things to build

1. **Declarative YAML correlation-rule engine** — author new correlations as data, not TS edits + redeploy. **Port · effort L · impact HIGH.** (`src/processors/convergence.ts` is the hardcoded thing this generalizes.)
2. **Operator triage state (dismiss / acknowledge / mute) on signals** — turns a read-only firehose into a workable queue and cuts alert fatigue. **Idea · effort M · impact HIGH.** Today *nothing* can be dismissed (`src/store/signals.ts`).
3. **First-class event lineage as a queryable edge table** — promote the already-half-flowing `tags.parent_event_id` to an indexed edge; unlocks provenance-cited briefs and lineage dedupe. **Port · effort M · impact HIGH.**
4. **OpenPhish/PhishTank + keyless passive-DNS (mnemonic/hackertarget)** — close two real source gaps with near-zero-cost keyless adapters/enrichers. **Port · effort S–M · impact MEDIUM–HIGH.**
5. **`/signals/:id` drill-down** returning the member events behind a signal — cheapest "make a signal investigable" win; the `eventIds` are already persisted. **Port · effort S · impact MEDIUM.**

## How the two systems compare

SpiderFoot is a **target-driven, bounded-scan OSINT engine**: you hand it a domain/IP/email and ~200 type-routed plugin modules pivot outward, producing a finished provenance graph that a **declarative YAML rule engine** then analyzes. samaritan-feeder is a **time-driven, perpetual firehose**: ~41 polling adapters feed a fixed processor pipeline with continuous composite scoring, LLM briefs, CV, and multi-channel delivery. The headline contrast is *authoring surface* (SpiderFoot's correlations are data; samaritan's are hardcoded TS) and *provenance* (SpiderFoot has an explicit event lineage tree; samaritan re-derives relatedness by clustering). But samaritan is clearly **ahead** on several axes — it should not regress toward SpiderFoot's model where it already wins.

| Axis | SpiderFoot | samaritan-feeder | Who's ahead |
|---|---|---|---|
| **Data sources** | ~200 target-driven enrichment modules | ~41 time-driven polling adapters + live radar (ADS-B/AIS) | Different shape; SpiderFoot has more *enrichers*, samaritan has *firehoses* + CV |
| **Correlation** | Declarative YAML rules (collect→aggregate→analyze→headline) | Hardcoded TS detectors (`convergence.ts`, `freshness.ts`) | **SpiderFoot** (authoring surface) |
| **Scoring** | 3 flat 0-100 ints, *never populated* (`event.py`) | Composite 0..1 with 6 named components, actually populated (`scoring/score.ts`) | **samaritan** |
| **Scope model** | `Target.matches()` in-scope-vs-affiliate gate (`target.py`) | None (broad firehose) | SpiderFoot (by design; AOI is the port) |
| **Taxonomy** | ~136 closed typed data classes + ENTITY/DESCRIPTOR/DATA tiers (`db.py`) | 7 `EventKind` + free-text tags + 10 `EntityType` | SpiderFoot (queryability); samaritan (flexibility) |
| **Provenance** | Explicit `sourceEvent` lineage tree (`event.py`) | None (degraded `tags.parent_event_id` only) | **SpiderFoot** |
| **Delivery / real-time** | None (batch scan results) | Multi-channel fan-out, SSE, quiet-hours, dedup (`delivery/`) | **samaritan** |
| **LLM briefs / anti-hallucination** | None | Grounded digest + proper-noun guards + sanitizer (`briefSynth.ts`, `llm/sanitize.ts`) | **samaritan** |
| **CV / video** | None | Privacy-preserving CV sidecar + alert rules (`processors/detection.ts`) | **samaritan** |
| **Geo** | None | Offline country/region resolver + geo-convergence (`geo/`, `convergence.ts`) | **samaritan** |
| **UX** | Scan-as-object, 6 views, FP triage, multi-format export, CLI | 14 flat tabs, JSON-only, no triage, no drill-down | **SpiderFoot** (results/triage UX) |

## Recommended ports & features

### Correlation engine

#### Declarative YAML correlation-rule engine over the event stream — *recommend*
**What it is.** A small TS rule engine reading YAML rules (collect → aggregate → analyze → headline) that emits `IntelSignal`s, so an operator can author new correlations as data instead of editing/redeploying TS.
**SpiderFoot origin.** `spiderfoot/correlation.py` — `process_rule` (842-895), `build_db_criteria` (133-216), `refine_collection`/`event_keep` (410-487, incl. `not ` negation + list-OR), `aggregate_events` (534-577), `analysis_threshold` (744-775), `build_correlation_title` (897-927); DSL spec in `correlations/README.md` + `correlations/template.yaml`.
**Maps to.** New `src/processors/ruleEngine.ts` + `src/processors/rules/*.yaml`; reuses the `loadRecentConvergenceEvents` projection in `src/processors/convergence.ts` (379-391); emits via `src/store/signals.ts` `insertSignal`/`signalDedupeExists`; new cron mirroring `src/scheduler.ts` (87-93); add `SignalKind 'rule_match'` to `src/types.ts` (285-291).
**Port · effort L · impact HIGH.**
**Sketch.** Compile the first `collect` method to a parameterized SQL projection over `intelligence_events` ⨝ `intelligence_sources` (exactly the cluster_id+source_kind join `convergence.ts` already runs), then refine subsequent methods in-memory over JSONB tags (regex, `not `, list-OR). Group into `Map<string,Event[]>` by an `aggregate.field` resolver (kind/sourceKind/sourceFamily/`tags.*`/geoCell). Port `check_rule_validity` (985-1075) so bad YAML can't crash the cron, cap lookback (`RECENT_EVENT_LIMIT=4000`), and re-express the two built-in convergences as seed rules to retire duplication. Carry an MIT attribution header like `convergence.ts:16-19`.

#### Outlier / rarity analyzer — surface the rare source, kind, geo cell, or entity — *recommend*
**What it is.** The inverse of convergence: bucket recent events by a field and flag buckets that are ≤ `maximum_percent` of total volume (rare = interesting), with the `noisy_percent` guard that emits nothing on an all-noise dataset.
**SpiderFoot origin.** `spiderfoot/correlation.py` `analysis_outlier` (707-742); `correlations/outlier_webserver.yaml`.
**Maps to.** New pure `detectOutliers()` beside `detectGeoConvergence` in `src/processors/convergence.ts` (255-308), reading the same projection, emitting `SignalKind 'outlier'` via `insertSignal`; runs on the existing `*/5` cron.
**Port · effort S · impact MEDIUM.**
**Sketch.** ~15 lines of arithmetic over bucket sizes: bucket by axis (sourceKind/family, kind, geoCell, `tags.country`), compute total + average share, return `[]` if `avgShare < noisyPercent` or `total < minTotal`, else emit buckets with `share <= maximumPercent`. Add a `MIN_BASELINE_SAMPLES`-style floor (`freshness.ts:67`); no schema change.

#### `first_collection_only` set-difference — "reported ONLY by social, never corroborated by wire/gov" — *recommend*
**What it is.** A two-collection set-difference: keep clusters whose membership lives entirely in collection-0 families (e.g. `{social}`) and is absent from collection-1 families (wire_news + hazard_gov) — a real disinfo/credibility signal, the exact inverse of existing convergence.
**SpiderFoot origin.** `spiderfoot/correlation.py` `analysis_first_collection_only` (676-705); `correlations/host_only_from_bruteforce.yaml`.
**Maps to.** New `detectSingleFamilyOnly()` in `src/processors/convergence.ts` reusing `byCluster` (157-164), `kindToFamily` (112-114), and the in-window filter (170-174); emit a LOW/INFO `uncorroborated` signal; surface as a credibility flag in `/discover` tiles (`src/routes/discover.ts`) and optionally `briefSynth.ts`.
**Port · effort M · impact MEDIUM.**
**Sketch.** Keep clusters whose families subset `only` (default social) and are disjoint from `absentFrom` (default wire+gov), within `windowMs` so a late wire pickup doesn't retroactively suppress. Gate strictly on `nlpCluster` reliably stamping `cluster_id`; keep it a low-score triage flag, not a high alert.

### New data sources

#### OpenPhish + PhishTank phishing firehose adapter — *recommend*
**What it is.** Keyless, continuously-updated firehose of live phishing URLs — the one IOC class `abusech.ts` (URLhaus malware + ThreatFox) does not cover.
**SpiderFoot origin.** `modules/sfp_openphish.py` (`parseBlacklist` 118-149), `modules/sfp_phishtank.py`.
**Maps to.** New `src/adapters/openphish.ts` cloning `src/adapters/abusech.ts`; register beside `AbusechAdapter` in `src/adapters/index.ts` (line 93); add `'openphish'` to `SourceKind` (`src/types.ts:1`).
**Port · effort S · impact MEDIUM.**
**Sketch.** `safeFetch` `feed.txt`/`online-valid.csv`, degrade-to-empty-poll on auth-gated/non-200 (mirror `isAuthFailure`, `abusech.ts:287-290`), parse host via `url.split('/')[2]`, emit `kind:'alert'` tagged `{ioc_type:'url', threat:'phishing', feed}`. **Correction vs. naive plan:** these feeds carry no per-item timestamp, so dedupe on `dedupeContent` hash (`'openphish:'+url`) against the existing dedupe-hash unique index — *not* a timestamp cursor like abusech uses.

#### Zone-H near-real-time defacement firehose — *maybe*
**What it is.** A pollable RSS stream of freshly-reported website defacements — a uniquely high-signal active-compromise indicator samaritan has no equivalent for. **Flag:** reachability is unreliable (Cloudflare-gated, rate-limited, self-reported fakes), so value is speculative.
**SpiderFoot origin.** `modules/sfp_zoneh.py` (`lookupItem` 89-96).
**Maps to.** New `src/adapters/zoneh.ts` reusing `RssAdapter`'s XMLParser (`src/adapters/rss.ts:47-56`) + abusech degrade-to-empty pattern; register in `index.ts`, add `'zoneh'` to `SourceKind`.
**Port · effort S · impact LOW.**
**Sketch.** Parse the specialdefacements feed, emit `kind:'alert'`, modest confidence. **Correction:** `reconDomain` reads `tags.domain/tags.domains` (`reconDomain.ts:66-88`) — to trigger recon, set those tags, not a bare `defaced_host`.

### Architecture

#### First-class event lineage (sourceEvent provenance) as a queryable edge table — *recommend*
**What it is.** Promote the already-stamped-but-trapped `tags.parent_event_id` to a typed, indexed event→event edge. ~16 recon processors already write it into JSONB tags but it's read in **zero** places.
**SpiderFoot origin.** `spiderfoot/event.py` (38-55, 253-274, 284-301); `sfscan.py` ROOT + seed lineage (384-393).
**Maps to.** New `migrations/00X_event_lineage.sql` (`event_lineage(child_event_id, parent_event_id, relation, processor)` mirroring `event_entities`, `001_intelligence.sql:79-88`); writers in the 15 recon processors (`reconDomain.ts:102` etc.); readers in `src/routes/graph.ts` (extend `/network`) and `src/processors/brief.ts` (provenance-cited briefs).
**Port · effort M · impact HIGH.**
**Sketch.** Use `ON DELETE SET NULL` (not a hard FK) because recon events use synthetic ids (`reconDomain.ts:411`) and 30d retention purges parents before children (`scheduler.ts:408`). Add a `getEventLineage` helper in `src/store/events.ts`, back-fill convergence corroboration from `signals.ts` `event_ids`, and cite provenance in briefs. **Note:** signals already persist `event_ids` (`signals.ts:17-22`), so this is specifically the *typed event-to-event* gap, not total absence.

#### Watchlist / Area-of-Interest predicate (in-scope-vs-affiliate weighting) — *maybe*
**What it is.** Concept-transfer from `Target.matches()`: a user-defined set of geos/entities/domains where in-AOI events score higher and out-of-AOI matches are tagged `affiliate` rather than dropped. **Flag:** real risk of ballooning into a saved-search product; per-source `Subscription` filtering already covers part of the need.
**SpiderFoot origin.** `spiderfoot/target.py:157-221` (matches), 76-120 (alias expansion). **Idea, not a code port** — the IP/DNS logic doesn't transfer.
**Maps to.** New `src/store/aoi.ts` + `src/scoring/aoi.ts` predicate reusing `geo/utils.ts:55 pointInBox` and `countryResolver.ts:210 pointInPolygon`; new `ScoreComponents` field (`types.ts:272-279`) with rebalanced weights (`scoring/score.ts:34-40`); minimal `/aoi` GET/PUT route.
**Idea · effort M · impact MEDIUM.**
**Sketch.** Ship a tightly-scoped v1 (geo bbox/polygon + entity-value list + domain list) or it balloons. Tag out-of-AOI events `affiliate` in tags rather than dropping; defer delivery-routing changes to a later iteration.

### Enrichment

#### Keyless passive-DNS breadth for reconDomain (mnemonic + hackertarget) — *recommend*
**What it is.** Two keyless passive-DNS sources adding historical + co-hosted breadth that live DoH resolve and brute-force can't reach. Today the only passive DNS is behind the **paid, key-gated** `passivetotal.ts` (hard-returns without keys), so the keyless default config runs none.
**SpiderFoot origin.** `modules/sfp_mnemonic.py` (`query` 101-165), `modules/sfp_hackertarget.py` (`reverseIpLookup` 185).
**Maps to.** Add `queryMnemonic(domain)` + `queryHackertarget(domain)` beside `queryCrtsh` (`reconDomain.ts:243`)/`queryDns` (264), routed through `createReconEvent` (406); feed reverse-IP/co-host hits into the discovered-IPs reverse-DNS loop (216-237).
**Port · effort M · impact HIGH.**
**Sketch.** Verify mnemonic's `responseCode===200` envelope (402 = quota), filter by `lastSeenTimestamp`, cap co-hosts at 100, enforce the 0.75s throttle and bail on HackerTarget `429`. Count against the existing `reconHourlyCount` gate (`reconDomain.ts:56`); no new config keys needed (both keyless).

#### High-signal local extractors (ETH / IBAN / analytics IDs) in entityExtract — *recommend*
**What it is.** Pure, zero-network extractors for ETH `0x`-addresses, IBANs (mod-97), and GA/GTM analytics IDs (a shared analytics ID across two domains is a same-operator pivot). The store column is free-form text, so new types flow end-to-end with no schema change.
**SpiderFoot origin.** `modules/sfp_ethereum.py`, `sfp_iban.py`, `sfp_webanalytics.py`; validator in `helpers.py:1014-1072`.
**Maps to.** Extend the `EntityType` union + `PATTERNS` in `src/processors/entityExtract.ts:10-68`; add `isValidIban()` gating mirroring the existing IPv4 sanity-check (92-96). No `store/entities.ts` change.
**Port · effort S · impact MEDIUM.**
**Sketch.** ETH `/\b0x[a-fA-F0-9]{40}\b/`, analytics `UA-/G-/GTM-/pub-`, IBAN regex + mod-97. **Drop credit-card/Luhn** — storing card-like strings adds data-handling risk for marginal intel value, and there's no per-entity sensitivity field. The analytics-ID *pivot* needs an added cross-domain shared-value query in `store/entities.ts` (co-occurrence is via shared *events* today) — scope as follow-up.

#### Financial-PII + PGP + generic-URL + SHA512 extractors with checksum validation — *recommend*
**What it is.** IBAN (mod-97), credit-card (Luhn), PGP-key block, generic URL, and SHA512 extractors — direct fit for the pastebin/gist/darksearch/hibp leak-monitoring mission. (Overlaps the item above on IBAN; fold together — implement IBAN once.)
**SpiderFoot origin.** `helpers.py` `extractIbansFromText` (995-1074), `extractCreditCardsFromText` (1077-1124), `extractPgpKeysFromText` (951-970), `extractUrlsFromText` (1127-1140), SHA512 branch (912).
**Maps to.** `src/processors/entityExtract.ts` union + `PATTERNS`; add branches to `guessEntityType` (`store/entities.ts:201-211`) so LLM-supplied values aren't mislabeled `domain`.
**Port · effort S · impact MEDIUM.**
**Sketch.** SHA512 is a one-line `{128}` hex addition (lengths differ from sha256, no collision). For credit-card/IBAN, **mask the stored value** (e.g. last-4) rather than persisting raw PII as SpiderFoot does, given the 30d-retention single-operator model.

#### Tor-exit + open-proxy IP infrastructure tagging — *maybe*
**What it is.** Keyless cached lists tagging an IP as anonymizing infrastructure — not covered by GreyNoise (scan noise/RIOT only). **Flag:** narrow trigger surface (only IP-bearing events, env-gated, rate-limited); `multiproxy.org` is largely dead in 2026, so the Tor half via onionoo carries the value.
**SpiderFoot origin.** `modules/sfp_torexits.py` (`parseExitNodes` 121-170), `sfp_multiproxy.py`.
**Maps to.** New `src/processors/anonInfra.ts` (two TTL-refreshed Sets: onionoo 1h, multiproxy 24h); membership check in `enrichIp` (`reconIp.ts:49`) writing `tor_exit/open_proxy` into entity metadata (81) and recon tags (104).
**Port · effort S · impact MEDIUM.**
**Sketch.** Single guarded GET per list, degrade to stale/empty on failure (never throw). Surface as a *corroboration/context nudge* in `scoring/score.ts` — **not** a blind `max()` into `threatScore` (anonymizing infra is context, not inherently malicious).

#### Forward geocoding (Nominatim) to feed geo-convergence — *maybe*
**What it is.** Keyless place-string → lat/lon, letting text-only reports ("explosion near Port of Rotterdam") join the geo-convergence cell logic they're silently excluded from today. **Flag:** gated on a missing place-name extractor (`entityExtract.ts` is IOC-only) and Nominatim's hard 1 req/s policy needs a persistent queue + cache.
**SpiderFoot origin.** `modules/sfp_openstreetmap.py` (`query` 70-90, prefix regexes 113-119, 1 req/s sleep 125).
**Maps to.** New `src/geo/forwardGeocode.ts` invoked in `scheduler.ts` right before the `if (event.location)` block (~307) when location is unset and a high-confidence place was extracted; coords flow into `geoCell` (`convergence.ts:239`).
**Port · effort M · impact MEDIUM.**
**Sketch.** Port the query + cleanup regexes with an identifying User-Agent, wrap in cache + throttle via `circuitBreaker.ts`, add a persistent place→coords table. Build the place-extraction step first. Keep it advisory — populate `location`/tags only, never feed `computeScore` directly.

#### Validation gate (email) on entity extraction — *maybe*
**What it is.** A post-regex `validEmail`-style gate (reject <6 chars, `%`, `...`) to cut junk nodes from the co-occurrence graph. **Flag:** samaritan's email regex is already TLD-anchored, so the marginal precision lift is small; **drop `validLEI`** (no `lei` EntityType, no consumer).
**SpiderFoot origin.** `helpers.py` `validEmail` (715-744).
**Maps to.** Add optional `validate?(value)` to `PATTERNS` entries in `src/processors/entityExtract.ts`, applied after the IPv4 filter (92-96).
**Port · effort S · impact LOW.** Opportunistic, not standalone.

### Taxonomy

#### Discrete INFO/LOW/MEDIUM/HIGH risk band on signals and events — *maybe*
**What it is.** A pure `score → band` helper stamped on signals/events and exposed as a filter (`show me HIGH only`, push HIGH to telegram / digest the rest). **Flag:** float filtering (`minScore`, `minConfidence` in `delivery/router.ts:28`) already delivers core triage-by-threshold; this is UX sugar. Thresholds must be calibrated — the `0.85*composite+0.15*base` blend rarely nears 1.0, so naive quartiles would starve HIGH.
**SpiderFoot origin.** `correlation.py:24-46` (mandatory `meta.risk`) + `correlations/*.yaml`. **Idea** (taxonomy concept, no code).
**Maps to.** `RiskBand` + field on `IntelSignal`/`IntelligenceEvent` (`types.ts`); `deriveBand(score)` in `scoring/score.ts`; new migration + index; filter in `routes/events.ts`. **Note:** `routes/signals.ts` doesn't exist and `bus.ts` has no named SSE filter — confirm actual route files first.
**Idea · effort M · impact MEDIUM.**

#### Expand EntityType toward people/orgs/places/financial — *maybe*
**What it is.** Add person/org/place/phone/username/coordinate entity types so the co-occurrence graph (samaritan's standout asset) answers situational-awareness questions, not just IOC ones. **Flag:** payoff is gated on reworking the `text.ts` LLM prompt to return typed `{type,value,confidence}` objects; cheap regexes (eth/lat-lon/@username) are low-value, and phone/person/company regex is noise-prone.
**SpiderFoot origin.** `db.py:113-282` ENTITY rows (design evidence only, no code).
**Maps to.** Widen `EntityType` (`entityExtract.ts:10-20`); fix `guessEntityType` (`entities.ts:201-211`) which silently defaults unknowns to `domain`; rework `text.ts:24` prompt. Store is free-form text — no migration.
**Idea · effort M · impact MEDIUM.**

#### Entity-vs-descriptor tiering to suppress low-signal graph nodes — *maybe*
**What it is.** A one-map `EntityType → 'entity'|'descriptor'` plus an opt-in `?tier=entity` flag so `/network` can collapse attribute nodes (a common CVE/hash) that dominate layout. **Flag:** speculative readability nicety — the graph is 1-hop, capped at 500, with no evidenced layout problem at this scale.
**SpiderFoot origin.** `db.py` tiering consumed at `helpers.py:608-614`. **Idea.**
**Maps to.** `ENTITY_TIER` const in `entityExtract.ts`; `?tier=` filter in `routes/graph.ts:67-136`, default-off.
**Idea · effort S · impact LOW.**

#### Optional DataClass second axis for queryable findings — *maybe*
**What it is.** A small native `DataClass` enum (~15-25 values: `open_port`, `leaked_secret`, `exposed_service`, `typosquat`, `cv_detection`, `hazard_alert`…) stamped optionally at processing time so recon findings become first-class queries ("all leaked_secret events this week"). **Flag:** no caller demands it; **cheaper alternative** — a GIN/partial index over the already-consistent `tags->>'recon_type'` avoids touching every processor. Do NOT port SpiderFoot's 136-row recon-shaped table.
**SpiderFoot origin.** `db.py:111-284` (concept only).
**Maps to.** Nullable `data_class` column + `dataClass` filter in `routes/events.ts:11/28`; stamp in `createReconEvent` + per-processor.
**Idea · effort M · impact MEDIUM.**

### UX / API

#### Operator triage state (dismiss / acknowledge / mute) on signals — *recommend*
**What it is.** The single highest-value SpiderFoot concept for a single-operator firehose console. A persisted `{open, acknowledged, dismissed}` + optional `mutedUntil`, with a mutation route and a default-excludes-dismissed filter threaded through every read path. Today a noisy `geo_convergence` re-fires forever with no operator recourse.
**SpiderFoot origin.** `sfwebui.py` `resultsetfp` (1211-1265, FP flag + cascade). **Concept port** (SpiderFoot's scan-tree model ≠ samaritan's flat store; no Python copied).
**Maps to.** `triageState`/`mutedUntil` on `IntelSignal` (`types.ts:293`); migration adding columns to `intelligence_signals` + a `signal_mutes(dedupe_key, muted_until)` table; `setSignalTriage`/`isMuted` in `store/signals.ts`; mutation route on `signalRoutes` (`index.ts:36`); `convergence.ts`/`freshness.ts` consult `isMuted(dedupeKey)` alongside `signalDedupeExists`; filter respected in `routes/stream.ts:51`, `mcp/tools.ts:170`, dashboard counts.
**Idea · effort M · impact HIGH.**
**Sketch.** The critical risk is **leakage**: thread the filter through `/signals`, SSE, MCP, delivery, *and* dashboard or dismissed items reappear. Keep cascade-to-`eventIds` opt-in so dismissing a broad convergence doesn't bury legitimate member events.

#### `/signals/:id` drill-down returning member events — *recommend*
**What it is.** A `GET /signals/:id` returning the signal + hydrated `IntelligenceEvents` from its `eventIds` (already persisted, currently unexposed) — converts an opaque headline into an investigable object.
**SpiderFoot origin.** `sfwebui.py` `scaneventresults?correlationId=` (1747). **Port** (just a missing read route).
**Maps to.** New `getSignal(id)` in `store/signals.ts`; `signalRoutes.get('/:id')` in `index.ts` (37, flat `GET /` only today); `Promise.all`-maps `eventIds` through `getEvent` (`store/events.ts:197`); optionally composes `getEventEntities`.
**Port · effort S · impact MEDIUM.**
**Sketch.** Filter out `undefined` results so 30d-purged eventIds degrade to the surviving subset (not a 500); cap fan-out (~50) for large clusters; 404 when `getSignal` is undefined. No schema change.

#### Uniform CSV / NDJSON export + GEXF graph export — *recommend*
**What it is.** `format=csv|ndjson` on events/signals reads and `format=gexf` on the graph network route, so findings pull into spreadsheets / downstream pipelines / Gephi. Routes are JSON-only today.
**SpiderFoot origin.** `sfwebui.py` `buildExcel` (278), `scaneventresultexport` (440), `scanviz` GEXF (665-700). **Idea** (scope to CSV/NDJSON/GEXF — skip openpyxl/networkx, which don't port).
**Maps to.** New `src/lib/exporters.ts` (3 pure serializers); `format` switch + `Content-Disposition` in `routes/events.ts` and `signalRoutes` (`index.ts:36`); `format=gexf` branch in `routes/graph.ts:135` (which already builds `{nodes,links}`).
**Idea · effort S · impact MEDIUM.**
**Sketch.** GEXF is hand-rolled XML (no networkx in TS) — escape labels, type attvalues. JSON-encode nested tags/metadata cells per a fixed column policy. Reuse existing limit caps (events 500, nodes 500) for size bounding.

#### Severity risk-matrix on the dashboard — *maybe*
**What it is.** A `score → {HIGH,MEDIUM,LOW,INFO}` count block next to the existing `kindBreakdown` for at-a-glance "how many HIGH things are live." **Flag:** barely a port — SpiderFoot's matrix counts a hand-authored YAML `risk` field, not a derived score; the thresholds are net-new editorial invention. Pure cosmetic aggregation; pairs with the risk-band idea.
**SpiderFoot origin.** `sfwebui.py` `scanlist` riskmatrix (1628-1637).
**Maps to.** New `src/scoring/severity.ts` (`toSeverity` + `riskMatrix`); `events.riskmatrix` in `routes/dashboard.ts` (~88-98).
**Idea · effort S · impact LOW.**

#### Exact / *wildcard* / /regex/ scoped search grammar — *maybe*
**What it is.** Upgrade the single-mode `?query=` ILIKE into bare=contains, `*term*`=wildcard, `/pattern/`=Postgres regex. **Flag:** ILIKE already covers exact/contains and the corpus has pgvector + MCP `ask_corpus`; regex-over-firehose is niche. **Blocker:** `db.ts` sets no `statement_timeout`, so a user regex on the non-indexed text scan is a real ReDoS/runaway vector that must be capped first.
**SpiderFoot origin.** `sfwebui.py` `searchBase` (226-276).
**Maps to.** `parseQueryMode(q)` in `store/events.ts`, applied in `searchEvents` (104-107) + `listEventsDeduped` (65-69); length cap + `SET LOCAL statement_timeout` guard.
**Port · effort S · impact LOW.**

#### Graph export (Sigma-JSON / d3 tree) endpoint — *maybe*
**What it is.** Downloadable Sigma-JSON and d3 parent-child tree exports of the entity mesh for external tools. (Largely overlaps the CSV/GEXF item — fold into one `/graph/export` route.) **Flag:** niche analyst-interop, not a core win; the tree export must take a seed + bound depth since samaritan's graph is cyclic/multi-root.
**SpiderFoot origin.** `helpers.py` `buildGraphJson` (483-556), `dataParentChildToTree` (635-690).
**Maps to.** `src/serializers/graphExport.ts`; `GET /export?format=sigma|tree|gexf` in `routes/graph.ts` reusing the `/network` node/link assembly (79-133).
**Idea · effort M · impact MEDIUM.**

### Ops

No standalone Ops ports recommended. SpiderFoot's threadpool/scan-quiescence lifecycle (`threadpool.py`, `sfscan.py:438-586`) solves bounded-scan termination — meaningless for a perpetual poller whose concurrency story (`POLL_CONCURRENCY`, per-source 45s cap, re-entrancy guard, circuit breaker) is already sound. The batched-SQLite-write pattern (`logger.py`) doesn't apply to pooled Postgres.

## Explicitly NOT recommended

| Idea | Reason (rejected) |
|---|---|
| Rule-result persistence helper (headline templating + dedupe) | **Already exists** — `src/processors/convergence.ts:450-490` already does bucket→IntelSignal→dedupe→bus.emit; only ~15 lines of `{field}` substitution are new. Folds into the rule-engine item. |
| Watched/produced processor contract to replace the hardcoded ladder | **Low payoff vs L effort** — the "skip when inputs absent" benefit already happens via per-processor early-returns (`reconDomain.ts:59`, `reconIp.ts:19`); recon processors self-extract IOCs rather than consuming a shared object, so there's no real dependency DAG to encode. |
| Convergence reads explicit lineage edges instead of clustering | **Low impact** — recon-derived events lack `cluster_id` and sit outside the news/hazard convergence population; a parent and its child are the *same* finding re-derived (dedupe, not independent corroboration). |
| Data-driven convergence/freshness rules (YAML over the *existing* detectors) | **Poor mapping** — samaritan's detectors are grouping/scoring algorithms over `cluster_id`/geo cells, not field matchers; only ~5 headline strings are templatizable, not worth abstracting two mature, tuned processors. (The *generic* rule engine above is the right version of this.) |
| Per-event confidence/visibility/risk ints | **samaritan is ahead** — `scoring/score.ts` composite 0..1 with 6 components supersedes SpiderFoot's flat, never-populated ints. |
| SpiderFoot's 136-type closed taxonomy / single-parent-hash graph model | **Regression** — recon-shaped and mostly irrelevant; samaritan's `event_entities` junction + co-occurrence is already a superset. |
| Threadpool / scan-quiescence lifecycle | **N/A by design** — termination semantics are meaningless for a perpetual feeder. |

## Suggested sequencing

**Quick wins first (S effort, mostly independent):**
1. `/signals/:id` drill-down (`store/signals.ts` + `index.ts`) — pure read route, no schema change.
2. High-signal extractors: ETH/IBAN/analytics + PGP/URL/SHA512 (implement IBAN once; **fold the two enrichment items**) in `entityExtract.ts`.
3. OpenPhish/PhishTank adapter — clone `abusech.ts`.
4. Outlier and first-collection-only detectors in `convergence.ts` (cheap, but see dependency note below).

**Then the foundational bets:**
5. **Event lineage edge table** (M) — do this before anything that wants provenance; unblocks provenance-cited briefs and gives later correlation work explicit edges.
6. **Operator triage state** (M) — high value, mostly independent; the main cost is threading the filter through every read path.
7. **Keyless passive-DNS for reconDomain** (M) — independent, high-value enrichment breadth.

**The big bet, last:**
8. **Declarative YAML correlation-rule engine** (L) — depends conceptually on the outlier/first-collection analyzers (build them as the engine's first analyzers, or build standalone first and absorb later) and pairs naturally with the **risk-band** taxonomy idea (each rule declares its band). Re-express the two built-in convergences as seed rules to retire duplication. **Build the CSV/NDJSON/GEXF export and severity-matrix** alongside it as low-cost operator polish.

**Defer / conditional:** AOI watchlist (tight v1 only), forward geocoding (needs a place-extractor first), Tor/proxy tagging (Tor half only), DataClass axis (try the `tags->>'recon_type'` index first), Zone-H (flaky source), regex search grammar (needs a `statement_timeout` guard first).

## Licensing note

SpiderFoot v4.0 is **MIT** (`LICENSE`, Copyright 2022 Steve Micallef). True code ports (the correlation engine, the `helpers.py` extractors/validators, the graph serializers) are therefore fine **with an attribution header** — samaritan already models this convention in `src/processors/convergence.ts:16-19`. This is categorically different from the **AGPL clean-room boundary** documented in `docs/licensing-boundary.md`, where the worldmonitor lineage requires *clean-room* reimplementation with no code copied; nothing here touches that boundary. Note two practical carve-outs: the GEXF path's `networkx`/`GEXFWriter` dependency does **not** port (hand-roll minimal XML instead), and the `helpers.py` `phonenumbers`/`bs4` imports are unused by the functions being lifted, so they add no dependency drag. The taxonomy/UX *ideas* (triage state, risk bands, AOI, DataClass) copy no code at all — they're concept transfers, so attribution is courtesy, not obligation.
