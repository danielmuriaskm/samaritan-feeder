import type { SourceKind } from '../types.js';

/**
 * Source trust tiers — the feeder's OWN editorial classification of how much to
 * trust each source kind by default. Higher tier = more authoritative => its
 * events rank higher and need fewer corroborating sources to be believed.
 *
 * Tier 1 — authoritative / direct instrument: official hazard & gov feeds, and
 *          technical scanners that report ground truth (an open port is an open port).
 * Tier 2 — established editorial / direct observation: curated press, live cameras.
 * Tier 3 — social platforms (first-party but unverified, high noise).
 * Tier 4 — scraped / anonymous / unattributed.
 *
 * Clean-room: these tiers and numbers are this project's choices. A per-source
 * override may live in `intelligence_sources.config.trustTier` later.
 */
export type SourceTier = 1 | 2 | 3 | 4;

const TIER_BY_KIND: Record<SourceKind, SourceTier> = {
  // Tier 1 — authoritative / instrument
  usgs: 1, eonet: 1, gdacs: 1, nws: 1, reliefweb: 1, ngamsi: 1, stix: 1,
  shodan: 1, censys: 1, crtsh: 1, virustotal: 1, hibp: 1, greynoise: 1, urlscan: 1, abusech: 1,
  // Tier 2 — established editorial / direct observation
  rss: 2, news_api: 2, gdelt: 2, hn: 2, arxiv: 2, github: 2, youtube: 2,
  webcam: 2, traffic_cam: 2, weather_cam: 2, ip_camera: 2, windy: 2,
  // Tier 3 — social
  twitter: 3, reddit: 3, bluesky: 3, instagram: 3, tiktok: 3, telegram: 3, discord: 3,
  // Tier 4 — scraped / anonymous
  twitter_scrape: 4, reddit_scrape: 4, sherlock: 4, pastebin: 4, gist: 4,
  darksearch: 4, webcrawl: 4,
};

const TRUST_BY_TIER: Record<SourceTier, number> = { 1: 0.9, 2: 0.7, 3: 0.5, 4: 0.3 };

export function tierForKind(kind: SourceKind): SourceTier {
  return TIER_BY_KIND[kind] ?? 3;
}

/** Default 0..1 trust for a source kind, before any per-source override. */
export function trustForTier(tier: SourceTier): number {
  return TRUST_BY_TIER[tier];
}
