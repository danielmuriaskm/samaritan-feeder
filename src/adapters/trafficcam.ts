import { WebcamAdapter } from './webcam.js';

/**
 * Traffic Camera Adapter
 *
 * Shares the WebcamAdapter pipeline (frame extraction, motion gate, CV sidecar
 * detection). Registered separately so traffic cams — the prime use case for
 * line-crossing / flow analytics — are first-class in the source registry.
 * Without this, the scheduler logs "No adapter for kind: traffic_cam" and the
 * many EU traffic feeds the feeder already wants to poll go unprocessed.
 */
export class TrafficCamAdapter extends WebcamAdapter {
  readonly kind = 'traffic_cam' as const;
  readonly name = 'Traffic Camera';
}
