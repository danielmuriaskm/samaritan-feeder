import { query, exec } from '../db.js';
import type { Brief } from '../types.js';
import { randomUUID } from 'crypto';

/**
 * Store for grounded digest briefs (005). A brief is the synthesized,
 * fabrication-checked digest produced by processors/briefSynth.ts; routes and
 * the scheduler read/write here. Hand-written SQL is fine — unlike signals this
 * table has no shared insert helper elsewhere.
 */

export async function insertBrief(
  brief: Omit<Brief, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<Brief> {
  const id = brief.id ?? randomUUID();
  const createdAt = brief.createdAt ?? Date.now();
  await exec(
    `INSERT INTO intelligence_briefs
       (id, user_id, lead, body, event_count, window_start, window_end, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      brief.userId ?? null,
      brief.lead,
      JSON.stringify(brief.body ?? {}),
      brief.eventCount ?? 0,
      brief.windowStart ?? null,
      brief.windowEnd ?? null,
      createdAt,
    ],
  );
  return { ...brief, id, createdAt };
}

export async function listBriefs(opts: {
  userId?: string;
  since?: number;
  limit?: number;
} = {}): Promise<Brief[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  // userId is nullable; an explicit `userId` filter matches that exact owner,
  // while omitting it returns briefs for everyone (global digest history).
  if (opts.userId !== undefined) { conditions.push(`user_id = $${idx++}`); params.push(opts.userId); }
  if (opts.since !== undefined) { conditions.push(`created_at >= $${idx++}`); params.push(opts.since); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_briefs ${where} ORDER BY created_at DESC LIMIT $${idx++}`,
    [...params, opts.limit ?? 20],
  );
  return rows.map(fromRow);
}

/** Most recent brief for a user (or global when userId omitted), or undefined. */
export async function latestBrief(userId?: string): Promise<Brief | undefined> {
  const briefs = await listBriefs({ userId, limit: 1 });
  return briefs[0];
}

function fromRow(row: Record<string, unknown>): Brief {
  return {
    id: String(row.id),
    userId: row.user_id != null ? String(row.user_id) : undefined,
    lead: String(row.lead),
    body: row.body
      ? (typeof row.body === 'string' ? JSON.parse(row.body) : (row.body as Brief['body']))
      : {},
    eventCount: Number(row.event_count ?? 0),
    windowStart: row.window_start != null ? Number(row.window_start) : undefined,
    windowEnd: row.window_end != null ? Number(row.window_end) : undefined,
    createdAt: Number(row.created_at),
  };
}
