// MITRE ATT&CK data loader and technique detector

export interface MitreTechnique {
  id: string;
  name: string;
  description: string;
  tactics: string[];
  keywords: string[];
}

export interface MitreTactic {
  id: string;
  name: string;
  shortName: string;
}

let techniqueIndex: Map<string, MitreTechnique> | null = null;
let tacticIndex: Map<string, MitreTactic> | null = null;
let lastLoad = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function loadMitreData(): Promise<{ techniques: MitreTechnique[]; tactics: MitreTactic[] }> {
  const now = Date.now();
  if (techniqueIndex && tacticIndex && now - lastLoad < CACHE_TTL_MS) {
    return {
      techniques: Array.from(techniqueIndex.values()),
      tactics: Array.from(tacticIndex.values()),
    };
  }

  try {
    const url = 'https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json';
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`MITRE fetch failed: ${res.status}`);

    const bundle = (await res.json()) as {
      objects?: Array<Record<string, unknown>>;
    };

    const tactics = new Map<string, MitreTactic>();
    const techniques = new Map<string, MitreTechnique>();
    const tacticRefs = new Map<string, string[]>(); // technique id -> tactic shortNames

    for (const obj of bundle.objects ?? []) {
      const type = String(obj.type);

      if (type === 'x-mitre-tactic') {
        const id = String(obj.id);
        const name = String(obj.name);
        const shortName = String((obj as Record<string, unknown>)['x_mitre_shortname']);
        tactics.set(id, { id, name, shortName });
      }

      if (type === 'attack-pattern') {
        const external = (obj.external_references as Array<{ source_name?: string; external_id?: string }> | undefined) ?? [];
        const mitreRef = external.find((r) => r.source_name === 'mitre-attack');
        if (!mitreRef?.external_id) continue;

        const techId = mitreRef.external_id;
        const name = String(obj.name);
        const description = String(obj.description ?? '');

        // Build keywords from name, description, and aliases
        const keywords = new Set<string>();
        const nameWords = name.toLowerCase().split(/[^a-z0-9]+/);
        for (const w of nameWords) {
          if (w.length > 2) keywords.add(w);
        }

        // Add aliases
        const aliases = (obj as Record<string, unknown>)['x_mitre_aliases'] as string[] | undefined;
        if (aliases) {
          for (const a of aliases) {
            keywords.add(a.toLowerCase());
          }
        }

        // Parse kill chain phases to get tactics
        const phases = (obj.kill_chain_phases as Array<{ phase_name?: string }> | undefined) ?? [];
        const tacticShortNames = phases.map((p) => p.phase_name).filter(Boolean) as string[];
        tacticRefs.set(techId, tacticShortNames);

        techniques.set(techId, {
          id: techId,
          name,
          description,
          tactics: tacticShortNames,
          keywords: Array.from(keywords),
        });
      }
    }

    // Resolve tactic names
    for (const [techId, tech] of techniques) {
      const shortNames = tacticRefs.get(techId) ?? [];
      tech.tactics = shortNames.map((sn) => {
        const t = Array.from(tactics.values()).find((x) => x.shortName === sn);
        return t?.name ?? sn;
      });
    }

    techniqueIndex = techniques;
    tacticIndex = tactics;
    lastLoad = now;

    console.log(`[mitre] Loaded ${techniques.size} techniques, ${tactics.size} tactics`);

    return {
      techniques: Array.from(techniques.values()),
      tactics: Array.from(tactics.values()),
    };
  } catch (err) {
    console.error('[mitre] Failed to load ATT&CK data:', err instanceof Error ? err.message : String(err));
    // Return cached or empty
    return {
      techniques: techniqueIndex ? Array.from(techniqueIndex.values()) : [],
      tactics: tacticIndex ? Array.from(tacticIndex.values()) : [],
    };
  }
}

export function getTechniqueById(id: string): MitreTechnique | undefined {
  return techniqueIndex?.get(id);
}

export function listTechniques(): MitreTechnique[] {
  return techniqueIndex ? Array.from(techniqueIndex.values()) : [];
}

export function listTactics(): MitreTactic[] {
  return tacticIndex ? Array.from(tacticIndex.values()) : [];
}

export async function detectMitreTechniques(title: string | undefined, content: string): Promise<Record<string, unknown>> {
  await loadMitreData();
  if (!techniqueIndex || techniqueIndex.size === 0) return {};

  const text = `${title ?? ''} ${content}`.toLowerCase();
  const matches: Array<{ id: string; name: string; tactics: string[]; confidence: number }> = [];

  for (const technique of techniqueIndex.values()) {
    let score = 0;
    let matchedKeywords = 0;

    for (const kw of technique.keywords) {
      if (text.includes(kw)) {
        score += kw.length;
        matchedKeywords++;
      }
    }

    if (matchedKeywords === 0) continue;

    // Direct mention of technique ID is high confidence
    if (text.includes(technique.id.toLowerCase())) {
      score += 100;
    }

    // Confidence based on keyword coverage
    const coverage = matchedKeywords / technique.keywords.length;
    let confidence = Math.min(1, coverage * 3 + (text.includes(technique.id.toLowerCase()) ? 0.3 : 0));

    matches.push({
      id: technique.id,
      name: technique.name,
      tactics: technique.tactics,
      confidence: Math.round(confidence * 100) / 100,
    });
  }

  // Sort by confidence, take top 5
  matches.sort((a, b) => b.confidence - a.confidence);
  const top = matches.slice(0, 5).filter((m) => m.confidence >= 0.3);

  if (top.length === 0) return {};

  const allTactics = [...new Set(top.flatMap((m) => m.tactics))];

  return {
    mitre_techniques: top,
    mitre_tactics: allTactics,
  };
}
