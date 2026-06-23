import { RssAdapter } from './rss.js';
import { WebcamAdapter } from './webcam.js';
import { RedditAdapter } from './reddit.js';
import { HnAdapter } from './hn.js';
import { TwitterAdapter } from './twitter.js';
import { InstagramAdapter } from './instagram.js';
import { IpCameraAdapter } from './ipcamera.js';
import { TrafficCamAdapter } from './trafficcam.js';
import { WeatherCamAdapter } from './weathercam.js';
import { WindyAdapter } from './windy.js';
import { BlueskyAdapter } from './bluesky.js';
import { YouTubeAdapter } from './youtube.js';
import { TikTokAdapter } from './tiktok.js';
import { TelegramAdapter } from './telegram.js';
import { DiscordAdapter } from './discord.js';
import { ShodanAdapter } from './shodan.js';
import { CensysAdapter } from './censys.js';
import { CrtshAdapter } from './crtsh.js';
import { VirusTotalAdapter } from './virustotal.js';
import { HibpAdapter } from './hibp.js';
import { WebcrawlAdapter } from './webcrawl.js';
import { TwitterScrapeAdapter } from './twitter_scrape.js';
import { RedditScrapeAdapter } from './reddit_scrape.js';
import { SherlockAdapter } from './sherlock.js';
import { UrlscanAdapter } from './urlscan.js';
import { PastebinAdapter } from './pastebin.js';
import { GistAdapter } from './gist.js';
import { DarksearchAdapter } from './darksearch.js';
import { GreynoiseAdapter } from './greynoise.js';
import { StixAdapter } from './stix.js';
import { UsgsAdapter } from './usgs.js';
import { EonetAdapter } from './eonet.js';
import { GdacsAdapter } from './gdacs.js';
import { NwsAdapter } from './nws.js';
import { AbusechAdapter } from './abusech.js';
import { NgaMsiAdapter } from './ngamsi.js';
import { ReliefWebAdapter } from './reliefweb.js';
import { GdeltAdapter } from './gdelt.js';
import { ArxivAdapter } from './arxiv.js';
import { NvdAdapter } from './nvd.js';
import { OpenphishAdapter } from './openphish.js';
import { ZonehAdapter } from './zoneh.js';
import type { SourceAdapter, SourceKind } from '../types.js';

const registry = new Map<SourceKind, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  registry.set(adapter.kind, adapter);
}

export function getAdapter(kind: SourceKind): SourceAdapter | undefined {
  return registry.get(kind);
}

export function listAdapters(): SourceAdapter[] {
  return Array.from(registry.values());
}

// Bootstrap
registerAdapter(new RssAdapter());
registerAdapter(new WebcamAdapter());
registerAdapter(new RedditAdapter());
registerAdapter(new HnAdapter());
registerAdapter(new TwitterAdapter());
registerAdapter(new InstagramAdapter());
registerAdapter(new IpCameraAdapter());
registerAdapter(new TrafficCamAdapter());
registerAdapter(new WeatherCamAdapter());
registerAdapter(new WindyAdapter());
registerAdapter(new BlueskyAdapter());
registerAdapter(new YouTubeAdapter());
registerAdapter(new TikTokAdapter());
registerAdapter(new TelegramAdapter());
registerAdapter(new DiscordAdapter());
registerAdapter(new ShodanAdapter());
registerAdapter(new CensysAdapter());
registerAdapter(new CrtshAdapter());
registerAdapter(new VirusTotalAdapter());
registerAdapter(new HibpAdapter());
registerAdapter(new WebcrawlAdapter());
registerAdapter(new TwitterScrapeAdapter());
registerAdapter(new RedditScrapeAdapter());
registerAdapter(new SherlockAdapter());
registerAdapter(new UrlscanAdapter());
registerAdapter(new PastebinAdapter());
registerAdapter(new GistAdapter());
registerAdapter(new DarksearchAdapter());
registerAdapter(new GreynoiseAdapter());
registerAdapter(new StixAdapter());
// 005: structured authoritative hazard/conflict/cyber/maritime feeds (free, clean-room).
registerAdapter(new UsgsAdapter());
registerAdapter(new EonetAdapter());
registerAdapter(new GdacsAdapter());
registerAdapter(new NwsAdapter());
registerAdapter(new AbusechAdapter());
registerAdapter(new NgaMsiAdapter());
registerAdapter(new ReliefWebAdapter());
registerAdapter(new GdeltAdapter());
// arXiv (Atom over the export API) + NVD CVE (JSON REST v2) — fixes the silent feeds.
registerAdapter(new ArxivAdapter());
registerAdapter(new NvdAdapter());
// Phishing IOC firehoses (keyless) + Zone-H defacement RSS (SpiderFoot-inspired ports, MIT).
registerAdapter(new OpenphishAdapter());
registerAdapter(new ZonehAdapter());
