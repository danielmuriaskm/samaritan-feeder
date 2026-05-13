import { RssAdapter } from './rss.js';
import { WebcamAdapter } from './webcam.js';
import { RedditAdapter } from './reddit.js';
import { HnAdapter } from './hn.js';
import { TwitterAdapter } from './twitter.js';
import { InstagramAdapter } from './instagram.js';
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
