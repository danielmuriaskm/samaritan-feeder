import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Strict boolean flag. Unlike `z.coerce.boolean()` (which treats the string
 * "false" as truthy), only true/1/yes/on enable the flag. Critical for the
 * privacy ALLOW_* flags, where an accidental "false" must NOT enable a
 * biometric capability.
 */
const boolFlag = (def: boolean) =>
  z.preprocess((v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
    return def;
  }, z.boolean());

const schema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  /** Enable TLS for Postgres (required by Supabase/managed PG). Relaxed verify
   * (rejectUnauthorized:false) since managed poolers present their own CA. */
  DATABASE_SSL: boolFlag(false),
  SAMARITAN_BASE_URL: z.string().url().default('http://localhost:3001'),
  SAMARITAN_AUTH_TOKEN: z.string().min(1),
  REDIS_URL: z.string().optional(),

  // ----- Operator console / API access control (app layer; pair with Fly-private) -----
  /** HTTP Basic password gating the browser console + API. Unset => gate disabled
   * (allow-all) with a warning, for local dev; set it in prod. */
  CONSOLE_PASSWORD: z.string().optional(),
  /** Basic username (default 'operator'). */
  CONSOLE_USER: z.string().default('operator'),
  /** Bearer token for server-to-server callers (Samaritan radar/discovery, /ingest);
   * sent as `Authorization: Bearer <token>`, bypasses the Basic console challenge. */
  FEEDER_SERVICE_TOKEN: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  FEEDER_ENCRYPTION_KEY: z.string().min(32).optional(),
  MAX_EVENTS_PER_SOURCE_PER_HOUR: z.coerce.number().default(100),
  DEFAULT_RETENTION_DAYS: z.coerce.number().default(30),
  RAW_DATA_RETENTION_DAYS: z.coerce.number().default(7),
  WINDY_API_KEY: z.string().optional(),
  WINDY_API_KEY2: z.string().optional(),
  SHODAN_API_KEY: z.string().optional(),
  CENSYS_API_ID: z.string().optional(),
  CENSYS_API_SECRET: z.string().optional(),
  VIRUSTOTAL_API_KEY: z.string().optional(),
  HIBP_API_KEY: z.string().optional(),
  RECON_DOMAIN_ENABLED: z.coerce.boolean().default(false),
  RECON_IP_ENABLED: z.coerce.boolean().default(false),
  RECON_EMAIL_ENABLED: z.coerce.boolean().default(false),
  RECON_MAX_EVENTS_PER_HOUR: z.coerce.number().default(50),
  URLSCAN_API_KEY: z.string().optional(),
  DARKSEARCH_API_KEY: z.string().optional(),
  GREYNOISE_API_KEY: z.string().optional(),
  PASSIVETOTAL_API_KEY: z.string().optional(),
  PASSIVETOTAL_USERNAME: z.string().optional(),
  RECON_COMBO_ENABLED: z.coerce.boolean().default(false),
  RECON_SECRET_ENABLED: z.coerce.boolean().default(false),
  RECON_GIT_ENABLED: z.coerce.boolean().default(false),
  RECON_TYPO_ENABLED: z.coerce.boolean().default(false),
  RECON_PORT_ENABLED: z.coerce.boolean().default(false),
  RECON_NUCLEI_ENABLED: z.coerce.boolean().default(false),
  RECON_OSIC_ENABLED: z.coerce.boolean().default(false),
  RECON_YARA_ENABLED: z.coerce.boolean().default(false),
  RECON_CERT_MONITOR_ENABLED: z.coerce.boolean().default(false),

  // ----- Computer-vision sidecar (video intelligence) -----
  CV_ENABLED: boolFlag(false),
  CV_SIDECAR_URL: z.string().url().optional(),
  CV_SIDECAR_TOKEN: z.string().optional(),
  CV_SIDECAR_TIMEOUT_MS: z.coerce.number().default(25000),
  CV_MIN_SCORE: z.coerce.number().default(0.35),
  /** Comma-separated COCO class names to count; empty = people+vehicles default. */
  CV_DETECT_CLASSES: z.string().optional(),
  CV_CROWD_THRESHOLD: z.coerce.number().default(25),
  /** If true and region != EU, run the demoted vision LLM on the REDACTED thumbnail. */
  CV_LLM_ENRICH: boolFlag(false),
  /** When the sidecar is unreachable, fall back to the legacy single-frame LLM path. */
  CV_FALLBACK_TO_LLM: boolFlag(false),
  /** Default clip duration (seconds) pulled for tracking/line-crossing (P1). */
  CV_CLIP_SECONDS: z.coerce.number().default(4),
  /** Sampled fps of the clip; passed to the tracker so frame_rate is correct. */
  CV_SAMPLED_FPS: z.coerce.number().default(6),
  /** A track must be seen this many frames to be confirmed (debounce). */
  CV_CONFIRM_FRAMES: z.coerce.number().default(2),
  /** Optional go2rtc normalization proxy base URL (P1, optional). */
  GO2RTC_URL: z.string().url().optional(),
  /** Window (ms) for cross-clip track reconciliation (parked-object dedupe). */
  CV_TRACK_DEDUPE_WINDOW_MS: z.coerce.number().default(5 * 60 * 1000),
  /** Store a REDACTED best-frame artifact on alert events (P2). Off by default. */
  CV_STORE_ARTIFACTS: boolFlag(false),
  /** Semantic search: CLIP-embed REDACTED alert frames into pgvector. Off by
   * default — needs the optional 004 migration + a pgvector Postgres image. */
  CV_SEMANTIC_SEARCH: boolFlag(false),
  /** CLIP embedding dimension (must match the sidecar's CV_CLIP_DIM / model). */
  CV_CLIP_DIM: z.coerce.number().default(512),

  /**
   * SSRF escape hatch for the ffmpeg/yt-dlp stream path: allow private/reserved
   * stream hosts (e.g. a camera on the operator's LAN). Off by default — a
   * source-supplied streamUrl must not reach internal addresses.
   */
  ALLOW_PRIVATE_STREAM_URLS: boolFlag(false),

  // ----- Privacy / compliance guards (safe defaults) -----
  VISION_REDACT_BEFORE_STORE: boolFlag(true),
  VISION_PERSIST_RAW_FRAMES: boolFlag(false),
  CV_EU_HARD_GATE: boolFlag(true),
  ALLOW_FACE_RECOGNITION: boolFlag(false),
  ALLOW_PLATE_OCR: boolFlag(false),
  ALLOW_PERSON_REID: boolFlag(false),
  ALLOW_CROSS_CAMERA_TRACKING: boolFlag(false),
  PERSIST_TRACKER_IDS: boolFlag(false),
});

/** *_API_KEYS are derived from comma-separated *_API_KEY values (key-pool rotation). */
export type Config = z.infer<typeof schema> & { LLM_API_KEYS: string[]; EMBEDDING_API_KEYS: string[] };

const splitKeys = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid feeder configuration:\n${issues}`);
  }
  // Allow LLM_API_KEY / EMBEDDING_API_KEY to each hold several comma-separated keys
  // (e.g. multiple Ollama Cloud or Jina free accounts) — the chat and embedding
  // paths round-robin + fail over across their own pool.
  return {
    ...parsed.data,
    LLM_API_KEYS: splitKeys(parsed.data.LLM_API_KEY),
    EMBEDDING_API_KEYS: splitKeys(parsed.data.EMBEDDING_API_KEY),
  };
}

export const config = load();
