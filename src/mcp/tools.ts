/**
 * Extra MCP tools exposing the "brain" outputs (scored events, correlation
 * signals, source health, grounded semantic Q&A) over the existing stdio MCP
 * server. Every list-returning tool runs through `shapeToolResult` so a busy
 * corpus never floods the agent's context.
 *
 * Clean-room: the tool *surface* (top intelligence, signal query, health, RAG
 * ask) is inspired by worldmonitor's analyst tooling, but all schemas, prompt
 * text, and field choices here are original.
 */

import { listTopEvents, searchEventsByVector } from '../store/events.js';
import { listSignals } from '../store/signals.js';
import { listSources } from '../store/sources.js';
import { embedText } from '../processors/embed.js';
import { callSamaritanLLM } from '../samaritan-client.js';
import { sanitizeForPrompt } from '../llm/sanitize.js';
import { config } from '../config.js';
import type { EventKind, SignalKind } from '../types.js';
import { shapeToolResult } from './shape.js';

/** An MCP tool definition (subset of the SDK's Tool shape we actually populate). */
export interface ExtraTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Standard MCP tool-call result envelope. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // Index signature so a ToolResult is assignable to the MCP SDK's ServerResult
  // (which extends Result = { _meta?: ...; [key: string]: unknown }).
  [key: string]: unknown;
}

const EVENT_KINDS: EventKind[] = ['visual', 'text', 'anomaly', 'trend', 'alert', 'social_post', 'detection'];
const SIGNAL_KINDS: SignalKind[] = [
  'convergence', 'geo_convergence', 'velocity_spike', 'silent_source', 'volume_anomaly', 'cluster_surge',
  'outlier', 'uncorroborated', 'rule_match',
];

/** Compact projections keep MCP results lean — only what an analyst agent needs. */
const EVENT_FIELDS = ['id', 'sourceId', 'kind', 'title', 'content', 'score', 'eventAt', 'location.lat', 'location.lon'];
const SIGNAL_FIELDS = ['id', 'kind', 'score', 'title', 'summary', 'sourceIds', 'eventIds', 'windowStart', 'windowEnd', 'createdAt'];

const MS_PER_HOUR = 60 * 60 * 1000;

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

/** Clamp a numeric arg into a sane range, falling back to `def` for bad input. */
function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Narrow an unknown args.kinds array to the allowed enum set; undefined if empty. */
function pickKinds<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const set = new Set<string>(allowed);
  const out = raw.filter((k): k is T => typeof k === 'string' && set.has(k));
  return out.length ? out : undefined;
}

export const extraTools: ExtraTool[] = [
  {
    name: 'top_intelligence',
    description:
      'Return the most important recent intelligence events, ranked by composite importance score (not recency). Use this first to triage what matters.',
    inputSchema: {
      type: 'object',
      properties: {
        since_hours: { type: 'number', default: 24, description: 'How many hours back to consider' },
        kinds: { type: 'array', items: { type: 'string', enum: EVENT_KINDS }, description: 'Filter by event kinds' },
        min_score: { type: 'number', description: 'Only return events at/above this composite score (0..1)' },
        limit: { type: 'number', default: 10, description: 'Max events to return' },
      },
    },
  },
  {
    name: 'query_signals',
    description:
      'Query correlation / freshness signals (convergence, geo_convergence, velocity_spike, silent_source, volume_anomaly, cluster_surge) — the "something is happening" layer above raw events.',
    inputSchema: {
      type: 'object',
      properties: {
        since_hours: { type: 'number', default: 24, description: 'How many hours back to consider' },
        kinds: { type: 'array', items: { type: 'string', enum: SIGNAL_KINDS }, description: 'Filter by signal kinds' },
        min_score: { type: 'number', description: 'Only return signals at/above this score' },
        limit: { type: 'number', default: 20, description: 'Max signals to return' },
      },
    },
  },
  {
    name: 'get_source_health',
    description:
      'Summarize the health of every configured intelligence source: health state, last event time, and consecutive failure count. Use to spot silent or failing feeds.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled_only: { type: 'boolean', default: false, description: 'Only include enabled sources' },
      },
    },
  },
  {
    name: 'ask_corpus',
    description:
      'Semantic question-answering over the event corpus. Embeds the question, retrieves the nearest events by vector similarity, and (when an LLM is available) composes a grounded answer citing those events. Falls back to ranked snippets otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question' },
        since_hours: { type: 'number', default: 168, description: 'How many hours back to search' },
        kinds: { type: 'array', items: { type: 'string', enum: EVENT_KINDS }, description: 'Restrict retrieval to these kinds' },
        limit: { type: 'number', default: 8, description: 'How many events to retrieve as context' },
      },
      required: ['query'],
    },
  },
];

const EXTRA_TOOL_NAMES = new Set(extraTools.map((t) => t.name));

/** True if `name` is one of the extra tools (so mcp-server can route correctly). */
export function isExtraTool(name: string): boolean {
  return EXTRA_TOOL_NAMES.has(name);
}

export async function handleExtraTool(name: string, args: unknown): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'top_intelligence':
        return await handleTopIntelligence(a);
      case 'query_signals':
        return await handleQuerySignals(a);
      case 'get_source_health':
        return await handleSourceHealth(a);
      case 'ask_corpus':
        return await handleAskCorpus(a);
      default:
        return { ...text(`Unknown tool: ${name}`), isError: true };
    }
  } catch (err) {
    return {
      ...text(`Error: ${err instanceof Error ? err.message : String(err)}`),
      isError: true,
    };
  }
}

