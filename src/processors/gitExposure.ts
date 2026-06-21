import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

const GIT_PATHS = ['.git/HEAD', '.git/config', '.git/logs/HEAD', '.git/index'];

export async function runGitExposureCheck(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_GIT_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const targets = extractTargets(event);
  if (targets.length === 0) return;

  for (const target of targets) {
    await checkGitExposure(target, event.id);
  }
}

function extractTargets(event: IntelligenceEvent): string[] {
  const targets: string[] = [];
  const tags = event.tags;

  if (typeof tags.domain === 'string') targets.push(tags.domain);
  if (typeof tags.url === 'string') {
    try {
      const u = new URL(tags.url);
      targets.push(u.hostname);
    } catch {
      // ignore
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'domain' && typeof e.value === 'string') targets.push(e.value);
    }
  }

  // Also extract domains from content
  const domainRegex = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;
  const text = `${event.title ?? ''} ${event.content}`;
  const matches = text.matchAll(domainRegex);
  for (const m of matches) {
    targets.push(m[0].toLowerCase());
  }

  return [...new Set(targets)];
}

async function checkGitExposure(domain: string, parentEventId: string): Promise<void> {
  const protocols = ['https', 'http'];
  const exposedPaths: Array<{ path: string; evidence: string; url: string }> = [];

  for (const proto of protocols) {
    const base = `${proto}://${domain}`;

    for (const path of GIT_PATHS) {
      try {
        const url = `${base}/${path}`;
        const res = await fetch(url, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        });

        if (res.status === 200) {
          // HEAD may not return body, try GET for evidence
          const getRes = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
          });
          if (getRes.ok) {
            const body = await getRes.text();
            const evidence = extractEvidence(path, body);
            if (evidence) {
              exposedPaths.push({ path, evidence, url });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (exposedPaths.length > 0) break; // stop if we found exposure on this protocol
  }

  if (exposedPaths.length === 0) return;

  const contentLines = [
    `Exposed .git directory detected on ${domain}`,
    '',
    ...exposedPaths.map((p) => `- ${p.path}: ${p.evidence} (${p.url})`),
    '',
    'Reconstruction possible via: git-dumper or wget --mirror',
  ];

  await createReconEvent({
    title: `Exposed .git: ${domain}`,
    content: contentLines.join('\n'),
    tags: {
      recon_source: 'git',
      recon_type: 'git_exposure',
      parent_event_id: parentEventId,
      domain,
      exposed_paths: exposedPaths.map((p) => p.path),
      evidence: exposedPaths.map((p) => p.evidence),
    },
  });
  reconHourlyCount++;
}

function extractEvidence(path: string, body: string): string | undefined {
  if (path === '.git/HEAD') {
    const match = body.match(/ref: refs\/heads\/(\S+)/);
    if (match) return `branch: ${match[1]}`;
  }
  if (path === '.git/config') {
    if (body.includes('repositoryformatversion')) return 'valid git config';
  }
  if (path === '.git/logs/HEAD') {
    const lines = body.trim().split('\n');
    if (lines.length > 0) return `${lines.length} commit log entries`;
  }
  if (path === '.git/index') {
    if (body.startsWith('DIRC')) return 'valid git index';
  }
  return undefined;
}

async function createReconEvent(partial: {
  title: string;
  content: string;
  tags: Record<string, unknown>;
}): Promise<void> {
  const id = `recon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await exec(
    `INSERT INTO intelligence_events
     (id, source_id, kind, title, content, tags, confidence, sensitivity, event_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      'recon_git',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.85,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
