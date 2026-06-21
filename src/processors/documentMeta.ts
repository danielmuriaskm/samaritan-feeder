import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';
import { unzipSync, strFromU8 } from 'fflate';

const DOC_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.ods', '.odp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export async function extractDocumentMetadata(event: IntelligenceEvent): Promise<void> {
  if (!event.mediaUrls || event.mediaUrls.length === 0) return;

  const docUrls = event.mediaUrls.filter((url) =>
    DOC_EXTENSIONS.some((ext) => url.toLowerCase().endsWith(ext)),
  );

  if (docUrls.length === 0) return;

  for (const url of docUrls) {
    try {
      await processDocument(url, event.id);
    } catch (err) {
      console.error(`[documentMeta] Failed for ${url}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

async function processDocument(url: string, parentEventId: string): Promise<void> {
  // Step 1: HEAD request to check size and headers
  const headRes = await fetch(url, {
    method: 'HEAD',
    signal: AbortSignal.timeout(15000),
  });

  const contentLength = Number(headRes.headers.get('content-length') ?? '0');
  if (contentLength > MAX_FILE_SIZE) {
    console.log(`[documentMeta] Skipping ${url}: ${contentLength} bytes exceeds limit`);
    return;
  }

  const headers: Record<string, string> = {};
  headRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (['last-modified', 'server', 'x-powered-by', 'content-type'].includes(lower)) {
      headers[key] = value;
    }
  });

  // Step 2: Fetch first chunk for metadata extraction
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) return;

  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let metadata: Record<string, unknown> = { url, headers };

  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith('.pdf')) {
    metadata = { ...metadata, ...extractPdfMetadata(bytes) };
  } else if (lowerUrl.endsWith('.docx') || lowerUrl.endsWith('.pptx') || lowerUrl.endsWith('.xlsx')) {
    metadata = { ...metadata, ...extractOfficeMetadata(bytes) };
  } else if (lowerUrl.endsWith('.odt') || lowerUrl.endsWith('.ods') || lowerUrl.endsWith('.odp')) {
    metadata = { ...metadata, ...extractOpenDocumentMetadata(bytes) };
  }

  // Only create event if we found meaningful metadata
  const hasMetadata = Object.keys(metadata).some((k) =>
    !['url', 'headers', 'format'].includes(k),
  );

  if (!hasMetadata) {
    console.log(`[documentMeta] No metadata extracted from ${url}`);
    return;
  }

  // Extract entities from metadata
  const entities: Array<{ type: string; value: string }> = [];
  const textToScan = JSON.stringify(metadata).toLowerCase();

  // Email extraction from metadata
  const emailMatches = textToScan.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g);
  if (emailMatches) {
    for (const email of [...new Set(emailMatches)]) {
      entities.push({ type: 'email', value: email });
    }
  }

  // Username extraction (common patterns in metadata)
  const creator = metadata.creator || metadata.author;
  if (typeof creator === 'string' && creator.length > 0 && !creator.includes('@')) {
    entities.push({ type: 'username', value: creator });
  }

  const content = [
    `Document: ${url}`,
    metadata.author ? `Author: ${metadata.author}` : '',
    metadata.creator ? `Creator: ${metadata.creator}` : '',
    metadata.producer ? `Producer: ${metadata.producer}` : '',
    metadata.title ? `Title: ${metadata.title}` : '',
    metadata.subject ? `Subject: ${metadata.subject}` : '',
    metadata.created ? `Created: ${metadata.created}` : '',
    metadata.modified ? `Modified: ${metadata.modified}` : '',
    metadata.company ? `Company: ${metadata.company}` : '',
    metadata.software ? `Software: ${metadata.software}` : '',
    metadata.format ? `Format: ${metadata.format}` : '',
    headers['last-modified'] ? `Server Last-Modified: ${headers['last-modified']}` : '',
    headers['server'] ? `Server: ${headers['server']}` : '',
    headers['x-powered-by'] ? `X-Powered-By: ${headers['x-powered-by']}` : '',
    entities.length > 0 ? `\nExtracted entities:\n${entities.map((e) => `- ${e.type}: ${e.value}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const id = `docmeta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await exec(
    `INSERT INTO intelligence_events
     (id, source_id, kind, title, content, tags, confidence, sensitivity, event_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      'docmeta',
      'alert',
      `Document metadata: ${url.split('/').pop() ?? 'unknown'}`,
      content,
      JSON.stringify({
        parent_event_id: parentEventId,
        document_url: url,
        metadata,
        entities,
      }),
      0.85,
      'public',
      Date.now(),
      Date.now(),
    ],
  );

  // Upsert extracted entities
  if (entities.length > 0) {
    const { extractAndLinkEntities } = await import('../store/entities.js');
    await extractAndLinkEntities({
      id,
      title: `Document metadata: ${url.split('/').pop() ?? 'unknown'}`,
      content,
      tags: { entities },
    });
  }
}

function extractPdfMetadata(bytes: Uint8Array): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Read first 50KB for PDF header parsing
  const chunk = bytes.slice(0, Math.min(bytes.length, 50 * 1024));
  const text = new TextDecoder('latin1').decode(chunk);

  // PDF metadata keys
  const fields: Record<string, string> = {
    author: '/Author',
    creator: '/Creator',
    producer: '/Producer',
    title: '/Title',
    subject: '/Subject',
    keywords: '/Keywords',
  };

  for (const [key, prefix] of Object.entries(fields)) {
    const regex = new RegExp(`${prefix}\\s*\\(([^)]+)\\)`);
    const match = regex.exec(text);
    if (match) {
      result[key] = decodePdfString(match[1]);
    }
  }

  // CreationDate / ModDate
  const createdMatch = /\/CreationDate\s*\(D:(\d{14})/.exec(text);
  if (createdMatch) {
    result.created = parsePdfDate(createdMatch[1]);
  }

  const modMatch = /\/ModDate\s*\(D:(\d{14})/.exec(text);
  if (modMatch) {
    result.modified = parsePdfDate(modMatch[1]);
  }

  // Try to detect software
  if (result.creator || result.producer) {
    result.software = result.creator || result.producer;
  }

  result.format = 'PDF';
  return result;
}

function decodePdfString(s: string): string {
  // Decode PDF escape sequences
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function parsePdfDate(d: string): string {
  // D:YYYYMMDDHHMMSS format
  if (d.length < 14) return d;
  const year = d.slice(0, 4);
  const month = d.slice(4, 6);
  const day = d.slice(6, 8);
  const hour = d.slice(8, 10);
  const min = d.slice(10, 12);
  const sec = d.slice(12, 14);
  return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
}

function extractOfficeMetadata(bytes: Uint8Array): Record<string, unknown> {
  const result: Record<string, unknown> = { format: 'Office Open XML' };

  try {
    const files = unzipSync(bytes);

    // Read docProps/core.xml
    const coreXml = files['docProps/core.xml'];
    if (coreXml) {
      const xml = strFromU8(coreXml);
      result.title = extractXmlTag(xml, 'dc:title');
      result.subject = extractXmlTag(xml, 'dc:subject');
      result.creator = extractXmlTag(xml, 'dc:creator');
      result.author = result.creator;
      result.description = extractXmlTag(xml, 'dc:description');
      result.created = extractXmlTag(xml, 'dcterms:created');
      result.modified = extractXmlTag(xml, 'dcterms:modified');
      result.lastModifiedBy = extractXmlTag(xml, 'cp:lastModifiedBy');
      result.category = extractXmlTag(xml, 'cp:category');
      result.company = extractXmlTag(xml, 'cp:company');
    }

    // Read docProps/app.xml for software info
    const appXml = files['docProps/app.xml'];
    if (appXml) {
      const xml = strFromU8(appXml);
      result.application = extractXmlTag(xml, 'Application');
      result.appVersion = extractXmlTag(xml, 'AppVersion');
      if (result.application) {
        result.software = `${result.application} ${result.appVersion ?? ''}`.trim();
      }
    }
  } catch (err) {
    console.warn('[documentMeta] Office unzip failed:', err instanceof Error ? err.message : String(err));
  }

  return result;
}

function extractOpenDocumentMetadata(bytes: Uint8Array): Record<string, unknown> {
  const result: Record<string, unknown> = { format: 'OpenDocument' };

  try {
    const files = unzipSync(bytes);

    // Read meta.xml
    const metaXml = files['meta.xml'];
    if (metaXml) {
      const xml = strFromU8(metaXml);
      result.title = extractXmlTag(xml, 'dc:title');
      result.subject = extractXmlTag(xml, 'dc:subject');
      result.creator = extractXmlTag(xml, 'dc:creator');
      result.author = result.creator;
      result.description = extractXmlTag(xml, 'dc:description');
      result.created = extractXmlTag(xml, 'meta:creation-date');
      result.modified = extractXmlTag(xml, 'dc:date');
      result.generator = extractXmlTag(xml, 'meta:generator');
      if (result.generator) {
        result.software = result.generator;
      }

      // Company from meta
      const initialCreator = extractXmlTag(xml, 'meta:initial-creator');
      if (initialCreator) {
        result.company = initialCreator;
      }
    }
  } catch (err) {
    console.warn('[documentMeta] ODT unzip failed:', err instanceof Error ? err.message : String(err));
  }

  return result;
}

function extractXmlTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag.split(':').pop()}>`);
  const match = regex.exec(xml);
  return match?.[1] || undefined;
}
