/**
 * placeExtract — heuristic, dependency-free place-name extraction.
 *
 * Given an event's title/content, try to surface a single, high-confidence
 * place name that a forward geocoder (see ./forwardGeocode.ts) can turn into
 * coordinates. This is deliberately conservative: a wrong place yields wrong
 * coordinates, and false coordinates are worse than none — so when the signal
 * is weak we return `undefined` rather than guessing.
 *
 * Clean-room port of the *idea* behind SpiderFoot's sfp_openstreetmap.py
 * (smicallef/spiderfoot, MIT): that module pulls a location string off an event
 * and feeds it to Nominatim. SpiderFoot relies on upstream modules to have
 * already isolated a "GEOINFO"/"PHYSICAL_ADDRESS" string; here we have only raw
 * article text, so we add a small extraction layer in front. No code copied —
 * this is an independent regex/heuristic implementation. MIT.
 *
 * Approach
 * --------
 * We scan for two complementary signals and score each candidate:
 *   1. Preposition cues — "in X", "near X", "at X", "outside X" followed by a
 *      capitalized run. These strongly imply a location.
 *   2. "<City>, <Region/Country>" — a capitalized run, a comma, another
 *      capitalized run (e.g. "Kharkiv, Ukraine"). The comma form is the single
 *      most reliable newswire location signal, so it scores highest.
 * Candidates are filtered against a stop-list of capitalized non-places
 * (months, weekdays, common org/agency words) and against length sanity checks,
 * then the best-scoring one is returned.
 */

export interface PlaceCandidate {
  /** The extracted place string, suitable to hand to a geocoder. */
  name: string;
  /** Heuristic confidence in [0,1]. Higher = stronger location signal. */
  confidence: number;
}

/**
 * Capitalized tokens that are emphatically NOT places, so a run that is only
 * these should be rejected. Lower-cased for comparison.
 */
const STOP_WORDS = new Set<string>([
  // Months
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  // Weekdays
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // Sentence-leading / filler capitals and common non-place proper-ish words
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'his', 'her', 'their',
  'our', 'its', 'breaking', 'update', 'report', 'reports', 'reuters', 'ap',
  'afp', 'live', 'video', 'photo', 'photos', 'analysis', 'opinion', 'exclusive',
  // Common agency/org words that often share the capitalized-run shape
  'president', 'minister', 'ministry', 'department', 'police', 'army', 'navy',
  'force', 'forces', 'government', 'official', 'officials', 'company', 'group',
  'court', 'university', 'hospital', 'school', 'company', 'inc', 'corp', 'ltd',
]);

/** A run of capitalized words, allowing internal connectors like "of"/"and". */
const CAP_WORD = "[A-Z][\\p{L}'’.-]*";
const CONNECTOR = '(?:of|and|de|del|la|le|el|al|du|da|das|dos|the)';
// e.g. "New York", "Rio de Janeiro", "Isle of Man".
const CAP_RUN = `${CAP_WORD}(?:\\s+(?:${CONNECTOR}\\s+)?${CAP_WORD}){0,3}`;

const PREPOSITION_RE = new RegExp(
  `\\b(?:in|near|at|outside|inside|around|from)\\s+(${CAP_RUN})`,
  'gu',
);

const COMMA_PAIR_RE = new RegExp(
  `\\b(${CAP_RUN})\\s*,\\s+(${CAP_RUN})`,
  'gu',
);

/** Trim trailing punctuation/possessives the regexes may have swept in. */
function cleanName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[’']s\b/gu, '')
    .replace(/^[\s,.;:'"“”‘’()-]+|[\s,.;:'"“”‘’()-]+$/gu, '')
    .trim();
}

/** A run is acceptable if it has at least one token that is not a stop-word. */
function isPlausiblePlace(name: string): boolean {
  if (name.length < 3 || name.length > 80) return false;
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // Reject single-letter or all-stop-word runs.
  const meaningful = tokens.filter((t) => {
    const lower = t.replace(/[.'’-]/gu, '').toLowerCase();
    return lower.length >= 2 && !STOP_WORDS.has(lower);
  });
  return meaningful.length > 0;
}

interface ScoredCandidate extends PlaceCandidate {
  /** Lower-cased name, for de-duplication. */
  key: string;
}

function consider(
  out: Map<string, ScoredCandidate>,
  rawName: string,
  confidence: number,
): void {
  const name = cleanName(rawName);
  if (!isPlausiblePlace(name)) return;
  const key = name.toLowerCase();
  const existing = out.get(key);
  if (!existing || confidence > existing.confidence) {
    out.set(key, { name, confidence, key });
  }
}

/**
 * Extract the single best place-name candidate from an event's title/content,
 * or `undefined` when no candidate clears the confidence bar.
 *
 * The title is weighted above the body: newswire titles are dense with the
 * primary location, whereas body matches are noisier.
 *
 * @returns `{ name, confidence }` where confidence is a coarse heuristic in
 *          [0,1]; callers may threshold on it. Conservative by design.
 */
export function extractPlace(title?: string, content?: string): PlaceCandidate | undefined {
  const candidates = new Map<string, ScoredCandidate>();

  const sources: Array<{ text: string; weight: number }> = [];
  if (title && title.trim()) sources.push({ text: title, weight: 1.0 });
  if (content && content.trim()) sources.push({ text: content, weight: 0.75 });
  if (sources.length === 0) return undefined;

  for (const { text, weight } of sources) {
    // "<City>, <Country>" — strongest signal.
    for (const m of text.matchAll(COMMA_PAIR_RE)) {
      const full = `${cleanName(m[1])}, ${cleanName(m[2])}`;
      // Both halves must individually look like places.
      if (isPlausiblePlace(cleanName(m[1])) && isPlausiblePlace(cleanName(m[2]))) {
        consider(candidates, full, 0.9 * weight);
      }
    }
    // Preposition cue — solid but weaker than the comma form.
    for (const m of text.matchAll(PREPOSITION_RE)) {
      consider(candidates, m[1], 0.65 * weight);
    }
  }

  if (candidates.size === 0) return undefined;

  let best: ScoredCandidate | undefined;
  for (const c of candidates.values()) {
    if (!best || c.confidence > best.confidence) best = c;
  }
  if (!best) return undefined;
  return { name: best.name, confidence: Number(best.confidence.toFixed(2)) };
}

export default extractPlace;
