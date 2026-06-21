import { WebcamAdapter } from './webcam.js';

/**
 * Weather Camera Adapter
 *
 * Shares the WebcamAdapter pipeline. Registered separately so weather/scenic
 * cams are first-class in the source registry (previously "No adapter for kind:
 * weather_cam"). CV scene/activity aggregates and crowd density are the
 * relevant signals here.
 */
export class WeatherCamAdapter extends WebcamAdapter {
  readonly kind = 'weather_cam' as const;
  readonly name = 'Weather / Scenic Camera';
}
