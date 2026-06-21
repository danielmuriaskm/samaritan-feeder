import { BaseAdapter } from './base.js';
import type { RawEvent, SourceKind, CvSourceConfig, CvAnalytics } from '../types.js';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import { detectMotion, getCachedFrame, setCachedFrame } from '../processors/motion.js';
import { processVisionFrame } from '../processors/vision.js';
import { config as appConfig } from '../config.js';
import {
  analyzeFrame,
  analyzeClip,
  buildCvSummaryText,
  buildCvTitle,
  parseDetectClasses,
  CvSidecarError,
} from '../processors/detection.js';
import { evaluateAlertRules, buildAlertText, hasPushSeverity } from '../processors/alertRules.js';
import { safeFetch, assertEgressAllowed, STREAM_URL_SCHEMES, SsrfError } from '../util/safeFetch.js';

// Run media tools without a shell (argv array) — no string interpolation, so a
// crafted streamUrl can't inject shell metacharacters.
const execFile = promisify(execFileCb);

/**
 * ffmpeg `-protocol_whitelist`: transport/streaming protocols only. Critically
 * EXCLUDES file, pipe, concat, subfile, data, gopher — so even if the URL check
 * were bypassed, ffmpeg refuses to treat a stream URL as a local-file read.
 */
const FFMPEG_PROTOCOL_WHITELIST = 'rtsp,rtp,rtcp,srtp,udp,udplite,tcp,tls,http,https,crypto';

export class WebcamAdapter extends BaseAdapter {
  readonly kind: SourceKind = 'webcam';
  readonly name: string = 'Webcam / MJPEG Stream';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const streamUrl = (config.streamUrl ?? config.url) as string | undefined;
    const streamType = (config.streamType ?? 'image') as string;

    if (typeof streamUrl !== 'string' || !(streamUrl.startsWith('http') || streamUrl.startsWith('rtsp'))) {
      errors.push('config.streamUrl (or config.url) must be a valid HTTP(S) or RTSP URL');
    }
    if (streamType === 'youtube' && !this.hasYtDlp()) {
      errors.push('streamType "youtube" requires yt-dlp to be installed');
    }
    if (config.frameIntervalSeconds !== undefined && typeof config.frameIntervalSeconds !== 'number') {
      errors.push('config.frameIntervalSeconds must be a number');
    }
    if (config.motionThreshold !== undefined && typeof config.motionThreshold !== 'number') {
      errors.push('config.motionThreshold must be a number (0-1)');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, _cursor?: string): Promise<RawEvent[]> {
    const rawUrl = String(config.streamUrl ?? config.url ?? '');
    const streamType = String(config.streamType ?? 'image');
    const sourceId = String(config.sourceId ?? 'webcam_unknown');
    const frameInterval = typeof config.frameIntervalSeconds === 'number' ? config.frameIntervalSeconds : 60;
    const motionThreshold = typeof config.motionThreshold === 'number' ? config.motionThreshold : 0.05;
    const name = String(config.name ?? sourceId);

    if (!rawUrl || !(rawUrl.startsWith('http') || rawUrl.startsWith('rtsp'))) {
      return [];
    }

    const lastPolled = typeof config.lastPolledAt === 'number' ? config.lastPolledAt : 0;
    const now = Date.now();
    if (now - lastPolled < frameInterval * 1000) {
      return [];
    }

    let url: string | null = rawUrl;
    if (streamType === 'youtube') {
      url = await this.resolveYouTubeUrl(rawUrl);
    } else if (streamType === 'rtsp') {
      // ffmpeg handles RTSP natively, no resolution needed
      url = rawUrl;
    }
    if (!url) {
      return [];
    }

    const frameBuffer = await this.extractFrame(url);
    if (!frameBuffer || frameBuffer.length === 0) {
      return [];
    }

    // Motion detection against cached previous frame
    const prevFrame = getCachedFrame(sourceId);
    let motionScore = 0.5; // default: analyze if no previous frame
    let hasMotion = true;

    if (prevFrame) {
      const motion = await detectMotion(prevFrame, frameBuffer, motionThreshold);
      motionScore = motion.motionScore;
      hasMotion = motion.hasMotion;
    }

    // Cache current frame for next poll
    setCachedFrame(sourceId, frameBuffer);

    if (!hasMotion) {
      return [];
    }

    const frameBase64 = frameBuffer.toString('base64');

    // Preferred path: real CPU object detection via the CV sidecar.
    if (appConfig.CV_ENABLED && appConfig.CV_SIDECAR_URL) {
      try {
        return await this.runCvPath({
          frameBase64,
          rawUrl,
          clipUrl: url,
          sourceId,
          name,
          config,
          motionScore,
          streamType,
          frameInterval,
          now,
        });
      } catch (err) {
        const msg = err instanceof CvSidecarError ? err.message : String(err);
        console.warn(`[webcam] CV sidecar failed for ${sourceId}: ${msg}`);
        if (!appConfig.CV_FALLBACK_TO_LLM) {
          return []; // skip this poll; next cycle retries
        }
        // else fall through to the legacy LLM path
      }
    }

    return this.runLegacyVision({ frameBase64, rawUrl, sourceId, name, config, motionScore, hasMotion, streamType, frameInterval, motionThreshold, now });
  }

