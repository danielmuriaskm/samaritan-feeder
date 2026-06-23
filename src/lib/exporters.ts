/**
 * Pure serializers for the read-path exports (006), SpiderFoot-inspired but
 * clean-room: CSV / NDJSON for events & signals, and GEXF / Sigma-JSON / d3-tree
 * for the entity & lineage graph. No third-party deps (SpiderFoot uses
 * openpyxl/networkx; those don't port — GEXF is hand-rolled minimal XML).
 *
 * Everything here is pure and string-returning so routes stay thin and these are
 * unit-testable without a DB or HTTP.
 */

// ---------------------------------------------------------------------------
// Tabular: CSV (RFC4180-ish) + NDJSON
// ---------------------------------------------------------------------------

/** Quote a CSV cell per RFC4180: wrap in quotes and double internal quotes when
 *  it contains a comma, quote, CR or LF. Objects/arrays are JSON-encoded first. */
export function csvCell(value: unknown): string {
  let s: string;
  if (value == null) s = '';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialize rows to CSV. `columns` fixes the header order and the projected keys
 * (nested values are JSON-encoded). Always emits a header row.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');
  return body ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

/** One JSON object per line. */
export function toNdjson(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Graph: GEXF (Gephi) + Sigma-JSON + d3 parent/child tree
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  label?: string;
  attributes?: Record<string, string | number | boolean | undefined>;
}
export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  weight?: number;
}

/** Escape the five XML predefined entities for text/attribute content. */
export function escapeXml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Minimal GEXF 1.3 (Gephi). Node/edge attributes are emitted as an `<attvalues>`
 * block against a declared `<attributes>` schema collected from the node set.
 * Directed by default.
 */
export function toGexf(nodes: GraphNode[], edges: GraphEdge[], opts: { directed?: boolean } = {}): string {
  const defaultEdgeType = opts.directed === false ? 'undirected' : 'directed';

  // Collect the union of attribute keys across nodes -> a stable id per key.
  const attrKeys: string[] = [];
  const attrId = new Map<string, number>();
  for (const n of nodes) {
    for (const k of Object.keys(n.attributes ?? {})) {
      if (!attrId.has(k)) { attrId.set(k, attrKeys.length); attrKeys.push(k); }
    }
  }

  const attrDecl = attrKeys.length
    ? `      <attributes class="node">\n${attrKeys
        .map((k) => `        <attribute id="${attrId.get(k)}" title="${escapeXml(k)}" type="string"/>`)
        .join('\n')}\n      </attributes>\n`
    : '';

  const nodeXml = nodes
    .map((n) => {
      const av = Object.entries(n.attributes ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `          <attvalue for="${attrId.get(k)}" value="${escapeXml(v)}"/>`)
        .join('\n');
      const avBlock = av ? `\n        <attvalues>\n${av}\n        </attvalues>\n      ` : '';
      return `      <node id="${escapeXml(n.id)}" label="${escapeXml(n.label ?? n.id)}">${avBlock}</node>`;
    })
    .join('\n');

  const edgeXml = edges
    .map((e, i) => {
      const w = e.weight !== undefined ? ` weight="${escapeXml(e.weight)}"` : '';
      const l = e.label ? ` label="${escapeXml(e.label)}"` : '';
      return `      <edge id="${i}" source="${escapeXml(e.source)}" target="${escapeXml(e.target)}"${w}${l}/>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.3" version="1.3">
  <graph mode="static" defaultedgetype="${defaultEdgeType}">
${attrDecl}    <nodes>
${nodeXml}
    </nodes>
    <edges>
${edgeXml}
    </edges>
  </graph>
</gexf>
`;
}

/** Sigma.js / generic JSON graph: `{ nodes, edges }`. */
export function toSigmaJson(nodes: GraphNode[], edges: GraphEdge[]): string {
  return JSON.stringify(
    {
      nodes: nodes.map((n) => ({ id: n.id, label: n.label ?? n.id, ...(n.attributes ?? {}) })),
      edges: edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, label: e.label, weight: e.weight })),
    },
    null,
    2,
  );
}

export interface TreeNode {
  id: string;
  label?: string;
  children: TreeNode[];
}

/**
 * Build a bounded d3-style parent→child tree from a directed edge list, rooted at
 * `rootId`. Cycles and re-visits are pruned (a node appears once on a path), and
 * depth is capped — samaritan's graph is cyclic/multi-root, so an unbounded walk
 * would not terminate.
 */
export function parentChildToTree(
  rootId: string,
  edges: GraphEdge[],
  opts: { maxDepth?: number; label?: (id: string) => string | undefined } = {},
): TreeNode {
  const maxDepth = opts.maxDepth ?? 4;
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const arr = childrenOf.get(e.source);
    if (arr) arr.push(e.target);
    else childrenOf.set(e.source, [e.target]);
  }
  const build = (id: string, depth: number, seen: Set<string>): TreeNode => {
    const node: TreeNode = { id, label: opts.label?.(id) ?? id, children: [] };
    if (depth >= maxDepth) return node;
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child)) continue;
      node.children.push(build(child, depth + 1, new Set([...seen, child])));
    }
    return node;
  };
  return build(rootId, 0, new Set([rootId]));
}