async function handleTopIntelligence(a: Record<string, unknown>): Promise<ToolResult> {
  const sinceHours = clampNum(a.since_hours, 24, 0, 24 * 365);
  const limit = clampNum(a.limit, 10, 1, 100);
  const events = await listTopEvents({
    since: sinceHours > 0 ? Date.now() - sinceHours * MS_PER_HOUR : undefined,
    kinds: pickKinds(a.kinds, EVENT_KINDS),
    minScore: typeof a.min_score === 'number' ? a.min_score : undefined,
    limit,
  });
  return text(shapeToolResult(events, { fields: EVENT_FIELDS, maxItems: limit }));
}

async function handleQuerySignals(a: Record<string, unknown>): Promise<ToolResult> {
  const sinceHours = clampNum(a.since_hours, 24, 0, 24 * 365);
  const limit = clampNum(a.limit, 20, 1, 100);
  const signals = await listSignals({
    since: sinceHours > 0 ? Date.now() - sinceHours * MS_PER_HOUR : undefined,
    kinds: pickKinds(a.kinds, SIGNAL_KINDS),
    minScore: typeof a.min_score === 'number' ? a.min_score : undefined,
    limit,
    // 006: don't surface operator-dismissed signals to the analyst agent.
    excludeDismissed: true,
  });
  return text(shapeToolResult(signals, { fields: SIGNAL_FIELDS, maxItems: limit }));
}

async function handleSourceHealth(a: Record<string, unknown>): Promise<ToolResult> {
  const enabledOnly = a.enabled_only === true;
  const sources = await listSources(enabledOnly);
  const summary = sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    enabled: s.enabled,
    health_state: s.healthState ?? (s.enabled ? 'unknown' : 'disabled'),
    lastEventAt: s.lastEventAt ?? null,
    lastPolledAt: s.lastPolledAt ?? null,
    consecutiveFailures: s.consecutiveFailures ?? s.errorCount ?? 0,
    lastError: s.lastError ?? null,
  }));
  return text(shapeToolResult(summary, { maxItems: summary.length || 1 }));
}

async function handleAskCorpus(a: Record<string, unknown>): Promise<ToolResult> {
  const rawQuery = typeof a.query === 'string' ? a.query : '';
  const cleanQuery = sanitizeForPrompt(rawQuery, { maxLen: 1000 });
  if (!cleanQuery.trim()) {
    return { ...text('No query provided.'), isError: true };
  }

  const sinceHours = clampNum(a.since_hours, 168, 0, 24 * 365);
  const limit = clampNum(a.limit, 8, 1, 25);

  const embedding = await embedText(cleanQuery);
  if (!embedding || embedding.length === 0) {
    return text(
      'Semantic search unavailable: no embedding backend is configured, so the corpus cannot be searched by meaning. Try the keyword tool (query_intelligence_events) instead.',
    );
  }

  const matches = await searchEventsByVector(embedding, {
    since: sinceHours > 0 ? Date.now() - sinceHours * MS_PER_HOUR : undefined,
    kinds: pickKinds(a.kinds, EVENT_KINDS),
    limit,
  });
  if (matches.length === 0) {
    return text(
      `No matching events found for: "${cleanQuery}". The corpus may lack stored embeddings (pgvector) or nothing relevant was ingested in the window.`,
    );
  }

  // Build a compact, grounded context block. Each event is numbered so the LLM
  // (and a human reading the fallback) can cite [1], [2], ...
  const contextItems = matches.map((m, i) => ({
    ref: i + 1,
    id: m.id,
    kind: m.kind,
    title: m.title ?? null,
    content: sanitizeForPrompt(m.content, { maxLen: 600 }),
    eventAt: m.eventAt,
    distance: Number(m.distance.toFixed(4)),
  }));

  const llm = await composeGroundedAnswer(cleanQuery, contextItems);
  if (llm) {
    const sources = shapeToolResult(contextItems, {
      fields: ['ref', 'id', 'kind', 'title', 'eventAt', 'distance'],
      maxItems: contextItems.length,
    });
    return text(`${llm}\n\n--- sources ---\n${sources}`);
  }

  // LLM unavailable: return the ranked snippets as an honest, shaped fallback.
  return text(
    `Semantic matches for "${cleanQuery}" (LLM synthesis unavailable — showing ranked snippets):\n` +
      shapeToolResult(contextItems, {
        fields: ['ref', 'id', 'kind', 'title', 'content', 'eventAt', 'distance'],
        maxItems: contextItems.length,
      }),
  );
}

/** Ask the Samaritan LLM proxy to ground an answer strictly in the retrieved events. */
async function composeGroundedAnswer(
  question: string,
  context: Array<{ ref: number; title: string | null; content: string }>,
): Promise<string | null> {
  const system =
    'You are an intelligence analyst. Answer the question using ONLY the numbered context items below. ' +
    'Cite the items you rely on as [ref]. If the context does not contain the answer, say so plainly. Be concise.';
  const ctx = context
    .map((c) => `[${c.ref}] ${c.title ? c.title + ' — ' : ''}${c.content}`)
    .join('\n');
  const user = `Question: ${question}\n\nContext:\n${ctx}`;

  const res = await callSamaritanLLM({
    model: config.LLM_MODEL ?? 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });
  const answer = res?.choices?.[0]?.message?.content?.trim();
  return answer && answer.length > 0 ? answer : null;
}
