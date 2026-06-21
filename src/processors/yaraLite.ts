import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

interface YaraRule {
  name: string;
  strings: RegExp[];
  condition: 'all' | 'any' | string;
}

const BUILT_IN_RULES: YaraRule[] = [
  {
    name: 'cobalt_strike_beacon',
    strings: [
      /MZ.{0,100}cobaltstrike/i,
      /amsi_init_failed/i,
      /ReflectiveLoader/i,
    ],
    condition: 'any',
  },
  {
    name: 'mimikatz_strings',
    strings: [
      /mimikatz/i,
      /sekurlsa::/i,
      /kerberos::/i,
      /lsadump::/i,
      /token::/i,
      /privilege::debug/i,
    ],
    condition: 'any',
  },
  {
    name: 'suspicious_powershell',
    strings: [
      /-enc\s+[A-Za-z0-9+/=]{50,}/i,
      /-encodedcommand\s+[A-Za-z0-9+/=]{50,}/i,
      /Invoke-Expression/i,
      /IEX\s*\(/i,
      /DownloadString\s*\(/i,
      /bitsadmin\s+\/transfer/i,
      /certutil\s+-urlcache/i,
      /FromBase64String/i,
    ],
    condition: 'any',
  },
  {
    name: 'ransomware_indicators',
    strings: [
      /\.locked/i,
      /\.encrypted/i,
      /README_DECRYPT/i,
      /YOUR_FILES_HAVE_BEEN/i,
      /TOR_BROWSER/i,
      /bitcoin.{0,50}wallet/i,
    ],
    condition: 'any',
  },
  {
    name: 'web_shell_php',
    strings: [
      /eval\s*\(\s*\$_/i,
      /assert\s*\(\s*\$_/i,
      /base64_decode\s*\(\s*\$_/i,
      /shell_exec\s*\(/i,
      /passthru\s*\(/i,
      /system\s*\(\s*\$_/i,
    ],
    condition: 'any',
  },
  {
    name: 'lateral_movement_tools',
    strings: [
      /psexec/i,
      /wmiexec/i,
      /smbexec/i,
      /crackmapexec/i,
      /bloodhound/i,
      /sharphound/i,
    ],
    condition: 'any',
  },
  {
    name: 'data_exfiltration',
    strings: [
      /rclone/i,
      /mega\.nz/i,
      /transfer\.sh/i,
      /file\.io/i,
      /pastebin\.com\/raw/i,
      /discord\.com\/api\/webhooks/i,
    ],
    condition: 'any',
  },
];

export async function runYaraLite(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_YARA_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const text = `${event.title ?? ''}\n${event.content}`;
  const textMatches = scanText(text);

  const fileUrls = (event.mediaUrls ?? []).filter((u) => typeof u === 'string');
  const fileMatches: Array<{ rule: string; matches: string[] }> = [];
  for (const url of fileUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const content = await res.text();
        const matches = scanText(content.slice(0, 50 * 1024));
        fileMatches.push(...matches);
      }
    } catch {
      // ignore
    }
  }

  const allMatches = [...textMatches, ...fileMatches];
  if (allMatches.length === 0) return;

  const seen = new Set<string>();
  for (const m of allMatches) {
    const key = `${m.rule}:${m.matches.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    await createReconEvent({
      title: `YARA match: ${m.rule}`,
      content: `Rule: ${m.rule}\nMatched strings: ${m.matches.join(', ')}`,
      tags: {
        recon_source: 'yara',
        recon_type: 'yara_match',
        parent_event_id: event.id,
        yara_rule: m.rule,
        matched_strings: m.matches,
      },
    });
    reconHourlyCount++;
  }
}

function scanText(text: string): Array<{ rule: string; matches: string[] }> {
  const results: Array<{ rule: string; matches: string[] }> = [];

  for (const rule of BUILT_IN_RULES) {
    const matches: string[] = [];
    for (const regex of rule.strings) {
      const found = text.match(regex);
      if (found) {
        matches.push(...found);
      }
    }

    if (matches.length === 0) continue;

    const uniqueMatches = [...new Set(matches)];

    if (rule.condition === 'all') {
      if (uniqueMatches.length >= rule.strings.length) {
        results.push({ rule: rule.name, matches: uniqueMatches });
      }
    } else if (rule.condition === 'any') {
      results.push({ rule: rule.name, matches: uniqueMatches });
    } else if (rule.condition.endsWith('+')) {
      const min = parseInt(rule.condition, 10);
      if (uniqueMatches.length >= min) {
        results.push({ rule: rule.name, matches: uniqueMatches });
      }
    }
  }

  return results;
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
      'recon_yara',
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
