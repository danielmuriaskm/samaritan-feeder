import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

interface ProbeDef {
  name: string;
  url: string;
  errorType: 'status_code' | 'message';
  errorMsg?: string;
  successStatus?: number;
}

// Platform probe definitions — 80 popular platforms
const PROBES: ProbeDef[] = [
  { name: 'Twitter / X', url: 'https://x.com/{username}', errorType: 'message', errorMsg: 'This account doesn\'t exist' },
  { name: 'Instagram', url: 'https://www.instagram.com/{username}/', errorType: 'message', errorMsg: 'Sorry, this page isn\'t available' },
  { name: 'Reddit', url: 'https://www.reddit.com/user/{username}/', errorType: 'status_code', successStatus: 200 },
  { name: 'GitHub', url: 'https://github.com/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'TikTok', url: 'https://www.tiktok.com/@{username}', errorType: 'message', errorMsg: 'Couldn\'t find this account' },
  { name: 'YouTube', url: 'https://www.youtube.com/@{username}', errorType: 'message', errorMsg: 'Not found' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com/in/{username}/', errorType: 'status_code', successStatus: 200 },
  { name: 'Facebook', url: 'https://www.facebook.com/{username}', errorType: 'message', errorMsg: 'This page isn\'t available' },
  { name: 'Pinterest', url: 'https://www.pinterest.com/{username}/', errorType: 'message', errorMsg: 'not found' },
  { name: 'Tumblr', url: 'https://{username}.tumblr.com', errorType: 'status_code', successStatus: 200 },
  { name: 'Twitch', url: 'https://www.twitch.tv/{username}', errorType: 'message', errorMsg: 'Sorry. Unless you\'ve got a time machine' },
  { name: 'Steam', url: 'https://steamcommunity.com/id/{username}', errorType: 'message', errorMsg: 'The specified profile could not be found' },
  { name: 'Spotify', url: 'https://open.spotify.com/user/{username}', errorType: 'message', errorMsg: 'Page not found' },
  { name: 'SoundCloud', url: 'https://soundcloud.com/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Medium', url: 'https://medium.com/@{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'DeviantArt', url: 'https://www.deviantart.com/{username}', errorType: 'message', errorMsg: 'DeviantArt - The largest online art gallery' },
  { name: 'Behance', url: 'https://www.behance.net/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Dribbble', url: 'https://dribbble.com/{username}', errorType: 'message', errorMsg: 'Whoops, that page is gone' },
  { name: 'Vimeo', url: 'https://vimeo.com/{username}', errorType: 'message', errorMsg: 'Page Not Found' },
  { name: 'Flickr', url: 'https://www.flickr.com/people/{username}/', errorType: 'status_code', successStatus: 200 },
  { name: 'Goodreads', url: 'https://www.goodreads.com/{username}', errorType: 'message', errorMsg: 'not found' },
  { name: 'Strava', url: 'https://www.strava.com/athletes/{username}', errorType: 'message', errorMsg: 'Page Not Found' },
  { name: 'Gravatar', url: 'https://en.gravatar.com/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Keybase', url: 'https://keybase.io/{username}', errorType: 'message', errorMsg: 'user not found' },
  { name: 'About.me', url: 'https://about.me/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Patreon', url: 'https://www.patreon.com/{username}', errorType: 'message', errorMsg: 'Page Not Found' },
  { name: 'Ko-fi', url: 'https://ko-fi.com/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Product Hunt', url: 'https://www.producthunt.com/@{username}', errorType: 'message', errorMsg: 'Page not found' },
  { name: 'Indie Hackers', url: 'https://www.indiehackers.com/{username}', errorType: 'message', errorMsg: 'Page not found' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/user?id={username}', errorType: 'message', errorMsg: 'No such user' },
  { name: 'GitLab', url: 'https://gitlab.com/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Bitbucket', url: 'https://bitbucket.org/{username}/', errorType: 'message', errorMsg: 'Page not found' },
  { name: 'Docker Hub', url: 'https://hub.docker.com/u/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'NPM', url: 'https://www.npmjs.com/~{username}', errorType: 'message', errorMsg: 'Not found' },
  { name: 'PyPI', url: 'https://pypi.org/user/{username}/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'RubyGems', url: 'https://rubygems.org/profiles/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Crates.io', url: 'https://crates.io/users/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Packagist', url: 'https://packagist.org/users/{username}/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'NuGet', url: 'https://www.nuget.org/profiles/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Maven Central', url: 'https://search.maven.org/search?q=g:{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'SourceForge', url: 'https://sourceforge.net/u/{username}/profile/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Codecademy', url: 'https://www.codecademy.com/profiles/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Codewars', url: 'https://www.codewars.com/users/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'LeetCode', url: 'https://leetcode.com/{username}/', errorType: 'message', errorMsg: 'Page Not Found' },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com/users/{username}', errorType: 'message', errorMsg: 'Page Not Found' },
  { name: 'TryHackMe', url: 'https://tryhackme.com/p/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'HackTheBox', url: 'https://app.hackthebox.com/users/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Replit', url: 'https://replit.com/@{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Glitch', url: 'https://glitch.com/@{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'CodePen', url: 'https://codepen.io/{username}', errorType: 'message', errorMsg: 'Page Not Found' },
  { name: 'JSFiddle', url: 'https://jsfiddle.net/user/{username}/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Vercel', url: 'https://vercel.com/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Netlify', url: 'https://app.netlify.com/teams/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Heroku', url: 'https://dashboard.heroku.com/apps/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'DigitalOcean', url: 'https://cloud.digitalocean.com/apps/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Linode', url: 'https://cloud.linode.com/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Namecheap', url: 'https://www.namecheap.com/myaccount/login.aspx', errorType: 'status_code', successStatus: 200 },
  { name: 'GoDaddy', url: 'https://www.godaddy.com/domainsearch/find?domainToCheck={username}.com', errorType: 'status_code', successStatus: 200 },
  { name: 'Bandcamp', url: 'https://{username}.bandcamp.com', errorType: 'status_code', successStatus: 200 },
  { name: 'Mixcloud', url: 'https://www.mixcloud.com/{username}/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Kaggle', url: 'https://www.kaggle.com/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Duolingo', url: 'https://www.duolingo.com/profile/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'MyAnimeList', url: 'https://myanimelist.net/profile/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'AniList', url: 'https://anilist.co/user/{username}/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Letterboxd', url: 'https://letterboxd.com/{username}/', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Trakt', url: 'https://trakt.tv/users/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Untappd', url: 'https://untappd.com/user/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Discogs', url: 'https://www.discogs.com/user/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Last.fm', url: 'https://www.last.fm/user/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Snapchat', url: 'https://www.snapchat.com/add/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Telegram', url: 'https://t.me/{username}', errorType: 'message', errorMsg: 'If you have Telegram, you can contact' },
  { name: 'WhatsApp', url: 'https://wa.me/{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Signal', url: 'https://signal.me/#p/+{username}', errorType: 'status_code', successStatus: 200 },
  { name: 'Mastodon', url: 'https://mastodon.social/@{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Bluesky', url: 'https://bsky.app/profile/{username}.bsky.social', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Threads', url: 'https://www.threads.net/@{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Kick', url: 'https://kick.com/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Rumble', url: 'https://rumble.com/c/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Odysee', url: 'https://odysee.com/@{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Substack', url: 'https://{username}.substack.com', errorType: 'status_code', successStatus: 200 },
  { name: 'Hashnode', url: 'https://hashnode.com/@{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Dev.to', url: 'https://dev.to/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Ghost', url: 'https://{username}.ghost.io', errorType: 'status_code', successStatus: 200 },
  { name: 'Notion', url: 'https://www.notion.so/{username}', errorType: 'message', errorMsg: 'Not Found' },
  { name: 'Carrd', url: 'https://{username}.carrd.co', errorType: 'status_code', successStatus: 200 },
  ];

export class SherlockAdapter extends BaseAdapter {
  readonly kind = 'sherlock' as const;
  readonly name = 'Sherlock (Username Probe)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.username !== 'string' || config.username.length === 0) {
      errors.push('config.username is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const username = String(config.username).trim();
    const maxProbes = typeof config.maxProbes === 'number' ? config.maxProbes : PROBES.length;
    const sourceId = String(config.sourceId ?? `sherlock_${username}`);
    const since = cursor ? Number(cursor) : 0;

    const probes = PROBES.slice(0, Math.min(maxProbes, PROBES.length));
    const found: Array<{ name: string; url: string }> = [];
    const notFound: Array<{ name: string; url: string }> = [];

    // Probe with concurrency limit of 15
    const concurrency = 15;
    for (let i = 0; i < probes.length; i += concurrency) {
      const batch = probes.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((probe) => this.checkPlatform(username, probe)),
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const probe = batch[j];
        const url = probe.url.replace(/{username}/g, encodeURIComponent(username));
        if (result.status === 'fulfilled' && result.value) {
          found.push({ name: probe.name, url });
        } else {
          notFound.push({ name: probe.name, url });
        }
      }
    }

    if (found.length === 0) {
      return [];
    }

    const eventAt = Date.now();
    if (eventAt <= since) return [];

    return [
      this.makeEvent(
        {
          kind: 'alert',
          title: `Sherlock: ${username} found on ${found.length} platforms`,
          content: [
            `Username: ${username}`,
            `Platforms found: ${found.length} / ${probes.length}`,
            '',
            ...found.map((f) => `- ${f.name}: ${f.url}`),
          ].join('\n'),
          eventAt,
          confidence: Math.min(1, 0.5 + found.length * 0.01),
          tags: {
            username,
            found_count: found.length,
            total_probes: probes.length,
            found: found.map((f) => ({ name: f.name, url: f.url })),
            not_found: notFound.map((f) => f.name),
          },
        },
        sourceId,
      ),
    ];
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const username = String(config.username || 'test');
    const url = `https://github.com/${encodeURIComponent(username)}`;
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok || res.status === 404, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private async checkPlatform(username: string, probe: ProbeDef): Promise<boolean> {
    const url = probe.url.replace(/{username}/g, encodeURIComponent(username));
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });

      if (probe.errorType === 'status_code') {
        const successStatus = probe.successStatus ?? 200;
        return res.status === successStatus;
      }

      // message-based detection
      const text = await res.text();
      if (probe.errorMsg && text.includes(probe.errorMsg)) {
        return false;
      }
      // If no error message found, assume it exists (but this can yield false positives)
      // Better heuristic: check for common "not found" patterns
      const notFoundPatterns = ['not found', 'page not found', '404', "doesn't exist", "couldn't find", 'sorry', 'error', 'gone', 'no such'];
      const lowerText = text.toLowerCase();
      for (const pattern of notFoundPatterns) {
        if (lowerText.includes(pattern)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