  /** CV sidecar path: detection -> anonymous aggregates -> one RawEvent. */
  private async runCvPath(opts: {
    frameBase64: string;
    rawUrl: string;
    clipUrl: string;
    sourceId: string;
    name: string;
    config: Record<string, unknown>;
    motionScore: number;
    streamType: string;
    frameInterval: number;
    now: number;
  }): Promise<RawEvent[]> {
    const cvCfg = (opts.config.cv ?? {}) as CvSourceConfig;
    const region = cvCfg.region ?? (opts.config.region as CvSourceConfig['region']) ?? 'unknown';

    // EU hard-gate: never request a thumbnail / LLM enrichment for EU sources
    // (or when region is unknown and the gate is on — fail closed).
    const euGated = appConfig.CV_EU_HARD_GATE && region !== 'non_EU';
    const wantThumbnail = appConfig.CV_LLM_ENRICH && !euGated;

    // Clip mode (P1): pull a short clip from the resolved stream URL for tracking
    // + line crossings + dwell. Only for real video streams (a static jpeg has no
    // temporal continuity). Falls back to single-frame otherwise.
    const clipMode = cvCfg.clipMode === true && opts.streamType !== 'image';

    let cv: CvAnalytics;
    let thumbnailBase64: string | undefined;
    let alertArtifact: string | undefined;
    let alertEmbedding: number[] | undefined;
    if (clipMode) {
      const hasRules = (cvCfg.rules?.length ?? 0) > 0;
      // Both the redacted artifact and the CLIP embedding derive from the
      // redacted alert frame: opt-in, rules-only, and EU-gated (fail-closed).
      const wantArtifact = appConfig.CV_STORE_ARTIFACTS && !euGated && hasRules;
      const wantEmbedding = appConfig.CV_SEMANTIC_SEARCH && !euGated && hasRules;
      const clip = await analyzeClip({
        sourceId: opts.sourceId,
        clipUrl: opts.clipUrl,
        region,
        sampledFps: cvCfg.sampledFps ?? appConfig.CV_SAMPLED_FPS,
        maxSeconds: cvCfg.clipSeconds ?? appConfig.CV_CLIP_SECONDS,
        clipStartMs: opts.now,
        detectClasses: cvCfg.watchClasses ?? parseDetectClasses(),
        zones: cvCfg.zones,
        lines: cvCfg.lines,
        speed: cvCfg.speed,
        wantArtifact,
        wantEmbedding,
      });
      cv = clip.cv;
      alertArtifact = clip.artifactBase64;
      alertEmbedding = clip.embeddingVector;
    } else {
      const frame = await analyzeFrame({
        sourceId: opts.sourceId,
        frameBase64: opts.frameBase64,
        region,
        detectClasses: cvCfg.watchClasses ?? parseDetectClasses(),
        zones: cvCfg.zones,
        wantThumbnail,
      });
      cv = frame.cv;
      thumbnailBase64 = frame.thumbnailBase64;
    }

    // Optional LLM scene enrichment — ONLY on the redacted thumbnail, never EU.
    if (wantThumbnail && thumbnailBase64) {
      try {
        const enrich = await processVisionFrame({ frameBase64: thumbnailBase64, sourceName: opts.name });
        if (typeof enrich.tags?.weather_conditions === 'string') cv.scene.weather = enrich.tags.weather_conditions as string;
        if (typeof enrich.tags?.scene_label === 'string') cv.scene.label = enrich.tags.scene_label as string;
      } catch (err) {
        console.warn(`[webcam] LLM enrichment failed for ${opts.sourceId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const hasCounts = Object.values(cv.counts).some((n) => n > 0);
    const countsKey = Object.entries(cv.counts)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k}:${n}`)
      .join(',');
    const bucket = Math.floor(opts.now / Math.max(1000, opts.frameInterval * 1000));

    // Alert-rules layer (P2). A push-worthy firing yields a separate kind:'alert'
    // event; record-only (severity:'detection') firings ride the routine event's
    // tags so they still persist to cv_alerts without pushing a notification.
    const firings = evaluateAlertRules(cv, cvCfg.rules);
    const pushWorthy = firings.length > 0 && hasPushSeverity(firings);
    const recordOnly = firings.length > 0 && !pushWorthy;

    // Routine per-poll analytics record (passive / time series).
    const events: RawEvent[] = [
      this.makeEvent(
        {
          kind: cv.anomaly.detected ? 'anomaly' : clipMode ? 'detection' : 'visual',
          title: buildCvTitle(cv, opts.name),
          content: buildCvSummaryText(cv),
          // No frame bytes persisted — privacy at rest.
          rawData: { framesAnalyzed: cv.framesAnalyzed },
          mediaUrls: [opts.rawUrl],
          eventAt: opts.now,
          confidence: hasCounts ? 0.8 : 0.5,
          tags: {
            cv,
            motionScore: opts.motionScore,
            streamType: opts.streamType,
            frameInterval: opts.frameInterval,
            processor: 'cv-sidecar',
            model: cv.model,
            ...(recordOnly ? { alertFirings: firings } : {}),
          },
          // Time-bucketed dedupe seed so identical consecutive readings still
          // produce one observation per poll window (preserves the time series).
          dedupeContent: `cv:${opts.sourceId}:${countsKey}:${bucket}`,
        },
        opts.sourceId,
      ),
    ];

    if (pushWorthy) {
      const alertText = buildAlertText(firings);
      const firingSig = firings
        .map((f) => `${f.ruleId}:${Math.round(f.value)}`)
        .sort()
        .join(',');
      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `ALERT: ${alertText} - ${opts.name}`.slice(0, 200),
            content: `${buildCvSummaryText(cv)} | alerts: ${alertText}`,
            rawData: { framesAnalyzed: cv.framesAnalyzed },
            mediaUrls: [opts.rawUrl],
            eventAt: opts.now,
            confidence: 0.95,
            tags: { cv, alertFirings: firings, processor: 'cv-alert-rules', model: cv.model },
            dedupeContent: `cvalert:${opts.sourceId}:${firingSig}:${bucket}`,
            // Redacted best-frame + its CLIP embedding (transient — stored in
            // cv_alerts / cv_embeddings, never in the event tags).
            artifactBase64: alertArtifact,
            embeddingVector: alertEmbedding,
          },
          opts.sourceId,
        ),
      );
    }

