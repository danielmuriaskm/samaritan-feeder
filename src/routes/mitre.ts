import { Hono } from 'hono';
import { loadMitreData, listTechniques, listTactics, getTechniqueById } from '../processors/mitreAttack.js';
import { searchEvents } from '../store/events.js';

const app = new Hono();

// GET /api/mitre/techniques
app.get('/techniques', async (c) => {
  const data = await loadMitreData();
  return c.json({ techniques: data.techniques, tactics: data.tactics });
});

// GET /api/mitre/matrix
app.get('/matrix', async (c) => {
  await loadMitreData();
  const techniques = listTechniques();
  const tactics = listTactics();

  // Build tactic -> technique[] hierarchy with event counts
  const matrix: Record<string, Array<{ id: string; name: string; eventCount: number }>> = {};

  for (const tactic of tactics) {
    matrix[tactic.name] = [];
  }

  for (const tech of techniques) {
    for (const tacticName of tech.tactics) {
      if (!matrix[tacticName]) matrix[tacticName] = [];
      matrix[tacticName].push({ id: tech.id, name: tech.name, eventCount: 0 });
    }
  }

  // Count events per technique
  const events = await searchEvents({ query: 'T', limit: 1000 });
  const eventCounts: Record<string, number> = {};

  for (const ev of events) {
    const techs = ev.tags.mitre_techniques;
    if (Array.isArray(techs)) {
      for (const t of techs) {
        const id = typeof t === 'string' ? t : t.id;
        if (id) {
          eventCounts[id] = (eventCounts[id] ?? 0) + 1;
        }
      }
    }
  }

  for (const tacticName of Object.keys(matrix)) {
    for (const cell of matrix[tacticName]) {
      cell.eventCount = eventCounts[cell.id] ?? 0;
    }
    // Sort by event count desc
    matrix[tacticName].sort((a, b) => b.eventCount - a.eventCount);
  }

  return c.json({ tactics: tactics.map((t) => t.name), matrix });
});

// GET /api/mitre/events?techniqueId=T1566
app.get('/events', async (c) => {
  await loadMitreData();
  const techniqueId = c.req.query('techniqueId');
  if (!techniqueId) return c.json({ error: 'techniqueId required' }, 400);

  const technique = getTechniqueById(techniqueId);
  if (!technique) return c.json({ error: 'Technique not found' }, 404);

  // Search for events tagged with this technique
  const allEvents = await searchEvents({ limit: 500 });
  const matched = allEvents.filter((ev) => {
    const techs = ev.tags.mitre_techniques;
    if (!Array.isArray(techs)) return false;
    return techs.some((t: unknown) => {
      if (typeof t === 'string') return t === techniqueId;
      if (t && typeof t === 'object') return (t as Record<string, unknown>).id === techniqueId;
      return false;
    });
  });

  return c.json({ technique, events: matched });
});

export default app;
