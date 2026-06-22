// Single source of truth for the worldmonitor-style "ops console" palette.
//
// Two consumers can't share CSS variables: the React DOM (which CAN read `var(--wm-*)`
// from theme.css) and the runtime string-builders — the <canvas> in GraphView, the
// Leaflet `divIcon` HTML in MapView, and per-row computed colors (score pills, severity
// dots, heat cells). Those build color strings in JS and cannot see CSS vars, so they
// read from here. Keep this file dependency-free (it gets pulled into the lazy graph
// chunk). The hexes here MUST mirror the `:root` block in theme.css.

export const colors = {
  // surfaces
  base: '#0a0a0a',
  bg2: '#111111',
  panel: '#141414',
  hover: '#1e1e1e',
  // lines
  border: '#2a2a2a',
  borderStrong: '#444444',
  borderSubtle: '#1a1a1a',
  // text
  text: '#e8e8e8',
  text2: '#cccccc',
  dim: '#888888',
  muted: '#666666',
  // accent + neon semantics
  accent: '#ffffff',
  critical: '#ff4444',
  high: '#ff8800',
  elevated: '#ffaa00',
  normal: '#44aa44',
  low: '#3388ff',
  info: '#3b82f6',
  live: '#44ff88', // positive / live
  // category accents (non-severity hues kept minimal & neon)
  purple: '#b48cff',
  teal: '#44ffcc',
  pink: '#ff4488',
  // map
  mapBg: '#020a08',
} as const;

export const fonts = {
  sans: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
} as const;

// ----- Consolidated color maps (previously duplicated & divergent across components) -----
// Canonical mapping to neon semantics; collapsing the old per-component maps here
// deliberately normalizes a few badge colors.

export const kindColors: Record<string, string> = {
  visual: colors.low, // blue
  text: colors.normal, // green
  anomaly: colors.high, // orange
  alert: colors.critical, // red (most severe)
  detection: colors.elevated, // amber
  social_post: colors.purple,
};

export const signalColors: Record<string, string> = {
  convergence: colors.low,
  geo_convergence: colors.teal,
  velocity_spike: colors.high,
  silent_source: colors.dim,
  volume_anomaly: colors.pink,
  cluster_surge: colors.critical,
};

export const healthColors: Record<string, string> = {
  healthy: colors.live,
  degraded: colors.elevated,
  silent: colors.high,
  failing: colors.critical,
  cooldown: '#cc3333',
};

export const entityColors: Record<string, string> = {
  ip: colors.critical,
  domain: colors.low,
  email: colors.purple,
  hash: colors.elevated,
  url: colors.live,
  cve: colors.high,
  org: colors.teal,
  person: colors.pink,
  event: colors.dim,
  default: colors.dim,
};

export const channelColors: Record<string, string> = {
  telegram: colors.low,
  discord: colors.purple,
  slack: colors.normal,
  webhook: colors.dim,
  email: colors.elevated,
  samaritan: colors.live,
};

// MapView source/category accents — generic neon mapping; MapView may extend.
export const categoryColors: Record<string, string> = {
  traffic: colors.high,
  traffic_cam: colors.high,
  beach: colors.low,
  weather: colors.teal,
  weather_cam: colors.teal,
  webcam: colors.low,
  ip_camera: colors.purple,
  alert: colors.critical,
  anomaly: colors.high,
  default: colors.live,
};

// Color-grade a 0..1 importance score: green (low) -> amber -> orange -> red (high).
export function scoreColor(score: number): string {
  if (score >= 0.75) return colors.critical;
  if (score >= 0.5) return colors.high;
  if (score >= 0.25) return colors.elevated;
  return colors.normal;
}

// hex (#rrggbb) -> "r, g, b" for rgba() composition (heat cells, glows).
export function rgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
