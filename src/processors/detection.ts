import { config } from '../config.js';
import { assertEgressAllowed, STREAM_URL_SCHEMES, SsrfError } from '../util/safeFetch.js';
import type {
  CvAnalytics,
  CrowdDensity,
  CvAnomalyReason,
  CvLineResult,
  CvTrack,
  CvZoneResult,
  LineConfig,
  SpeedCalibration,
  ZoneConfig,
} from '../types.js';

/**
 * Node-side enforcement boundary for the CV sidecar.
 *
 * Two jobs:
 *   1. Talk to the Python sidecar (`/v1/analyze`) with a hard timeout so a slow
 *      sidecar can never stall the synchronous poll loop.
 *   2. ALLOWLIST every field that crosses back in (`sanitizeCvResult`). Even if
 *      the sidecar regresses and emits identity-bearing data, nothing but
 *      anonymous integer aggregates and enums can reach a RawEvent. There is no
 *      free-text channel: the only human-readable string is produced locally by
 *      `buildCvSummaryText` from the sanitized integers/enums.
 */

export class CvSidecarError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CvSidecarError';
  }
}

const CROWD_DENSITIES: CrowdDensity[] = ['empty', 'light', 'moderate', 'busy', 'crowded'];
const ANOMALY_REASONS: CvAnomalyReason[] = ['crowd', 'count_spike', 'loitering', 'overspeed', 'wrong_way'];
const ACTIVITY_LEVELS = ['low', 'medium', 'high'] as const;

// Class names are restricted to a safe shape: lowercase words/spaces only.
// This blocks any attempt to smuggle a plate string / free text through a
// counts key (e.g. { "1234-ABC parked": 1 }).
const CLASS_NAME_RE = /^[a-z][a-z _-]{0,30}$/;

export interface AnalyzeFrameOpts {
  sourceId: string;
  frameBase64: string;
  region?: 'EU' | 'non_EU' | 'unknown';
  detectClasses?: string[];
  zones?: ZoneConfig[];
  wantThumbnail?: boolean;
}

/** Raw, untrusted sidecar response (before sanitization). */
interface RawCvResponse {
  thumbnail_base64?: string;
  artifact_base64?: string;
  embedding?: unknown;
  redaction_applied?: boolean;
  [k: string]: unknown;
}

export interface AnalyzeResult {
  cv: CvAnalytics;
  /** Redacted thumbnail (only if requested AND redaction was applied). */
  thumbnailBase64?: string;
}

