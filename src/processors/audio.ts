/**
 * Live audio transcription from video streams.
 * Extracts audio via ffmpeg, transcribes via Whisper API.
 */

import { config } from '../config.js';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const exec = promisify(execCb);

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

/**
 * Extract audio from a video stream URL and transcribe it.
 * Uses ffmpeg to extract a short audio clip, then Whisper API for transcription.
 */
export async function transcribeStreamAudio(
  streamUrl: string,
  durationSeconds = 30,
): Promise<TranscriptionResult | null> {
  if (!config.LLM_API_KEY) {
    console.warn('[audio] No LLM_API_KEY configured for Whisper');
    return null;
  }

  const tmpId = randomUUID();
  const audioPath = join(tmpdir(), `feeder_audio_${tmpId}.mp3`);

  try {
    // Extract audio from stream using ffmpeg
    await exec(
      `ffmpeg -i "${streamUrl}" -t ${durationSeconds} -vn -ar 16000 -ac 1 -c:a libmp3lame -q:a 4 "${audioPath}"`,
      { timeout: 60000 },
    );

    // Read audio file
    const audioBuffer = await import('fs/promises').then((fs) => fs.readFile(audioPath));

    // Transcribe via Whisper API (OpenAI-compatible)
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const res = await fetch(`${config.LLM_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.LLM_API_KEY}`,
      },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Whisper API error: ${res.status} ${text}`);
    }

    const json = (await res.json()) as { text?: string; language?: string; duration?: number; segments?: unknown[] };

    return {
      text: json.text ?? '',
      language: json.language,
      duration: json.duration,
    };
  } catch (err) {
    console.error('[audio] Transcription failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    // Clean up temp file
    try {
      await unlink(audioPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Transcribe a raw audio buffer directly (for when audio is already extracted).
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  mimeType = 'audio/mp3',
): Promise<TranscriptionResult | null> {
  if (!config.LLM_API_KEY) {
    return null;
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio.mp3');
    formData.append('model', 'whisper-1');

    const res = await fetch(`${config.LLM_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.LLM_API_KEY}`,
      },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      throw new Error(`Whisper API error: ${res.status}`);
    }

    const json = (await res.json()) as { text?: string; language?: string };
    return { text: json.text ?? '' };
  } catch (err) {
    console.error('[audio] Buffer transcription failed:', err);
    return null;
  }
}
