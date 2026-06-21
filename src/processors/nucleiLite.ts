import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

interface NucleiTemplate {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  name: string;
  paths: string[];
  matchers: Array<{
    type: 'status' | 'word' | 'regex';
    condition?: 'and' | 'or';
    status?: number[];
    words?: string[];
    regex?: RegExp[];
    part?: 'body' | 'header' | 'all';
  }>;
}

const TEMPLATES: NucleiTemplate[] = [
  {
    id: 'phpmyadmin-panel',
    severity: 'medium',
    name: 'phpMyAdmin Panel Exposed',
    paths: ['/phpmyadmin', '/phpMyAdmin', '/pma', '/admin'],
    matchers: [
      { type: 'word', words: ['phpMyAdmin', 'pma_username'], part: 'body' },
    ],
  },
  {
    id: 'wordpress-login',
    severity: 'info',
    name: 'WordPress Login Panel',
    paths: ['/wp-login.php', '/wp-admin'],
    matchers: [
      { type: 'word', words: ['wp-login.php', 'WordPress'], part: 'body' },
    ],
  },
  {
    id: 'jenkins-panel',
    severity: 'medium',
    name: 'Jenkins Panel Exposed',
    paths: ['/login', '/jenkins', '/manage'],
    matchers: [
      { type: 'word', words: ['Jenkins', ' Hudson '], part: 'body' },
    ],
  },
  {
    id: 'grafana-panel',
    severity: 'medium',
    name: 'Grafana Panel Exposed',
    paths: ['/login', '/grafana'],
    matchers: [
      { type: 'word', words: ['Grafana', 'grafana_app'], part: 'body' },
    ],
  },
  {
    id: 'kibana-panel',
    severity: 'medium',
    name: 'Kibana Panel Exposed',
    paths: ['/app/kibana', '/login'],
    matchers: [
      { type: 'word', words: ['kibana', 'Elastic'], part: 'body' },
    ],
  },
  {
    id: 'elastic-search',
    severity: 'high',
    name: 'Elasticsearch Unprotected',
    paths: ['/', '/_cluster/health'],
    matchers: [
      { type: 'word', words: ['cluster_name', 'elasticsearch'], part: 'body' },
    ],
  },
  {
    id: 'mongodb-unauth',
    severity: 'critical',
    name: 'MongoDB Unauthenticated',
    paths: ['/'],
    matchers: [
      { type: 'word', words: ['MongoDB', '"ok" : 1'], part: 'body' },
    ],
  },
  {
    id: 'redis-unauth',
    severity: 'critical',
    name: 'Redis Unauthenticated',
    paths: ['/'],
    matchers: [
      { type: 'word', words: ['redis_version'], part: 'body' },
    ],
  },
  {
    id: 'docker-api',
    severity: 'high',
    name: 'Docker API Exposed',
    paths: ['/v1.24/containers/json', '/version'],
    matchers: [
      { type: 'word', words: ['Containers', 'Docker'], part: 'body' },
    ],
  },
  {
    id: 'kubernetes-api',
    severity: 'critical',
    name: 'Kubernetes API Exposed',
    paths: ['/api', '/api/v1'],
    matchers: [
      { type: 'word', words: ['apiVersion', 'kind'], part: 'body' },
      { type: 'status', status: [200] },
    ],
  },
  {
    id: 'prometheus-panel',
    severity: 'medium',
    name: 'Prometheus Panel Exposed',
    paths: ['/graph', '/'],
    matchers: [
      { type: 'word', words: ['Prometheus', 'prometheus_build_info'], part: 'body' },
    ],
  },
  {
    id: 'swagger-api',
    severity: 'low',
    name: 'Swagger API Docs Exposed',
    paths: ['/swagger-ui.html', '/api-docs', '/swagger.json', '/v2/api-docs', '/v3/api-docs'],
    matchers: [
      { type: 'word', words: ['swagger', 'openapi'], part: 'body' },
    ],
  },
  {
    id: 'actuator-endpoint',
    severity: 'high',
    name: 'Spring Boot Actuator Exposed',
    paths: ['/actuator/env', '/actuator/health', '/actuator/info'],
    matchers: [
      { type: 'word', words: ['actuator', '"status"'], part: 'body' },
    ],
  },
  {
    id: 'git-config',
    severity: 'high',
    name: 'Git Config Exposed',
    paths: ['/.git/config'],
    matchers: [
      { type: 'word', words: ['[core]', 'repositoryformatversion'], part: 'body' },
    ],
  },
  {
    id: 'env-file',
    severity: 'critical',
    name: 'Environment File Exposed',
    paths: ['/.env', '/.env.local', '/.env.production'],
    matchers: [
      { type: 'word', words: ['DB_PASSWORD', 'SECRET_KEY', 'API_KEY', 'DATABASE_URL'], part: 'body' },
    ],
  },
];

export async function runNucleiLite(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_NUCLEI_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const targets = extractTargets(event);
  if (targets.length === 0) return;

  for (const target of targets) {
    await scanTarget(target, event.id);
  }
}

function extractTargets(event: IntelligenceEvent): string[] {
  const targets: string[] = [];
  const tags = event.tags;

  if (typeof tags.domain === 'string') targets.push(tags.domain);
  if (typeof tags.url === 'string') {
    try {
      const u = new URL(tags.url);
      targets.push(u.origin);
    } catch {
      targets.push(tags.url);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'domain' && typeof e.value === 'string') targets.push(e.value);
      if ((e.type === 'ipv4' || e.type === 'ipv6') && typeof e.value === 'string') targets.push(`http://${e.value}`);
    }
  }

  return [...new Set(targets)];
}

async function scanTarget(target: string, parentEventId: string): Promise<void> {
  const base = target.startsWith('http') ? target : `http://${target}`;

  for (const template of TEMPLATES) {
    for (const path of template.paths) {
      try {
        const url = `${base}${path}`;
        const res = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        });

        const body = await res.text().catch(() => '');
        const headers = res.headers;

        const matched = checkMatchers(template, res.status, body, headers);
        if (matched) {
          await createReconEvent({
            title: `${template.name}`,
            content: `Template: ${template.id}\nSeverity: ${template.severity}\nTarget: ${base}\nPath: ${path}\nStatus: ${res.status}`,
            tags: {
              recon_source: 'nuclei',
              recon_type: 'template_match',
              parent_event_id: parentEventId,
              target: base,
              path,
              template_id: template.id,
              severity: template.severity,
              status: res.status,
            },
          });
          reconHourlyCount++;
        }
      } catch {
        // ignore per-template failures
      }
    }
  }
}

function checkMatchers(template: NucleiTemplate, status: number, body: string, headers: Headers): boolean {
  if (!template.matchers || template.matchers.length === 0) return false;

  for (const matcher of template.matchers) {
    let match = false;

    if (matcher.type === 'status') {
      match = matcher.status?.includes(status) ?? false;
    } else if (matcher.type === 'word') {
      const text = matcher.part === 'header' ? headers.toString() : body;
      match = matcher.words?.some((w) => text.includes(w)) ?? false;
    } else if (matcher.type === 'regex') {
      const text = matcher.part === 'header' ? headers.toString() : body;
      match = matcher.regex?.some((r) => r.test(text)) ?? false;
    }

    // For simplicity, we treat all matchers as OR within a template
    if (match) return true;
  }

  return false;
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
      'recon_nuclei',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.8,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
