# Operator console

A single-operator React console for watching the feeder in real time: a live
map, ranked event feed, cross-stream signals, source health, the daily brief,
delivery channels, and the analyst tooling (entity graph, ATT&CK matrix, OSINT
hub, stats). It lives under [`web/`](../web) and is built with React 19 + Vite,
inline styles only (no CSS files, no UI kit), and talks to the feeder through a
single typed client.

## Running it

```bash
cd web
npm install
npm run dev
# → http://localhost:5173
```

The dev server runs on **port 5173**. There is nothing else to configure for
local use — the console expects the feeder to be running and reachable through
the `/api` proxy (below).

For a production bundle:

```bash
cd web
npm run build      # type-checks (tsc) then emits web/dist
npm run preview    # serve the built bundle locally
```

In production the feeder serves `web/dist` directly and the same `/api/*` paths
resolve to its routes, so no proxy is needed there.

## The `/api` proxy

All data access goes through the shared client in
[`web/src/lib/api.ts`](../web/src/lib/api.ts), which prefixes every request with
`/api`. In dev, Vite proxies that prefix to the running feeder
(see [`web/vite.config.ts`](../web/vite.config.ts)):

```ts
server: {
  port: 5173,
  proxy: {
    '/api': {
      target: 'http://localhost:44556',   // the feeder
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  },
}
```

So a browser call to `/api/events` is forwarded to `http://localhost:44556/events`
on the feeder. If your feeder listens on a different host or port, edit the
`target` in `web/vite.config.ts`. The proxy also carries the SSE stream
(`/api/stream/:userId`) used by the Live tab.

The endpoints behind the proxy:

| Path | Purpose |
| --- | --- |
| `GET /api/events?rank=&minScore=&kinds=&sourceId=&limit=` | Ranked/filtered events |
| `GET /api/sources` | Sources with health state |
| `GET /api/signals?kinds=&minScore=&since=&limit=` | Cross-stream signals |
| `GET /api/brief/:userId` | Grounded daily brief (`operator` falls back to the global brief) |
| `/api/channels` (CRUD) | Delivery channels |
| `GET /api/stream/:userId` | SSE bus — `event`, `signal`, `heartbeat` |

### Operator identity

The console runs as a single operator. Everywhere a user id is needed (the SSE
subscription, the brief, channels) it uses the literal `operator`. Server-side,
`getBrief('operator')` falls back to the global brief, so a fresh install shows
a brief without any per-user setup.

## Tabs

The console is a single page with a tab bar across the top. Each tab is a
self-contained component under [`web/src/components/`](../web/src/components).

### 🗺️ Map

Geo-enriched events plotted on a Leaflet map with marker clustering. Events that
the brain resolved to a location (`event.location`) appear as pins; clusters
expand as you zoom. Use it to see where activity is concentrated and to spot
geo-convergence (multiple independent streams lighting up the same area).

### 📋 Events

The ranked event feed — the default analyst view. Each event is a card with a
source-kind icon, a color-graded importance chip (green → amber → red as the
0–1 score climbs), tags, and muted meta text. The feed can be ordered two ways:

- **Recency** (`rank=recency`) — newest first, the raw firehose.
- **Importance** (`rank=score`) — highest composite score first. This is the
  "rank by importance" view: the brain's scoring layer floats the events that
  matter to the top regardless of when they arrived. Combine with a `minScore`
  floor to suppress noise.

You can also filter by free-text query, kind, and source.

### 📡 Live

A live tail backed by the SSE bus (`/api/stream/operator`). New events and
signals stream in as they happen — no polling, no refresh. A small connection
indicator shows whether the EventSource is connected. Set a `minScore` or kind
filter to only wake up for high-importance traffic. This is the "leave it open
on a second monitor" view.

### 📈 Signals

The cross-stream intelligence layer. Where Events shows individual items,
Signals shows what the brain inferred *across* streams:

- **convergence** / **geo_convergence** — independent sources corroborating the
  same thing (optionally in the same place).
- **velocity_spike** — a source or topic accelerating unusually fast.
- **silent_source** — a normally-chatty source that has gone quiet (a freshness
  / dead-source alarm).
- **volume_anomaly** — overall volume departing from its baseline.
- **cluster_surge** — a topic cluster suddenly growing.

Each signal carries a score, a title/summary, and links back to the source and
event ids it was derived from, so you can pivot from "something is happening" to
the underlying evidence.

### 🩺 Health

Source health, served from `GET /api/sources`. For each source you see its
`healthState`, time since the last event (`lastEventAt`), consecutive failures,
any active `cooldownUntil`, last poll time, last latency, error count, and poll
interval. This is where you catch a feed that is failing, throttled, or silently
stale before it skews the rest of the picture. (Pairs with the **silent_source**
signal on the Signals tab.)

> The same source data also powers the legacy **📡 Sources** panel; Health is the
> operator-facing read of it.

### 🧠 Brief

The grounded daily brief for the operator (`GET /api/brief/operator`). It shows
a one-line **lead**, then a **body** with threads, the signals that fed it, and
a list of ranked event ids — every claim is grounded in events the feeder
actually ingested. Use it as the "what do I need to know right now" summary at
the start of a shift.

### 📨 Channels

Manage where the feeder pushes alerts. Lists the operator's delivery channels
and lets you create, enable/disable, and delete them. Supported channel kinds:
**telegram**, **discord**, **slack**, **webhook**, **email**, **samaritan**.
Each channel has a `kind`, a `config` (e.g. a webhook URL or chat id), an
enabled flag, and optional **quiet hours** so off-hours alerts can be held back.

### 🔗 Graph

A force-directed entity/relationship graph linking events, sources, and the
entities extracted from them. Use it to explore how items connect — shared
actors, places, or clusters — rather than reading them one by one.

### 🛡️ ATT&CK

The MITRE ATT&CK matrix view, highlighting techniques referenced across recent
events so you can see adversary behavior mapped to the standard tactic/technique
framework at a glance.

### 🧰 OSINT

An OSINT toolbox hub for pivoting on indicators (domains, IPs, hashes, URLs)
surfaced in events — quick links into the enrichment/lookup tooling the feeder
exposes.

### 📊 Stats

Dashboard counters and trends — event/signal volumes, source counts, and other
at-a-glance health and throughput metrics for the whole feeder.

## How it's built (for contributors)

- **React 19 function components**, default export, **inline styles only** — no
  CSS files, no UI libraries. Match [`EventFeed.tsx`](../web/src/components/EventFeed.tsx)
  for the visual idiom (card lists, kind color chips, source-kind emoji icons,
  muted gray meta text, centered scroll containers).
- ESM imports use the **`.js` extension** (e.g. `import { getEvents } from '../lib/api.js'`).
- All data flows through [`web/src/lib/api.ts`](../web/src/lib/api.ts); shared
  types live in [`web/src/lib/types.ts`](../web/src/lib/types.ts); the live SSE
  hook is [`web/src/lib/useSSE.ts`](../web/src/lib/useSSE.ts)
  (`useEventStream(userId, opts)` → `{ events, signals, connected }`).
- Tabs are registered in [`web/src/App.tsx`](../web/src/App.tsx).