    return events;
  }

  /** Legacy single-frame vision-LLM path (fallback / when CV is disabled). */
  private async runLegacyVision(opts: {
    frameBase64: string;
    rawUrl: string;
    sourceId: string;
    name: string;
    config: Record<string, unknown>;
    motionScore: number;
    hasMotion: boolean;
    streamType: string;
    frameInterval: number;
    motionThreshold: number;
    now: number;
  }): Promise<RawEvent[]> {
    const visionResult = await processVisionFrame({
      frameBase64: opts.frameBase64,
      sourceName: opts.name,
      previousDescription: opts.config.lastDescription as string | undefined,
    });

    if (visionResult.tags && typeof visionResult.tags === 'object') {
      (opts.config as Record<string, unknown>).lastDescription = visionResult.content;
    }

    return [
      this.makeEvent(
        {
          kind: visionResult.tags?.anomaly_detected === true ? 'anomaly' : 'visual',
          title: visionResult.title,
          content: visionResult.content,
          // No frame bytes persisted (was a truncated, useless base64 fragment).
          rawData: { motionScore: opts.motionScore, hasMotion: opts.hasMotion },
          mediaUrls: [opts.rawUrl],
          eventAt: opts.now,
          confidence: visionResult.confidence,
          tags: {
            ...visionResult.tags,
            frameInterval: opts.frameInterval,
            motionThreshold: opts.motionThreshold,
            motionScore: opts.motionScore,
            streamType: opts.streamType,
          },
        },
        opts.sourceId,
      ),
    ];
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const rawUrl = String(config.streamUrl ?? config.url ?? '');
    const streamType = String(config.streamType ?? 'image');
    const start = performance.now();

    if (!rawUrl || !(rawUrl.startsWith('http') || rawUrl.startsWith('rtsp'))) {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }

    try {
      if (streamType === 'youtube') {
        // For YouTube, try to resolve the stream URL first
        const resolved = await this.resolveYouTubeUrl(rawUrl);
        if (!resolved) {
          return { healthy: false, latencyMs: Math.round(performance.now() - start) };
        }
        const res = await safeFetch(resolved, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
      }

      if (streamType === 'rtsp') {
        // SSRF guard: validate the RTSP host is publicly routable before handing
        // the URL to ffmpeg (which does its own egress).
        if (!(await this.assertStreamUrlSafe(rawUrl))) {
          return { healthy: false, latencyMs: Math.round(performance.now() - start) };
        }
        try {
          await execFile(
            'ffmpeg',
            ['-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST, '-i', rawUrl, '-t', '0.5', '-f', 'null', '-'],
            { timeout: 10000 },
          );
          return { healthy: true, latencyMs: Math.round(performance.now() - start) };
        } catch {
          return { healthy: false, latencyMs: Math.round(performance.now() - start) };
        }
      }

      // SSRF guard: rawUrl is source-supplied (config.streamUrl/config.url), so
      // an HTTP(S) health probe must not be allowed to reach a private/reserved
      // address. (Inherited by IpCameraAdapter.)
      const res = await safeFetch(rawUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  /**
   * SSRF pre-check for any URL we are about to hand to ffmpeg/yt-dlp. Confirms
   * the scheme is a streaming scheme and the host (literal, or every resolved
   * address) is publicly routable. Returns false (and logs) on a blocked URL or
   * unresolvable host; the caller then skips the invocation. RTSP cameras embed
   * credentials, so those are tolerated here. Set ALLOW_PRIVATE_STREAM_URLS to
   * opt in to LAN cameras.
   */
  private async assertStreamUrlSafe(rawUrl: string, schemes: readonly string[] = STREAM_URL_SCHEMES): Promise<boolean> {
    try {
      await assertEgressAllowed(rawUrl, {
        allowedSchemes: schemes,
        allowCredentials: true,
        allowPrivate: appConfig.ALLOW_PRIVATE_STREAM_URLS,
      });
      return true;
    } catch (err) {
      if (err instanceof SsrfError) {
        console.warn(`[webcam] stream URL rejected: ${err.message}`);
        return false;
      }
      throw err;
    }
  }

  private async extractFrame(url: string): Promise<Buffer | null> {
    // The URL may be a source-supplied streamUrl or a yt-dlp-resolved CDN URL —
    // validate egress either way before ffmpeg fetches it.
    if (!(await this.assertStreamUrlSafe(url))) return null;
    try {
      const { stdout } = await execFile(
        'ffmpeg',
        [
          '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
          '-i', url,
          '-ss', '00:00:00.1',
          '-vframes', '1',
          '-f', 'image2',
          '-v', 'error',
          '-',
        ],
        { timeout: 15000, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
      );
      return stdout as Buffer;
    } catch {
      return null;
    }
  }

  private async resolveYouTubeUrl(youtubeUrl: string): Promise<string | null> {
    // yt-dlp must only be pointed at public http(s) — never an internal host.
    if (!(await this.assertStreamUrlSafe(youtubeUrl, ['http:', 'https:']))) return null;
    try {
      const { stdout } = await execFile('yt-dlp', ['-g', '-f', 'best', youtubeUrl], { timeout: 15000 });
      const lines = stdout.toString().trim().split('\n').filter(Boolean);
      return lines[0] ?? null;
    } catch {
      return null;
    }
  }

  private hasYtDlp(): boolean {
    try {
      execFileSync('yt-dlp', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
