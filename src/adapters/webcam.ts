import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { detectMotion, getCachedFrame, setCachedFrame } from '../processors/motion.js';
import { processVisionFrame } from '../processors/vision.js';

const exec = promisify(execCb);

export class WebcamAdapter extends BaseAdapter {
  readonly kind = 'webcam';
  readonly name = 'Webcam / MJPEG Stream';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.url !== 'string' || !config.url.startsWith('http')) {
      errors.push('config.url must be a valid MJPEG or HLS URL');
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
    const url = String(config.url);
    const sourceId = String(config.sourceId ?? 'webcam_unknown');
    const frameInterval = typeof config.frameIntervalSeconds === 'number' ? config.frameIntervalSeconds : 60;
    const motionThreshold = typeof config.motionThreshold === 'number' ? config.motionThreshold : 0.05;
    const name = String(config.name ?? sourceId);

    const lastPolled = typeof config.lastPolledAt === 'number' ? config.lastPolledAt : 0;
    const now = Date.now();
    if (now - lastPolled < frameInterval * 1000) {
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

    // Vision LLM analysis
    const frameBase64 = frameBuffer.toString('base64');
    const visionResult = await processVisionFrame({
      frameBase64,
      sourceName: name,
      previousDescription: config.lastDescription as string | undefined,
    });

    // Store last description in config for temporal comparison
    if (visionResult.tags && typeof visionResult.tags === 'object') {
      (config as Record<string, unknown>).lastDescription = visionResult.content;
    }

    return [
      this.makeEvent(
        {
          kind: visionResult.tags?.anomaly_detected === true ? 'anomaly' : 'visual',
          title: visionResult.title,
          content: visionResult.content,
          rawData: {
            frameBase64: frameBase64.slice(0, 200) + '...',
            motionScore,
            hasMotion,
          },
          mediaUrls: [url],
          eventAt: now,
          confidence: visionResult.confidence,
          tags: {
            ...visionResult.tags,
            frameInterval,
            motionThreshold,
            motionScore,
          },
        },
        sourceId,
      ),
    ];
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const url = String(config.url);
    const start = performance.now();
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private async extractFrame(url: string): Promise<Buffer | null> {
    try {
      const { stdout } = await exec(
        `ffmpeg -i "${url}" -ss 00:00:00.1 -vframes 1 -f image2 -v error -`,
        { timeout: 15000, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  }
}
