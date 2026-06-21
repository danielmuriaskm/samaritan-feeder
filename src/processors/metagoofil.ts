import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'];

/**
 * Metagoofil-style domain-wide document metadata hunter.
 * Searches for documents on a target domain, fetches them,
 * and extracts metadata (author, creator, producer, etc.).
 */
export async function runMetagoofil(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_DOMAIN_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const domains = extractDomains(event);
  if (domains.length === 0) return;

  for (const domain of domains) {
    await huntDocuments(domain, event.id);
  }
}

function extractDomains(event: IntelligenceEvent): string[] {
  const domains: string[] = [];
  const tags = event.tags;

  if (typeof tags.domain === 'string') domains.push(tags.domain);
  if (Array.isArray(tags.domains)) {
    for (const d of tags.domains) {
      if (typeof d === 'string') domains.push(d);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && e.type === 'domain' && typeof e.value === 'string') {
        domains.push(e.value);
      }
    }
  }

  return [...new Set(domains)];
}

async function huntDocuments(domain: string, parentEventId: string): Promise<void> {
  const foundDocs: Array<{
    url: string;
    ext: string;
    metadata: Record<string, string>;
  }> = [];

  for (const ext of DOC_EXTENSIONS) {
    try {
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(`site:${domain} filetype:${ext}`)}&count=20`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) continue;
      const html = await res.text();

      // Extract document URLs from Bing results
      const urlRegex = new RegExp(`https?://[a-zA-Z0-9.-]*${domain.replace(/\./g, '\\.')}/[^"<>\\s]+\\.${ext}`, 'gi');
      const matches = html.matchAll(urlRegex);
      const seen = new Set<string>();

      for (const m of matches) {
        const url = m[0];
        if (seen.has(url)) continue;
        seen.add(url);

        const meta = await extractDocMetadata(url, ext);
        if (Object.keys(meta).length > 0) {
          foundDocs.push({ url, ext, metadata: meta });
        }

        if (foundDocs.length >= 10) break;
      }

      if (foundDocs.length >= 10) break;
    } catch {
      // ignore per-extension failures
    }
  }

  if (foundDocs.length === 0) return;

  for (const doc of foundDocs) {
    await createReconEvent({
      title: `Metagoofil: ${doc.ext.toUpperCase()} on ${domain}`,
      content: `Document found on ${domain}:\nURL: ${doc.url}\nType: ${doc.ext}\n\nMetadata:\n${Object.entries(doc.metadata).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
      tags: {
        recon_source: 'metagoofil',
        recon_type: 'document_metadata',
        parent_event_id: parentEventId,
        domain,
        doc_url: doc.url,
        doc_type: doc.ext,
        doc_metadata: doc.metadata,
      },
    });
    reconHourlyCount++;
  }
}

async function extractDocMetadata(url: string, ext: string): Promise<Record<string, string>> {
  const meta: Record<string, string> = {};

  try {
    if (ext === 'pdf') {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-50000' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return meta;
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('latin1').decode(buf);

      const patterns: Record<string, RegExp> = {
        Author: /\/Author\s*\(([^)]+)\)/,
        Creator: /\/Creator\s*\(([^)]+)\)/,
        Producer: /\/Producer\s*\(([^)]+)\)/,
        Title: /\/Title\s*\(([^)]+)\)/,
      };

      for (const [key, regex] of Object.entries(patterns)) {
        const match = text.match(regex);
        if (match) meta[key] = match[1];
      }
    } else {
      // For DOCX/PPTX/XLSX: these are ZIP files with XML metadata
      // We already have fflate for this in documentMeta.ts
      // For Metagoofil we do a lightweight approach: check HTTP headers
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const server = res.headers.get('server');
        const lastMod = res.headers.get('last-modified');
        const contentType = res.headers.get('content-type');
        if (server) meta['Server'] = server;
        if (lastMod) meta['Last-Modified'] = lastMod;
        if (contentType) meta['Content-Type'] = contentType;
      }
    }
  } catch {
    // ignore
  }

  return meta;
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
      'recon_metagoofil',
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
