import { WebcamAdapter } from './webcam.js';

/**
 * IP Camera Adapter
 *
 * Extends WebcamAdapter with kind = 'ip_camera'.
 * The polling logic (ffmpeg frame extraction, motion detection, vision analysis)
 * is identical to webcam RTSP streams. This adapter exists so that IP cameras
 * can be tracked separately in the source registry and validated explicitly.
 */
export class IpCameraAdapter extends WebcamAdapter {
  readonly kind = 'ip_camera' as const;
  readonly name = 'IP Camera / RTSP';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const base = super.validate(config);
    const streamUrl = String(config.streamUrl ?? config.url ?? '');

    // IP cameras are expected to use RTSP or authenticated HTTP(S)
    if (!streamUrl.startsWith('rtsp')) {
      base.errors.push('IP cameras should use an RTSP streamUrl for best compatibility');
    }

    return { valid: base.errors.length === 0, errors: base.errors };
  }
}
