# Video Intelligence (CV) Integration

This feeder ingests a lot of public camera feeds (webcams, CCTV, traffic and
weather cams). Historically each poll grabbed **one** frame, did a crude
byte-hash motion check, and asked a **vision LLM** to describe the scene — fuzzy,
expensive per frame, and it sent raw imagery (including people) to a third party.

This integration adds real computer vision via
[roboflow/supervision](https://github.com/roboflow/supervision), running in a
dedicated **CV sidecar** (`cv-sidecar/`). The feeder gets precise, cheap,
**anonymous** object counts and scene analytics instead of LLM prose, and raw
frames never reach the database.

## Architecture

```
                         poll (1/min)
 scheduler.ts ──> webcam/ipcamera/traffic/weather adapter
                         │  ffmpeg: 1 jpeg
                         │  motion.ts gate (skip static frames)
                         ▼
            src/processors/detection.ts  ── HTTP ──>  cv-sidecar (FastAPI + supervision)
                 (sanitize allowlist)                  detect → counts/crowd/zones
                         │  CvAnalytics (aggregates only)        (+ redact persons)
                         ▼
                 RawEvent (kind: visual | anomaly, tags.cv)
                         ▼
            scheduler.ingestRawEvent ─> intelligence_events ─> MCP / /digest / alerts
```

- **The sidecar owns all pixels.** The feeder sends a frame and gets back
  integers and enums — never identities, tracks, or descriptions.
- **`detection.ts` is the enforcement boundary.** Its `sanitizeCvResult()` is an
  *allowlist*: only counts, crowd density, zone/line aggregates, anomaly enums,
  and activity level survive. `tracker_id`, embeddings, plate strings, and any
  free text are dropped by construction. `buildCvSummaryText()` is the *only*
  string producer, built purely from the sanitized integers, so the event
  content / embedding / digest are PII-free by design.

## What P0 ships (current)

- A license-clean Python CV sidecar (`cv-sidecar/`): `supervision` (MIT) +
  **RF-DETR (Apache-2.0)** by default, on `onnxruntime`/CPU.
- `src/processors/detection.ts`: typed sidecar client + allowlist sanitizer +
  deterministic summary/title builders.
- `src/adapters/webcam.ts` (and `ipcamera`, plus new `traffic_cam` /
  `weather_cam` adapters) call the sidecar after the motion gate, emit one
  `RawEvent` per poll with `tags.cv`, and **stop persisting frame bytes**.
- Counts (people/vehicles), crowd-density bucket, optional per-source polygon
  **zone occupancy**, and a crowd anomaly flag — all anonymous integers.
- The vision LLM is demoted to optional, off-by-default *enrichment* on a
  **redacted** thumbnail, with a prompt rewritten to forbid identifiable detail.
- No schema migration: aggregates live in the existing `intelligence_events.tags`
  JSONB under `tags.cv`. Reuses the `visual` / `anomaly` event kinds.

### Enabling it

```bash
docker compose up --build          # postgres + cv-sidecar + feeder
# or, against an existing feeder:
CV_ENABLED=true CV_SIDECAR_URL=http://localhost:8800 npm run dev
```

Create a camera source and counts start flowing:

```bash
curl -X POST http://localhost:3000/sources -H 'Content-Type: application/json' -d '{
  "kind": "traffic_cam",
  "name": "Gran Via Cam",
  "config": {
    "streamUrl": "http://example/cam.jpg",
    "frameIntervalSeconds": 60,
    "cv": {
      "region": "EU",
      "watchClasses": ["person", "car", "bus", "truck", "bicycle"],
      "zones": [{ "id": "crosswalk", "polygon": [[0.1,0.5],[0.9,0.5],[0.9,0.9],[0.1,0.9]] }]
    }
  },
  "pollIntervalSeconds": 60
}'
```

`tags.cv` then carries `{ counts, crowdDensity, zones, lines, anomaly, scene, model }`
and is returned verbatim by the MCP `query_intelligence_events` tool; the count
sentence is injected into the Samaritan `/digest`.

### Clip mode (P1 — tracking, lines, dwell)

Set `cv.clipMode: true` on a **video** source (RTSP/HLS/YouTube-live, not a
static-jpeg cam). The motion gate still runs as a free pre-filter; on motion the
sidecar pulls a short clip from the resolved stream URL and runs
detect → ByteTrack → zone occupancy → line in/out → dwell → consolidate.

```jsonc
{
  "kind": "traffic_cam",
  "name": "Gran Via Cam",
  "config": {
    "streamUrl": "https://example/stream.m3u8",
    "streamType": "rtsp",            // any non-"image" video type
    "frameIntervalSeconds": 60,
    "cv": {
      "region": "EU",
      "clipMode": true,
      "clipSeconds": 4,
      "sampledFps": 6,
      "watchClasses": ["person", "car", "bus", "truck", "bicycle"],
      "zones": [{ "id": "plaza", "polygon": [[0.1,0.4],[0.9,0.4],[0.9,0.9],[0.1,0.9]], "dwellThresholdSec": 60 }],
      "lines": [{ "id": "northbound", "start": [0.0,0.6], "end": [1.0,0.6] }]
    }
  },
  "pollIntervalSeconds": 60
}
```

This emits ONE `kind:'detection'` event per poll (count/flow summary in
`tags.cv`, throughput = distinct confirmed tracks), and writes the granular
per-track / per-zone detail to the `cv_track_events` / `cv_zone_counts` tables
(`GET /cv/detail/:sourceId`). The same real-world object across consecutive
clips is reconciled by a coarse `dedupe_key` (no identity), so a parked car does
not re-fire every minute. `tracker_id` is transient inside one sidecar request
and never persisted. Loitering (dwell ≥ `dwellThresholdSec`) and crowd thresholds
raise the event to `kind:'anomaly'`.

Migration `002_cv_sidecar.sql` (applied by the fixed `migrations/run.ts`) adds
the `detection` kind and the `cv_*` tables. Redacted best-frames are purged at
the 7-day raw window by the extended cleanup job.

### Alerts, speed, artifacts (P2 — signal-not-noise)

Add `cv.rules` to a source to turn routine analytics into push-worthy
`kind:'alert'` events that route through the existing proactive-delivery /
subscription path. Optionally add `cv.speed` calibration for overspeed/wrong-way.

```jsonc
"cv": {
  "clipMode": true,
  "zones": [{ "id": "plaza", "polygon": [[0.1,0.4],[0.9,0.4],[0.9,0.9],[0.1,0.9]], "dwellThresholdSec": 60 }],
  "lines": [{ "id": "main", "start": [0,0.6], "end": [1,0.6] }],
  "rules": [
    { "id": "crowd", "type": "crowd_threshold", "threshold": 25 },
    { "id": "loiter", "type": "loitering", "zoneId": "plaza", "threshold": 60 },
    { "id": "surge", "type": "line_surge", "lineId": "main", "threshold": 40 }
  ],
  "speed": {
    "imagePoints": [[0.2,0.4],[0.8,0.4],[0.9,0.9],[0.1,0.9]],
    "worldPoints": [[0,0],[12,0],[12,30],[0,30]],
    "maxKmh": 50, "expectedHeadingDeg": 90
  }
}
```

- **Alert rules** (`zone_breach`, `loitering`, `crowd_threshold`, `line_surge`)
  are evaluated **Node-side** ([alertRules.ts](../src/processors/alertRules.ts))
  from the already-sanitized aggregates — pure integers, no imagery. A fired rule
  emits a separate `kind:'alert'` event (the routine record stays `detection`),
  persisted to `cv_alerts` (`GET /cv/alerts/:sourceId`).
- **Speed / wrong-way**: with a 4-point homography the sidecar maps each track's
  endpoints to metres → km/h and heading; `overspeed`/`wrong_way` become anomaly
  reasons (no position trail is ever exposed — only aggregate speed/heading).
- **Redacted artifacts**: with `CV_STORE_ARTIFACTS=true`, a push alert stores ONE
  pixelated best-frame in `cv_alerts.best_frame` (purged at 7d). Default off,
  **EU-gated** (skipped for EU/unknown-region sources), and the frame never
  enters `intelligence_events`. Redaction is **fail-closed**: if no person box is
  detected (one could be present below threshold), the WHOLE frame is pixelated
  rather than stored raw — so `redaction_applied` is always truthful.
- **Open-vocab watch-classes**: `CV_DETECTOR=yolo-world` (opt-in, **GPL/AGPL** —
  isolated container only) detects analyst-specified `CV_OPENVOCAB_CLASSES`
  (e.g. `ambulance, smoke, flood`).

Migration `003_cv_alerts.sql` adds the `cv_alerts` table.

#### Semantic search (opt-in)
Text → de-identified-frame search over alert imagery. When an alert fires (with
`CV_SEMANTIC_SEARCH=true`), the sidecar CLIP-embeds the **same redacted** best-frame
and Node stores the 512-d vector in a pgvector `cv_embeddings` table; query it at
`GET /cv/search?q=...` (the query is embedded into the same space, cosine-ranked).

- **Privacy**: the embedding is computed only from the redacted frame (inherits
  the opt-in + EU-gate + fail-closed pixelation), is transient (never in
  `intelligence_events`), and the stored caption is the PII-free alert summary —
  so the archive is de-identified *scene* vectors, not identities.
- **Infra (deliberately isolated so it can't break default deploys)**: needs the
  `pgvector` Postgres image, the sidecar built `WITH_CLIP=true` + `CV_CLIP_ENABLED=true`
  (open_clip, MIT; LAION weights are RAIL-restricted, not copyleft), and the
  **optional** migration — `npm run db:migrate:semantic` (or `--profile semantic`).
  It lives in `migrations/optional/004` so the default `db:migrate` glob never runs
  `CREATE EXTENSION vector`. `insertCvEmbedding` runs outside the alert transaction;
  a missing table/extension surfaces as an actionable 503 from `/cv/search`, never
  a crash. Changing `CV_CLIP_MODEL` means editing `vector(512)` to the new dim.

## Privacy & compliance (enforced in code)

Mandate: *public sources only, no facial recognition, no PII*. Many feeds are EU
(Madrid/Galicia CCTV) → GDPR/AI-Act apply. Enforcement is in code, not prose:

- **No raw frames stored.** Detection happens in sidecar RAM; the feeder persists
  only aggregates. `VISION_PERSIST_RAW_FRAMES=false` by default.
- **Redact before any frame leaves the sidecar.** Persons are irreversibly
  pixelated (`PixelateAnnotator`) before a thumbnail is returned or sent to the
  LLM. `VISION_REDACT_BEFORE_STORE=true` by default.
- **No identity, ever (default).** `ALLOW_FACE_RECOGNITION`, `ALLOW_PLATE_OCR`,
  `ALLOW_PERSON_REID`, `ALLOW_CROSS_CAMERA_TRACKING`, `PERSIST_TRACKER_IDS` all
  default false (strict parser — `"false"` cannot accidentally enable them).
- **EU hard-gate.** With `CV_EU_HARD_GATE=true`, EU (and unknown-region) sources
  never request a thumbnail or LLM enrichment — fail-closed.
- **No location from imagery.** CV events skip EXIF GPS scraping; location comes
  from source config only.
- **Allowlist sanitizer** (`detection.ts`) is the structural guarantee that none
  of the above can leak even if the sidecar regresses.

> Before processing EU CCTV at scale, complete a DPIA and confirm a lawful basis
> and (if the LLM endpoint is third-party) a data-processing agreement. The
> `CV_LLM_ENRICH` path sends redacted thumbnails to `LLM_BASE_URL` — review that
> transfer. These are operational/legal gates, not code.

## Network security & SSRF (stream URLs)

Stream URLs are **source-supplied** (`config.streamUrl` / `config.url`) and the
crawler follows **attacker-influenceable** hrefs, so every outbound fetch is a
potential SSRF into cloud metadata (`169.254.169.254`), loopback, or RFC1918.
Two layers, in code:

1. **`src/util/safeFetch.ts`** — SSRF-safe replacement for `fetch`. Rejects
   non-http(s), embedded credentials, `localhost`, and literal/private/reserved
   IPs; resolves A+AAAA and refuses if **any** record is private (blocks DNS
   rebinding); pins the validated address via a custom `lookup` + fixed `family`
   so connect can't re-resolve to a private host (closes the TOCTOU); re-validates
   every redirect hop. Routed through it: `webcrawl`, `webcam`/`ip_camera` health
   probes, `urlscan`, `virustotal`.
2. **ffmpeg / yt-dlp egress** — these tools fetch the stream URL in their **own
   process**, so they can't be address-pinned. Before invoking them the feeder
   calls `assertEgressAllowed()` (scheme allowlist — no `file:`/`pipe:`/`concat:`
   — plus resolve-all-reject-any-private), runs them via `execFile` (argv array,
   **no shell**), and passes ffmpeg `-protocol_whitelist` (transport protocols
   only). The sidecar's `clip_url` is validated the same way in `detection.ts`
   before it is handed across.

**LAN cameras:** these guards block private/reserved destinations by default. To
watch a camera on the operator's own network, set `ALLOW_PRIVATE_STREAM_URLS=true`
(off by default) — the SSRF/stream equivalent of `safeFetch`'s `allowPrivate`.

> **Residual rebinding (deploy-time control).** ffmpeg/yt-dlp and the sidecar
> re-resolve DNS themselves, leaving a sub-second rebinding window the in-process
> checks can't fully close. In production, back the code guards with a **network
> egress policy**: block the link-local range `169.254.0.0/16` (cloud metadata —
> or enforce IMDSv2 / disable IMDS on the instance), and deny egress from the
> feeder + sidecar containers to RFC1918/loopback except the explicit
> `CV_SIDECAR_URL` / `GO2RTC_URL` endpoints. On Fly.io use a private-network /
> egress ruleset; with Docker Compose put the feeder and sidecar on a network
> whose only permitted internal target is each other. This is the layer that
> defeats a racing rebinder; the code guards defeat everything slower.

## Licensing

The feeder is **MIT** (see `LICENSE`). Component licenses:

| Component                | License      | Shipped by default |
|--------------------------|--------------|--------------------|
| supervision              | MIT          | yes                |
| RF-DETR (default model)  | Apache-2.0   | yes                |
| roboflow `trackers` (P1) | Apache-2.0   | yes (P1)           |
| Ultralytics YOLO         | **AGPL-3.0** | **no** (opt-in)    |
| YOLO-World (P2 open-vocab)| **GPL-3.0** | **no** (isolated)  |

Running an AGPL model as a network service can impose source-availability
obligations on the whole deployment, and a sidecar boundary does **not** reliably
sever that. The safe posture is what we do: **don't ship AGPL/GPL models by
default.** `CV_DETECTOR=ultralytics` is an explicit operator decision that emits a
loud startup warning; those weights/images are never baked into a distributed
artifact.

## Ported ideas & roadmap

Drawn from a survey of the best OSS video-intelligence projects.

### P1 — clips, tracking, zones/lines, consolidated events ✓ (shipped)
- **Multi-object tracking** via roboflow `trackers` (`ByteTrackTracker`,
  Apache-2.0) — *not* the deprecated `sv.ByteTrack` (kept only as a fallback).
  `frame_rate` is set to the real sampled fps and `lost_track_buffer` scaled to
  it, so low-fps polled clips track correctly.
- **Line crossings** (`sv.LineZone`) for directional traffic flow, **zone
  occupancy + dwell** timers for loitering.
- **Frigate-style consolidation**: per-track records (not per-frame), with a
  confirm-frames debounce and cross-clip `dedupe_key` reconciliation so a parked
  car doesn't re-fire — no identity/embedding used.
- A clip is pulled by the **sidecar itself** from the resolved stream URL
  (frame bytes never touch the Node event loop), behind a hard concurrency
  semaphore sized to vCPUs. **go2rtc** is wired as an *optional* normalization
  proxy (`--profile go2rtc`, generated config at `GET /cv/go2rtc.yaml`) for
  protocol-stubborn feeds — not on the critical path.
- Adds the `detection` EventKind + `cv_track_events` / `cv_zone_counts` tables +
  `cv_config` column (migration `002`, applied by the now-fixed
  `migrations/run.ts`), and extends the 7-day cleanup to purge redacted
  best-frames.

### P2 — alerts, artifacts, speed, open-vocab ✓ (shipped, except search)
- **Alert rules** (zone breach / loitering / crowd threshold / line surge) →
  `kind:'alert'` → existing proactive delivery. Frigate Detection-vs-Alert split
  keeps notifications signal-not-noise. Persisted to `cv_alerts`.
- **Redacted best-frame artifacts** on alerts (`CV_STORE_ARTIFACTS`, default off),
  purged on the 7-day clock; never written to `intelligence_events`.
- **Speed estimation** via a 4-point homography → overspeed/wrong-way anomalies.
- **Open-vocabulary watch-classes** (`CV_DETECTOR=yolo-world`, opt-in, GPL/AGPL,
  isolated container) so an analyst can watch "ambulance, smoke, flood".
- **Semantic search** (CLIP → pgvector) ✓ — opt-in text→frame search over
  de-identified alert imagery (`GET /cv/search`), isolated optional migration.

### Performance note (read before P1)
The poll loop is single-threaded and serial. P0 single-frame detection at 1
poll/min/camera is comfortable on CPU. **P1 clip tracking is NOT free on
`shared-cpu-2x`**: a 4 s clip is ~24 frames and RF-DETR is a transformer
(~hundreds of ms/frame on CPU). Before committing P1, benchmark on the real Fly
machine, cap concurrent clip cameras with a semaphore, use a 56-divisible
RF-DETR resolution (e.g. 448/336), and keep the sidecar warm (don't scale-to-zero
on a 1-minute cadence). Consider a dedicated-CPU machine tier for clip tracking.
