import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

const TOP_PORTS = [
  { port: 80, name: 'HTTP', proto: 'http' },
  { port: 443, name: 'HTTPS', proto: 'https' },
  { port: 22, name: 'SSH', proto: 'tcp' },
  { port: 21, name: 'FTP', proto: 'tcp' },
  { port: 25, name: 'SMTP', proto: 'tcp' },
  { port: 53, name: 'DNS', proto: 'tcp' },
  { port: 110, name: 'POP3', proto: 'tcp' },
  { port: 143, name: 'IMAP', proto: 'tcp' },
  { port: 3306, name: 'MySQL', proto: 'tcp' },
  { port: 5432, name: 'PostgreSQL', proto: 'tcp' },
  { port: 3389, name: 'RDP', proto: 'tcp' },
  { port: 5900, name: 'VNC', proto: 'tcp' },
  { port: 8080, name: 'HTTP-Alt', proto: 'http' },
  { port: 8443, name: 'HTTPS-Alt', proto: 'https' },
  { port: 8888, name: 'HTTP-Alt2', proto: 'http' },
  { port: 3000, name: 'Dev', proto: 'http' },
  { port: 5000, name: 'Flask', proto: 'http' },
  { port: 8000, name: 'Django', proto: 'http' },
  { port: 9200, name: 'Elasticsearch', proto: 'http' },
  { port: 27017, name: 'MongoDB', proto: 'tcp' },
  { port: 6379, name: 'Redis', proto: 'tcp' },
  { port: 5672, name: 'RabbitMQ', proto: 'tcp' },
  { port: 11211, name: 'Memcached', proto: 'tcp' },
  { port: 23, name: 'Telnet', proto: 'tcp' },
  { port: 445, name: 'SMB', proto: 'tcp' },
  { port: 139, name: 'NetBIOS', proto: 'tcp' },
  { port: 2049, name: 'NFS', proto: 'tcp' },
  { port: 1521, name: 'Oracle', proto: 'tcp' },
  { port: 1433, name: 'MSSQL', proto: 'tcp' },
  { port: 33060, name: 'MySQL-X', proto: 'tcp' },
];

export async function runPortProbe(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_PORT_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const ips = extractIps(event);
  if (ips.length === 0) return;

  for (const ip of ips) {
    await probePorts(ip, event.id);
  }
}

function extractIps(event: IntelligenceEvent): string[] {
  const ips: string[] = [];
  const tags = event.tags;

  if (typeof tags.ip === 'string') ips.push(tags.ip);
  if (Array.isArray(tags.ips)) {
    for (const ip of tags.ips) {
      if (typeof ip === 'string') ips.push(ip);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && (e.type === 'ipv4' || e.type === 'ipv6') && typeof e.value === 'string') {
        ips.push(e.value);
      }
    }
  }

  return [...new Set(ips)];
}

async function probePorts(ip: string, parentEventId: string): Promise<void> {
  const open: Array<{ port: number; name: string; banner?: string }> = [];

  // Process in batches of 5 to avoid overwhelming
  const batchSize = 5;
  for (let i = 0; i < TOP_PORTS.length; i += batchSize) {
    const batch = TOP_PORTS.slice(i, i + batchSize);
    const promises = batch.map(async (p) => {
      try {
        if (p.proto === 'http') {
          const httpRes = await fetch(`http://${ip}:${p.port}`, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          });
          if (httpRes.status < 500) {
            const server = httpRes.headers.get('server') || undefined;
            return { port: p.port, name: p.name, banner: server ? `Server: ${server}` : undefined };
          }
        } else if (p.proto === 'https') {
          const res = await fetch(`https://${ip}:${p.port}`, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          });
          if (res.status < 500) {
            const server = res.headers.get('server') || undefined;
            return { port: p.port, name: p.name, banner: server ? `Server: ${server}` : undefined };
          }
        } else {
          // For raw TCP, try a socket connect via fetch to a non-HTTP endpoint
          // We use a trick: fetch to http://ip:port and see if it connects (even if 400/404)
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            await fetch(`http://${ip}:${p.port}`, {
              method: 'HEAD',
              signal: controller.signal,
            });
            clearTimeout(timeout);
            // Any response (including 400/404) means port is open
            return { port: p.port, name: p.name };
          } catch (err) {
            clearTimeout(timeout);
            // TypeError on connection refused vs abort
            if (err instanceof Error && err.name === 'AbortError') {
              // timeout = possibly filtered
              return null;
            }
            // Other errors = connection refused
            return null;
          }
        }
      } catch {
        // ignore
      }
      return null;
    });

    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) {
        open.push(s.value);
      }
    }
  }

  if (open.length === 0) return;

  const contentLines = [
    `Port scan results for ${ip}`,
    '',
    ...open.map((o) => `- ${o.port}/${o.name}${o.banner ? ` (${o.banner})` : ''}`),
  ];

  await createReconEvent({
    title: `Open ports: ${ip}`,
    content: contentLines.join('\n'),
    tags: {
      recon_source: 'port',
      recon_type: 'port_probe',
      parent_event_id: parentEventId,
      ip,
      open_ports: open.map((o) => o.port),
      port_details: open,
    },
  });
  reconHourlyCount++;
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
      'recon_port',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.75,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
