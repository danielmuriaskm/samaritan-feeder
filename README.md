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

## Legal & Ethics

- **Public sources only** — no private accounts or unauthorized cameras
- **No facial recognition** — vision prompts exclude PII extraction
- **30-day retention** — events auto-purge; raw data purged after 7 days
- **Audit trail** — every ingestion logged to `intelligence_deliveries`

## License

Same as Samaritan (MIT)
