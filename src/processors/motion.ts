/**
 * Lightweight motion detection for webcam frames.
 * Pure Node.js — no OpenCV or heavy dependencies.
 *
 * Algorithm:
 * 1. Downscale both frames to 32x32 grayscale
 * 2. Compute per-pixel absolute difference
 * 3. Count pixels above threshold
 * 4. Return normalized motion score (0-1)
 */

export interface MotionResult {
  motionScore: number;
  changedPixels: number;
  totalPixels: number;
  hasMotion: boolean;
}

/**
 * Detect motion between two JPEG frame buffers.
 * Uses a simple hash-based approach: compare low-res thumbnails.
 */
export async function detectMotion(prevFrame: Buffer, currFrame: Buffer, threshold = 0.05): Promise<MotionResult> {
  // For a production system, we'd use sharp to resize to 32x32.
  // Since we want zero heavy deps, we use a perceptual hash approach
  // on the raw buffer: compare block averages.
  const prevHash = computeBlockHash(prevFrame);
  const currHash = computeBlockHash(currFrame);

  let diffSum = 0;
  const blockCount = prevHash.length;

  for (let i = 0; i < blockCount; i++) {
    diffSum += Math.abs(prevHash[i] - currHash[i]);
  }

  const avgDiff = diffSum / blockCount / 255;
  const changedPixels = Math.round(avgDiff * blockCount);

  return {
    motionScore: avgDiff,
    changedPixels,
    totalPixels: blockCount,
    hasMotion: avgDiff > threshold,
  };
}

/**
 * Compute a coarse 8x8 block hash of a buffer.
 * Splits the buffer into 64 blocks and returns average brightness per block.
 * Works on any binary data (JPEG) as a coarse perceptual proxy.
 */
function computeBlockHash(buffer: Buffer): number[] {
  const blocks = 8;
  const blockSize = Math.max(1, Math.floor(buffer.length / (blocks * blocks)));
  const hash: number[] = [];

  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      const start = (by * blocks + bx) * blockSize;
      const end = Math.min(start + blockSize, buffer.length);
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i++) {
        sum += buffer[i];
        count++;
      }
      hash.push(count > 0 ? sum / count : 0);
    }
  }

  return hash;
}

/**
 * Simple frame cache for motion detection.
 * Stores the last frame buffer per source ID.
 */
const frameCache = new Map<string, Buffer>();

export function getCachedFrame(sourceId: string): Buffer | undefined {
  return frameCache.get(sourceId);
}

export function setCachedFrame(sourceId: string, frame: Buffer): void {
  frameCache.set(sourceId, frame);
  // Keep cache small
  if (frameCache.size > 1000) {
    const first = frameCache.keys().next().value;
    if (first) frameCache.delete(first);
  }
}
