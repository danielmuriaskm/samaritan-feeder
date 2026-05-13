import { query, one, exec } from '../db.js';
import type { SourceConfig } from '../types.js';

export async function listSources(enabledOnly = false): Promise<SourceConfig[]> {
  const sql = enabledOnly
    ? `SELECT * FROM intelligence_sources WHERE enabled = TRUE ORDER BY name`
    : `SELECT * FROM intelligence_sources ORDER BY name`;
  const rows = await query<Record<string, unknown>>(sql);
  return rows.map(fromRow);
}

export async function getSource(id: string): Promise<SourceConfig | undefined> {
  const row = await one<Record<string, unknown>>(
    `SELECT * FROM intelligence_sources WHERE id = $1`,
    [id],
  );
  return row ? fromRow(row) : undefined;
}

export async function createSource(source: Omit<SourceConfig, 'createdAt' | 'updatedAt'>): Promise<SourceConfig> {
  const now = Date.now();
  await exec(
    `INSERT INTO intelligence_sources
     (id, kind, name, description, config, enabled, poll_interval_seconds,
      last_polled_at, last_event_at, error_count, last_error, created_by_user_id,
      created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      source.id, source.kind, source.name, source.description ?? null,
      JSON.stringify(source.config), source.enabled, source.pollIntervalSeconds,
      source.lastPolledAt ?? null, source.lastEventAt ?? null, source.errorCount,
      source.lastError ?? null, source.createdByUserId ?? null, now, now,
    ],
  );
  return { ...source, createdAt: now, updatedAt: now };
}

export async function updateSource(
  id: string,
  patch: Partial<Omit<SourceConfig, 'id' | 'createdAt'>>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (patch.kind !== undefined) { sets.push(`kind = $${idx++}`); vals.push(patch.kind); }
  if (patch.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(patch.name); }
  if (patch.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(patch.description); }
  if (patch.config !== undefined) { sets.push(`config = $${idx++}`); vals.push(JSON.stringify(patch.config)); }
  if (patch.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(patch.enabled); }
  if (patch.pollIntervalSeconds !== undefined) { sets.push(`poll_interval_seconds = $${idx++}`); vals.push(patch.pollIntervalSeconds); }
  if (patch.lastPolledAt !== undefined) { sets.push(`last_polled_at = $${idx++}`); vals.push(patch.lastPolledAt); }
  if (patch.lastEventAt !== undefined) { sets.push(`last_event_at = $${idx++}`); vals.push(patch.lastEventAt); }
  if (patch.errorCount !== undefined) { sets.push(`error_count = $${idx++}`); vals.push(patch.errorCount); }
  if (patch.lastError !== undefined) { sets.push(`last_error = $${idx++}`); vals.push(patch.lastError); }

  sets.push(`updated_at = $${idx++}`);
  vals.push(Date.now());
  vals.push(id);

  await exec(`UPDATE intelligence_sources SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

export async function deleteSource(id: string): Promise<void> {
  await exec(`DELETE FROM intelligence_sources WHERE id = $1`, [id]);
}

function fromRow(row: Record<string, unknown>): SourceConfig {
  return {
    id: String(row.id),
    kind: row.kind as SourceConfig['kind'],
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config as Record<string, unknown> ?? {}),
    enabled: Boolean(row.enabled),
    pollIntervalSeconds: Number(row.poll_interval_seconds),
    lastPolledAt: row.last_polled_at ? Number(row.last_polled_at) : undefined,
    lastEventAt: row.last_event_at ? Number(row.last_event_at) : undefined,
    errorCount: Number(row.error_count),
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
