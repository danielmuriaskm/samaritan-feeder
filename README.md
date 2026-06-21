# Samaritan Intelligence Feeder

Real-time intelligence ingestion service for [Samaritan](https://github.com/danielmurias-prz/samaritan). Monitors public data sources — RSS feeds, public webcams, social media — extracts structured intelligence via multimodal LLMs, and surfaces it to Samaritan through tools, system prompt injection, and proactive alerts.

## Architecture

```
Sources (RSS/Webcam/Social) → Adapters → Processors → Events DB → Samaritan
                                                    ↓
                                              MCP Server Bridge
```

- **Separate service** — scales independently from Samaritan's chat stack
- **Shared Postgres** — events stored in `samaritan.intelligence_*` tables
- **4 integration modes** — passive tool, system prompt injection, proactive push, MCP bridge

## Intelligence brain (v0.1, clean-room)

On top of raw ingestion the feeder adds a clean-room "brain" layer that turns a
firehose of events into ranked, corroborated intelligence. It is licensed
**MIT**, the same as the rest of the feeder — [worldmonitor][wm] (AGPL-3.0) was
only an idea source and **no code was copied**; see
[`docs/licensing-boundary.md`](docs/licensing-boundary.md).

- **Composite scoring & ranking** — every event gets a 0–1 importance score
  (with per-component breakdown), so the feed can be ranked by importance, not
  just recency, and low-value noise can be floored out with `minScore`.
- **Cross-stream convergence** — detects when independent sources corroborate
  the same thing (`convergence`, `geo_convergence`), so multi-source
  confirmation surfaces automatically.
- **Freshness & silent-source detection** — flags normally-active sources that
  have gone quiet (`silent_source`) plus velocity/volume anomalies and cluster
  surges, so dead or throttled feeds don't silently skew the picture.
- **Grounded briefs** — a daily brief whose lead, threads, and signals are all
  grounded in events the feeder actually ingested (with ranked event ids), per
  operator or global.
- **Multi-channel delivery** — push alerts to **telegram, discord, slack,
  webhook, email, or Samaritan**, with per-channel enable flags and quiet
  hours.
- **Live SSE** — a real-time bus streaming new events and signals
  (`/api/stream/:userId`) for live operator views.
- **Geo enrichment** — events are resolved to locations for the map and for
  geo-convergence.
- **New authoritative sources** — additional first-party / authoritative
  adapters feeding the corpus.
- **New MCP tools** — `top_intelligence`, `query_signals`, `get_source_health`,
  and `ask_corpus` expose the ranked feed, signals, source health, and a
  grounded Q&A over the corpus to Samaritan.

See [`docs/brain-layer.md`](docs/brain-layer.md) for the full design and
[`docs/licensing-boundary.md`](docs/licensing-boundary.md) for the MIT /
clean-room boundary.

[wm]: https://github.com/worldmonitor/worldmonitor

### Operator console

A single-operator React console for watching the feeder in real time — live
map, importance-ranked event feed, cross-stream signals, source health, the
grounded brief, delivery channels, and the analyst tooling (entity graph, ATT&CK
matrix, OSINT hub, stats). It lives under [`web/`](web):

```bash
cd web
npm install
npm run dev      # → http://localhost:5173
```

The dev server proxies `/api` to the running feeder (see
[`web/vite.config.ts`](web/vite.config.ts)). Full run instructions and a
tab-by-tab guide are in
[`docs/operator-console.md`](docs/operator-console.md).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env and configure
cp .env.example .env

# 3. Run migrations (shared DB with Samaritan)
npm run db:migrate

# 4. Start dev server
npm run dev
```

## Adding a Source

```bash
curl -X POST http://localhost:3000/sources \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "rss",
    "name": "TechCrunch",
    "config": { "url": "https://techcrunch.com/feed/" },
    "pollIntervalSeconds": 300
  }'
```

## Integration with Samaritan

1. Set `FEEDER_BASE_URL` and `FEEDER_API_KEY` in Samaritan's environment
2. Enable feature flag: `FEATURE_INTELLIGENCE_FEEDER=true`
3. Samaritan will auto-discover the `get_intelligence_events` tool and inject digests into system prompts

## Security (SSRF)

Source configs and crawled links are attacker-influenceable, so every outbound
fetch is validated server-side:

- **`src/util/safeFetch.ts`** wraps risky `fetch` calls (`webcrawl`, `webcam`/
  `ip_camera` probes, `urlscan`, `virustotal`): rejects non-http(s), credentials,
  `localhost` and private/reserved IPs; resolves A+AAAA and refuses if **any**
  record is private (anti-rebinding); pins the validated address (closes the
  resolve→connect TOCTOU); re-validates every redirect.
- **ffmpeg/yt-dlp** stream URLs run via `execFile` (no shell), behind an egress
  pre-check + ffmpeg `-protocol_whitelist` (no `file:`/`pipe:`/`concat:`).
- **LAN cameras:** private destinations are blocked by default — opt in with
  `ALLOW_PRIVATE_STREAM_URLS=true`.

In production, back these with a **network egress policy** (block `169.254.0.0/16`
metadata + RFC1918 from the feeder/sidecar containers). See
[`docs/video-intelligence.md`](docs/video-intelligence.md) → *Network security & SSRF*.

## Legal & Ethics

- **Public sources only** — no private accounts or unauthorized cameras
- **No facial recognition** — vision prompts exclude PII extraction
- **30-day retention** — events auto-purge; raw data purged after 7 days
- **Audit trail** — every ingestion logged to `intelligence_deliveries`

## License

Same as Samaritan (MIT)
