/**
 * MCP response shaping — pure helpers that keep tool output from blowing the
 * agent's context window. Raw `JSON.stringify(rows, null, 2)` over a few hundred
 * DB rows easily floods the model with tens of thousands of tokens of noise; these
 * helpers project a relevant subset of fields, cap the item count, and budget the
 * total character length with an honest truncation marker.
 *
 * Clean-room: the *idea* of field-projecting + budgeting MCP results is inspired by
 * worldmonitor's response-shaping, but nothing here is copied — no jmespath dep, no
 * borrowed strings/constants. Pure, dependency-free, fully unit-tested.
 */

/** Default ceiling for a single MCP text content block (characters, not tokens). */
export const DEFAULT_MAX_CHARS = 8000;
/** Default ceiling for the number of items serialized into one result. */
export const DEFAULT_MAX_ITEMS = 25;

/**
 * Resolve a dot-path (e.g. "location.lat" or "tags.urgency") against an object.
 * Returns `undefined` for any missing segment without throwing. Does NOT walk
 * arrays by numeric index — keep paths simple and object-shaped.
 */
export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  const segments = path.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Project a subset of fields out of an object. `fields` may contain dot-paths;
 * the result is a FLAT object keyed by the dot-path string (so "location.lat"
 * becomes a top-level "location.lat" key — predictable and JSON-stable).
 *
 * - `fields` undefined/empty => return the object unchanged (no projection).
 * - Missing keys are omitted entirely (not emitted as null/undefined), so the
 *   serialized output stays compact.
 * - Non-object inputs (string, number, null) are returned as-is.
 */
export function projectFields(obj: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0) return obj;
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getPath(obj, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/**
 * Truncate `text` to at most `maxChars` characters, appending an honest marker
 * that states how many characters were dropped, e.g. "...(1234 more)". The marker
 * itself is accounted for in the budget so the final string never exceeds
 * `maxChars` (unless `maxChars` is so small that only the marker fits, in which
 * case the marker is returned alone).
 *
 * Non-positive `maxChars` yields an empty string.
 */
export function budgetText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const dropped = text.length - maxChars;
  // First-pass marker assumes we keep exactly maxChars of body; the marker count
  // may grow by a digit once we subtract its own length, so recompute once.
  let marker = `...(${dropped} more)`;
  let keep = maxChars - marker.length;
  if (keep < 0) keep = 0;
  const recomputedDropped = text.length - keep;
  marker = `...(${recomputedDropped} more)`;
  keep = maxChars - marker.length;
  if (keep <= 0) {
    // Marker alone exceeds the budget; return just the marker (honest over-cap is
    // better than a silently empty or misleading result).
    return marker;
  }
  return text.slice(0, keep) + marker;
}

/**
 * Shape an array of DB rows into compact text for an MCP `{type:'text'}` block:
 *   1. cap the number of items (maxItems),
 *   2. project each kept item down to `fields` (dot-paths),
 *   3. JSON.stringify compactly (2-space indent for readability),
 *   4. budget the whole string to `maxChars` with a truncation marker.
 *
 * When items were dropped by the item cap, a trailing note "(+N more items)" is
 * appended BEFORE the char budget is applied, so the agent always knows the list
 * was truncated even if the char budget never bites.
 */
export function shapeToolResult(
  rows: unknown[],
  opts: { fields?: string[]; maxChars?: number; maxItems?: number } = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;

  const total = Array.isArray(rows) ? rows.length : 0;
  if (total === 0) return '[]';

  const capped = maxItems > 0 ? rows.slice(0, maxItems) : [];
  const projected = capped.map((r) => projectFields(r, opts.fields));

  let json = JSON.stringify(projected, null, 2);
  const overflow = total - capped.length;
  if (overflow > 0) {
    json += `\n(+${overflow} more items)`;
  }

  return budgetText(json, maxChars);
}