export async function analyzeFrame(opts: AnalyzeFrameOpts): Promise<AnalyzeResult> {
  if (!config.CV_SIDECAR_URL) {
    throw new CvSidecarError('CV_SIDECAR_URL is not configured');
  }

  const body = {
    source_id: opts.sourceId,
    frame_base64: opts.frameBase64,
    region: opts.region ?? 'unknown',
    detect_classes: opts.detectClasses,
    zones: opts.zones?.map((z) => ({ id: z.id, polygon: z.polygon })),
    want_thumbnail: opts.wantThumbnail ?? false,
  };

  let res: Response;
  try {
    res = await fetch(`${config.CV_SIDECAR_URL}/v1/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.CV_SIDECAR_TOKEN ? { Authorization: `Bearer ${config.CV_SIDECAR_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.CV_SIDECAR_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CvSidecarError(`sidecar unreachable: ${msg}`);
  }

  if (!res.ok) {
    throw new CvSidecarError(`sidecar error: ${res.status}`, res.status);
  }

  const json = (await res.json()) as RawCvResponse;
  const cv = sanitizeCvResult(json);

  // Only surface a thumbnail the sidecar confirms it redacted.
  const thumbnailBase64 =
    opts.wantThumbnail && json.redaction_applied === true && typeof json.thumbnail_base64 === 'string'
      ? json.thumbnail_base64
      : undefined;

  return { cv, thumbnailBase64 };
}

export interface AnalyzeClipOpts {
  sourceId: string;
  clipUrl: string;
  region?: 'EU' | 'non_EU' | 'unknown';
  sampledFps?: number;
  maxSeconds?: number;
  clipStartMs?: number;
  detectClasses?: string[];
  zones?: ZoneConfig[];
  lines?: LineConfig[];
  speed?: SpeedCalibration;
  wantArtifact?: boolean;
  wantEmbedding?: boolean;
}

/** Clip analysis: detect → track → zones/lines/dwell → consolidated tracks. */
export async function analyzeClip(
  opts: AnalyzeClipOpts,
): Promise<{ cv: CvAnalytics; artifactBase64?: string; embeddingVector?: number[] }> {
  if (!config.CV_SIDECAR_URL) {
    throw new CvSidecarError('CV_SIDECAR_URL is not configured');
  }

  // SSRF: the sidecar fetches clip_url server-side. It's a source-derived stream
  // URL, so validate it is publicly routable (scheme allowlist + resolve-all)
  // before handing it across — independent of the upstream webcam pre-check.
  try {
    await assertEgressAllowed(opts.clipUrl, {
      allowedSchemes: STREAM_URL_SCHEMES,
      allowCredentials: true,
      allowPrivate: config.ALLOW_PRIVATE_STREAM_URLS,
    });
  } catch (err) {
    if (err instanceof SsrfError) throw new CvSidecarError(`unsafe clip_url: ${err.message}`);
    throw err;
  }

  const body = {
    source_id: opts.sourceId,
    clip_url: opts.clipUrl,
    region: opts.region ?? 'unknown',
    sampled_fps: opts.sampledFps ?? config.CV_SAMPLED_FPS,
    max_seconds: opts.maxSeconds ?? config.CV_CLIP_SECONDS,
    clip_start_ms: opts.clipStartMs,
    detect_classes: opts.detectClasses,
    zones: opts.zones?.map((z) => ({
      id: z.id,
      name: z.name,
      polygon: z.polygon,
      dwell_threshold_sec: z.dwellThresholdSec,
      object_classes: z.objectClasses,
    })),
    lines: opts.lines?.map((l) => ({ id: l.id, name: l.name, start: l.start, end: l.end })),
    speed: opts.speed
      ? {
          image_points: opts.speed.imagePoints,
          world_points: opts.speed.worldPoints,
          max_kmh: opts.speed.maxKmh,
          expected_heading_deg: opts.speed.expectedHeadingDeg,
        }
      : undefined,
    want_artifact: opts.wantArtifact ?? false,
    want_embedding: opts.wantEmbedding ?? false,
  };

  let res: Response;
  try {
    res = await fetch(`${config.CV_SIDECAR_URL}/v1/analyze-clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.CV_SIDECAR_TOKEN ? { Authorization: `Bearer ${config.CV_SIDECAR_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.CV_SIDECAR_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CvSidecarError(`sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new CvSidecarError(`sidecar error: ${res.status}`, res.status);
  }

  const json = (await res.json()) as RawCvResponse;
  const artifactBase64 =
    opts.wantArtifact && json.redaction_applied === true && typeof json.artifact_base64 === 'string'
      ? json.artifact_base64
      : undefined;
  // The embedding is computed by the sidecar ONLY from the redacted frame, so it
  // is gated on the same redaction_applied flag. Sanitize to finite numbers of
  // the configured dimension.
  const embeddingVector =
    opts.wantEmbedding && json.redaction_applied === true ? sanitizeEmbedding(json.embedding) : undefined;
  return { cv: sanitizeCvResult(json), artifactBase64, embeddingVector };
}

/** Validate a sidecar embedding: exactly CV_CLIP_DIM finite numbers. */
export function sanitizeEmbedding(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== config.CV_CLIP_DIM) return undefined;
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    out.push(n);
  }
  return out;
}

/** Embed a query string for semantic search (sidecar /v1/embed-text). */
export async function embedText(text: string): Promise<number[]> {
  if (!config.CV_SIDECAR_URL) throw new CvSidecarError('CV_SIDECAR_URL is not configured');
  let res: Response;
  try {
    res = await fetch(`${config.CV_SIDECAR_URL}/v1/embed-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.CV_SIDECAR_TOKEN ? { Authorization: `Bearer ${config.CV_SIDECAR_TOKEN}` } : {}),
      },
      body: JSON.stringify({ text: text.slice(0, 512) }),
      signal: AbortSignal.timeout(config.CV_SIDECAR_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CvSidecarError(`sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new CvSidecarError(`embed-text error: ${res.status}`, res.status);
  const json = (await res.json()) as { embedding?: unknown };
  const vec = sanitizeEmbedding(json.embedding);
  if (!vec) throw new CvSidecarError('embed-text returned an invalid embedding');
  return vec;
}

/**
 * ALLOWLIST sanitizer. Returns ONLY anonymous aggregates. Anything not on the
 * list — raw tracker_id, embeddings, plate strings, appearance prose, unknown
 * future fields — is dropped by construction. Tracks survive only as anonymous
 * aggregates keyed by an opaque trackKey (never the raw tracker_id).
 */
export function sanitizeCvResult(raw: unknown): CvAnalytics {
  const r = (raw ?? {}) as Record<string, unknown>;

  const counts: Record<string, number> = {};
  if (r.counts && typeof r.counts === 'object') {
    for (const [k, v] of Object.entries(r.counts as Record<string, unknown>)) {
      const key = String(k).toLowerCase();
      const n = Math.max(0, Math.trunc(Number(v)));
      if (CLASS_NAME_RE.test(key) && Number.isFinite(n)) counts[key] = n;
    }
  }

  const crowdDensity: CrowdDensity = CROWD_DENSITIES.includes(r.crowd_density as CrowdDensity)
    ? (r.crowd_density as CrowdDensity)
    : 'empty';

  const intCounts = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object') {
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
        const key = String(k).toLowerCase();
        const num = Math.max(0, Math.trunc(Number(n)));
        if (CLASS_NAME_RE.test(key) && Number.isFinite(num)) out[key] = num;
      }
    }
    return out;
  };

  const zones: CvZoneResult[] = Array.isArray(r.zones)
    ? (r.zones as unknown[]).map((z) => {
        const zo = (z ?? {}) as Record<string, unknown>;
        const peak = zo.peak_occupancy != null ? Math.max(0, Math.trunc(Number(zo.peak_occupancy) || 0)) : undefined;
        const out: CvZoneResult = {
          id: String(zo.id ?? '').slice(0, 64),
          occupancy: Math.max(0, Math.trunc(Number(zo.occupancy ?? zo.peak_occupancy) || 0)),
        };
        if (peak != null) out.peakOccupancy = peak;
        if (typeof zo.name === 'string') out.name = zo.name.slice(0, 64);
        if (zo.class_counts) out.classCounts = intCounts(zo.class_counts);
        return out;
      })
    : [];

  const lines: CvLineResult[] = Array.isArray(r.lines)
    ? (r.lines as unknown[]).map((l) => {
        const lo = (l ?? {}) as Record<string, unknown>;
        const out: CvLineResult = {
          id: String(lo.id ?? '').slice(0, 64),
          in: Math.max(0, Math.trunc(Number(lo.in) || 0)),
          out: Math.max(0, Math.trunc(Number(lo.out) || 0)),
        };
        if (typeof lo.name === 'string') out.name = lo.name.slice(0, 64);
        if (lo.per_class && typeof lo.per_class === 'object') {
          const pc: Record<string, { in: number; out: number }> = {};
          for (const [k, v] of Object.entries(lo.per_class as Record<string, unknown>)) {
            const key = String(k).toLowerCase();
            if (!CLASS_NAME_RE.test(key)) continue;
            const vo = (v ?? {}) as Record<string, unknown>;
            pc[key] = { in: Math.max(0, Math.trunc(Number(vo.in) || 0)), out: Math.max(0, Math.trunc(Number(vo.out) || 0)) };
          }
          out.perClass = pc;
        }
        return out;
      })
    : [];

  // Tracks: anonymous aggregates ONLY. We build a fresh object with the
  // allowlisted fields, so a raw tracker_id / embedding cannot ride through even
  // if the sidecar includes one.
  const tracks: CvTrack[] = Array.isArray(r.tracks)
    ? (r.tracks as unknown[])
        .map((t) => {
          const to = (t ?? {}) as Record<string, unknown>;
          const label = String(to.label ?? '').toLowerCase();
          if (!CLASS_NAME_RE.test(label)) return null;
          const track: CvTrack = {
            trackKey: String(to.track_key ?? '').replace(/[^a-f0-9]/gi, '').slice(0, 40),
            label,
            topScore: Math.min(1, Math.max(0, Number(to.top_score) || 0)),
            framesSeen: Math.max(0, Math.trunc(Number(to.frames_seen) || 0)),
            firstSeenMs: Math.max(0, Math.trunc(Number(to.first_seen_ms) || 0)),
            lastSeenMs: Math.max(0, Math.trunc(Number(to.last_seen_ms) || 0)),
            zonesEntered: Array.isArray(to.zones_entered)
              ? (to.zones_entered as unknown[]).map((x) => String(x).slice(0, 64)).slice(0, 32)
              : [],
            edgeTouched: to.edge_touched === true,
          };
          const dwell = Number(to.max_dwell_sec);
          if (Number.isFinite(dwell) && dwell > 0) track.maxDwellSec = dwell;
          const speed = Number(to.speed_kmh);
          if (Number.isFinite(speed) && speed >= 0) track.speedKmh = Math.round(speed * 10) / 10;
          const heading = Number(to.heading_deg);
          if (Number.isFinite(heading)) track.headingDeg = Math.round(heading);
          // Strict "BXxBY" shape only — a plate/appearance string can't satisfy it.
          if (typeof to.bbox_bucket === 'string' && /^\d{1,2}x\d{1,2}$/.test(to.bbox_bucket)) {
            track.bboxBucket = to.bbox_bucket;
          }
          return track;
        })
        .filter((t): t is CvTrack => t !== null)
    : [];

  const anomalyRaw = (r.anomaly ?? {}) as Record<string, unknown>;
  const reasons: CvAnomalyReason[] = Array.isArray(anomalyRaw.reasons)
    ? (anomalyRaw.reasons as unknown[])
        .map((x) => String(x))
        .filter((x): x is CvAnomalyReason => ANOMALY_REASONS.includes(x as CvAnomalyReason))
    : [];

  const sceneRaw = (r.scene ?? {}) as Record<string, unknown>;
  const activityLevel = ACTIVITY_LEVELS.includes(sceneRaw.activity_level as (typeof ACTIVITY_LEVELS)[number])
    ? (sceneRaw.activity_level as 'low' | 'medium' | 'high')
    : 'low';

  const dwell = Number(r.dwellMaxSec ?? r.dwell_max_sec);

  let clip: CvAnalytics['clip'];
  if (r.clip_meta && typeof r.clip_meta === 'object') {
    const cm = r.clip_meta as Record<string, unknown>;
    clip = {
      fps: Math.max(0, Number(cm.fps) || 0),
      frames: Math.max(0, Math.trunc(Number(cm.frames) || 0)),
      durationSec: Math.max(0, Number(cm.duration_sec) || 0),
    };
  }

  const peakPerson = Number(r.peak_person);

  return {
    counts,
    ...(Number.isFinite(peakPerson) && peakPerson >= 0 ? { peakPerson: Math.trunc(peakPerson) } : {}),
    crowdDensity,
    zones,
    lines,
    tracks,
    ...(Number.isFinite(dwell) && dwell > 0 ? { dwellMaxSec: dwell } : {}),
    anomaly: { detected: anomalyRaw.detected === true || reasons.length > 0, reasons },
    scene: { activityLevel },
    model: typeof r.model === 'string' ? r.model.slice(0, 40) : 'unknown',
    framesAnalyzed: Math.max(1, Math.trunc(Number(r.frames_analyzed) || 1)),
    ...(clip ? { clip } : {}),
  };
}

/**
 * Deterministic, PII-free, ASCII summary sentence built purely from the
 * sanitized aggregates. This is the ONLY text that becomes event content (and
 * is therefore the only thing embedded, dedupe-hashed, and injected into the
 * Samaritan digest). No sidecar-supplied string is ever copied in.
 */
export function buildCvSummaryText(cv: CvAnalytics): string {
  const parts: string[] = [];

  const countParts = Object.entries(cv.counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${n} ${pluralize(k, n)}`);

  parts.push(countParts.length ? countParts.join(', ') : 'no people or vehicles detected');

  for (const z of cv.zones) {
    if (z.occupancy > 0) parts.push(`zone ${z.id} occupancy ${z.occupancy}`);
  }
  for (const l of cv.lines) {
    if (l.in || l.out) parts.push(`line ${l.id} in ${l.in} out ${l.out}`);
  }
  if (cv.dwellMaxSec) parts.push(`max dwell ${Math.round(cv.dwellMaxSec)}s`);
  if (cv.crowdDensity !== 'empty') parts.push(`crowd ${cv.crowdDensity}`);
  if (cv.anomaly.detected && cv.anomaly.reasons.length) parts.push(`anomaly: ${cv.anomaly.reasons.join('/')}`);

  return parts.join('; ');
}

/** Short PII-free title, e.g. "3 people, 1 car". Anomalies are prefixed. */
export function buildCvTitle(cv: CvAnalytics, sourceName: string): string {
  const top = Object.entries(cv.counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, n]) => `${n} ${pluralize(k, n)}`)
    .join(', ');
  const head = top || 'scene update';
  const prefix = cv.anomaly.detected ? 'ALERT ' : '';
  return `${prefix}${head} - ${sourceName}`;
}

function pluralize(word: string, n: number): string {
  if (n === 1) return word;
  if (word === 'person') return 'people';
  if (word.endsWith('s')) return word;
  return `${word}s`;
}

export function parseDetectClasses(): string[] | undefined {
  if (!config.CV_DETECT_CLASSES) return undefined;
  const list = config.CV_DETECT_CLASSES.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : undefined;
}
