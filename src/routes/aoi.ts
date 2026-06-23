/**
 * Area-of-Interest (AOI) scope-rule CRUD route (006).
 *
 * Hono router (default export) over the intelligence_aoi store. The integrator
 * mounts this (e.g. app.route('/aoi', aoiRoutes)). Style mirrors the channel
 * CRUD in src/index.ts and routes/subscriptions.ts.
 *
 *   GET    /        list (?enabledOnly=true)
 *   POST   /        create (validates kind + definition)
 *   DELETE /:id     delete
 *   PATCH  /:id     toggle ({ enabled })
 */

import { Hono } from 'hono';
import { listAoi, createAoi, deleteAoi, setAoiEnabled, isAoiKind } from '../store/aoi.js';
import type { AoiKind } from '../store/aoi.js';

const app = new Hono();

app.get('/', async (c) => {
  const enabledOnly = c.req.query('enabledOnly') === 'true';
  return c.json({ aoi: await listAoi(enabledOnly) });
});

app.post('/', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const name = typeof b?.name === 'string' ? b.name.trim() : '';
  if (!name) return c.json({ error: 'name required' }, 400);
  if (!isAoiKind(b?.kind)) return c.json({ error: 'valid kind required' }, 400);
  const definition = b?.definition && typeof b.definition === 'object' && !Array.isArray(b.definition)
    ? (b.definition as Record<string, unknown>)
    : undefined;
  if (!definition) return c.json({ error: 'definition object required' }, 400);
  const err = validateDefinition(b.kind, definition);
  if (err) return c.json({ error: err }, 400);

  const weight = typeof b?.weight === 'number' && Number.isFinite(b.weight) ? b.weight : undefined;
  const rule = await createAoi({
    name,
    kind: b.kind,
    definition,
    weight,
    enabled: b?.enabled !== false,
  });
  return c.json(rule, 201);
});

app.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b?.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400);
  await setAoiEnabled(c.req.param('id'), b.enabled);
  return c.json({ ok: true });
});

app.delete('/:id', async (c) => {
  await deleteAoi(c.req.param('id'));
  return c.json({ ok: true });
});

/**
 * Shallow per-kind definition validation — enough to reject obviously malformed
 * rules at the API boundary. The scoring predicate (scoring/aoi.ts) is itself
 * defensive, so this is a usability guard, not a security boundary.
 * Returns an error string, or undefined when valid.
 */
function validateDefinition(kind: AoiKind, def: Record<string, unknown>): string | undefined {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const nonEmptyStrArray = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim().length > 0);

  switch (kind) {
    case 'geo_bbox':
      if (![def.minLat, def.minLon, def.maxLat, def.maxLon].every(num)) {
        return 'geo_bbox requires numeric minLat, minLon, maxLat, maxLon';
      }
      return undefined;
    case 'geo_radius':
      if (![def.lat, def.lon, def.radiusKm].every(num) || (def.radiusKm as number) < 0) {
        return 'geo_radius requires numeric lat, lon, radiusKm (>= 0)';
      }
      return undefined;
    case 'country':
      if (!nonEmptyStrArray(def.codes)) return 'country requires a non-empty codes[] of ISO2 strings';
      return undefined;
    case 'region':
      if (!nonEmptyStrArray(def.regions)) return 'region requires a non-empty regions[]';
      return undefined;
    case 'entity':
      if (!nonEmptyStrArray(def.values)) return 'entity requires a non-empty values[]';
      return undefined;
    case 'domain':
      if (!nonEmptyStrArray(def.domains)) return 'domain requires a non-empty domains[]';
      return undefined;
    case 'keyword':
      if (!nonEmptyStrArray(def.keywords)) return 'keyword requires a non-empty keywords[]';
      return undefined;
    default:
      return 'unknown kind';
  }
}

export default app;
