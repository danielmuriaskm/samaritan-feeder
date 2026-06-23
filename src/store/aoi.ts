/**
 * Store for Area-of-Interest (AOI) scope rules (006).
 *
 * CRUD over `intelligence_aoi` (migration 006). An AOI rule is a declarative
 * scope assertion — "events in this bbox / radius / country / region, or
 * mentioning these entities / domains / keywords, are interesting to me". The
 * scheduler loads the enabled set (cached) and runs scoring/aoi.ts over each
 * event to nudge in-scope events up and tag them.
 *
 * Clean-room concept port of SpiderFoot's Target scope model
 * (smicallef/spiderfoot, MIT — target.py in-scope-vs-affiliate matching),
 * reimagined for a perpetual feeder rather than a single scan target. No code
 * copied; this is an independent implementation with its own schema and kinds.
 *
 * The `definition` column is a JSONB blob whose shape depends on `kind`
 * (validated/consumed in scoring/aoi.ts, not here). Style mirrors
 * store/channels.ts.
 */

import { query, exec } from '../db.js';
import { randomUUID } from 'crypto';

/** AOI rule kinds. Each implies a `definition` shape (see scoring/aoi.ts). */
export type AoiKind =
  | 'geo_bbox'
  | 'geo_radius'
  | 'country'
  | 'region'
  | 'entity'
  | 'domain'
  | 'keyword';

export const VALID_AOI_KINDS: ReadonlyArray<AoiKind> = [
  'geo_bbox',
  'geo_radius',
  'country',
  'region',
  'entity',
  'domain',
  'keyword',
];

export function isAoiKind(value: unknown): value is AoiKind {
  return typeof value === 'string' && (VALID_AOI_KINDS as readonly string[]).includes(value);
}

export interface AoiRule {
  id: string;
  name: string;
  kind: AoiKind;
  /** Kind-specific JSON definition (e.g. { minLat, minLon, maxLat, maxLon } for geo_bbox). */
  definition: Record<string, unknown>;
  /** Match strength contribution in 0..1+ (clamped at scoring time). */
  weight: number;
  enabled: boolean;
  createdAt: number;
}

/** All AOI rules. `enabledOnly` filters to active rules (the scoring path). */
export async function listAoi(enabledOnly = false): Promise<AoiRule[]> {
  const where = enabledOnly ? 'WHERE enabled' : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_aoi ${where} ORDER BY created_at DESC`,
  );
  return rows.map(fromRow);
}

/** Enabled rules only — the set the scheduler caches and scores against. */
export async function getEnabledAoi(): Promise<AoiRule[]> {
  return listAoi(true);
}

export async function createAoi(
  input: Omit<AoiRule, 'id' | 'createdAt' | 'enabled' | 'weight'> & {
    id?: string;
    createdAt?: number;
    enabled?: boolean;
    weight?: number;
  },
): Promise<AoiRule> {
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const enabled = input.enabled ?? true;
  const weight = typeof input.weight === 'number' ? input.weight : 1.0;
  await exec(
    `INSERT INTO intelligence_aoi (id, name, kind, definition, weight, enabled, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.name, input.kind, JSON.stringify(input.definition ?? {}), weight, enabled, createdAt],
  );
  return { id, name: input.name, kind: input.kind, definition: input.definition ?? {}, weight, enabled, createdAt };
}

export async function deleteAoi(id: string): Promise<void> {
  await exec(`DELETE FROM intelligence_aoi WHERE id = $1`, [id]);
}

export async function setAoiEnabled(id: string, enabled: boolean): Promise<void> {
  await exec(`UPDATE intelligence_aoi SET enabled = $1 WHERE id = $2`, [enabled, id]);
}

function fromRow(row: Record<string, unknown>): AoiRule {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    kind: row.kind as AoiKind,
    definition: parseJson(row.definition) ?? {},
    weight: row.weight == null ? 1.0 : Number(row.weight),
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return undefined;
}
