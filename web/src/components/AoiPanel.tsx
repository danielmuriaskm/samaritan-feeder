import { useEffect, useState } from 'react';
import { listAoi, createAoi, setAoiEnabled, deleteAoi } from '../lib/api.js';
import type { AoiRule, AoiKind } from '../lib/types.js';
import { colors, rgb } from '../lib/theme.js';

const kindIcons: Record<AoiKind, string> = {
  geo_bbox: '🗺️',
  geo_radius: '📍',
  country: '🏳️',
  region: '🧭',
  entity: '🏷️',
  domain: '🌐',
  keyword: '🔤',
};

const kindLabels: Record<AoiKind, string> = {
  geo_bbox: 'geo bbox',
  geo_radius: 'geo radius',
  country: 'country',
  region: 'region',
  entity: 'entity',
  domain: 'domain',
  keyword: 'keyword',
};

const KINDS: AoiKind[] = ['geo_bbox', 'geo_radius', 'country', 'region', 'entity', 'domain', 'keyword'];

// Number-field schema for the geo kinds (everything else is a CSV list).
interface NumField {
  key: string;
  label: string;
  placeholder: string;
}
const NUM_FIELDS: Partial<Record<AoiKind, NumField[]>> = {
  geo_bbox: [
    { key: 'minLat', label: 'Min lat', placeholder: '-90 … 90' },
    { key: 'minLon', label: 'Min lon', placeholder: '-180 … 180' },
    { key: 'maxLat', label: 'Max lat', placeholder: '-90 … 90' },
    { key: 'maxLon', label: 'Max lon', placeholder: '-180 … 180' },
  ],
  geo_radius: [
    { key: 'lat', label: 'Lat', placeholder: '-90 … 90' },
    { key: 'lon', label: 'Lon', placeholder: '-180 … 180' },
    { key: 'radiusKm', label: 'Radius (km)', placeholder: '≥ 0' },
  ],
};

// CSV-list kinds: which definition key holds the parsed array, plus UI copy.
interface ListSpec {
  key: 'codes' | 'regions' | 'values' | 'domains' | 'keywords';
  label: string;
  placeholder: string;
}
const LIST_SPECS: Partial<Record<AoiKind, ListSpec>> = {
  country: { key: 'codes', label: 'ISO2 codes', placeholder: 'US, GB, UA' },
  region: { key: 'regions', label: 'Regions', placeholder: 'California, Bavaria' },
  entity: { key: 'values', label: 'Entity values', placeholder: 'ACME Corp, 8.8.8.8' },
  domain: { key: 'domains', label: 'Domains', placeholder: 'example.com, gov.uk' },
  keyword: { key: 'keywords', label: 'Keywords', placeholder: 'ransomware, evacuation' },
};

// Split a comma-separated string into trimmed, non-empty tokens.
function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Compact one-line rendering of a rule's definition for the list view.
function definitionSummary(rule: AoiRule): string {
  const def = rule.definition ?? {};
  switch (rule.kind) {
    case 'geo_bbox':
      return `[${def.minLat}, ${def.minLon}] → [${def.maxLat}, ${def.maxLon}]`;
    case 'geo_radius':
      return `${def.lat}, ${def.lon} · ${def.radiusKm} km`;
    case 'country':
      return asList(def.codes).join(', ');
    case 'region':
      return asList(def.regions).join(', ');
    case 'entity':
      return asList(def.values).join(', ');
    case 'domain':
      return asList(def.domains).join(', ');
    case 'keyword':
      return asList(def.keywords).join(', ');
    default:
      return JSON.stringify(def);
  }
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export default function AoiPanel() {
  const [rules, setRules] = useState<AoiRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<AoiKind>('keyword');
  const [weight, setWeight] = useState('1.0');
  const [nums, setNums] = useState<Record<string, string>>({});
  const [list, setList] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await listAoi();
      setRules(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load AOI rules');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const numFields = NUM_FIELDS[kind];
  const listSpec = LIST_SPECS[kind];

  function onKindChange(next: AoiKind) {
    setKind(next);
    setNums({});
    setList('');
  }

  // Build the per-kind definition JSON, or null if the inputs are incomplete/invalid.
  function buildDefinition(): Record<string, unknown> | null {
    if (numFields) {
      const def: Record<string, number> = {};
      for (const f of numFields) {
        const raw = (nums[f.key] ?? '').trim();
        if (raw === '') return null;
        const n = Number(raw);
        if (!Number.isFinite(n)) return null;
        def[f.key] = n;
      }
      if (kind === 'geo_radius' && def.radiusKm < 0) return null;
      return def;
    }
    if (listSpec) {
      const items = splitCsv(list);
      if (items.length === 0) return null;
      return { [listSpec.key]: items };
    }
    return null;
  }

  const parsedWeight = Number(weight);
  const weightValid = Number.isFinite(parsedWeight) && parsedWeight >= 0 && parsedWeight <= 1;
  const canSubmit = name.trim().length > 0 && weightValid && buildDefinition() !== null;

  async function onAdd() {
    const definition = buildDefinition();
    if (!canSubmit || !definition || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createAoi({ name: name.trim(), kind, definition, weight: parsedWeight });
      setName('');
      setWeight('1.0');
      setNums({});
      setList('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create AOI rule');
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggle(rule: AoiRule) {
    setBusyId(rule.id);
    setError(null);
    try {
      await setAoiEnabled(rule.id, !rule.enabled);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update AOI rule');
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(rule: AoiRule) {
    if (!window.confirm(`Delete AOI rule "${rule.name}"? This cannot be undone.`)) return;
    setBusyId(rule.id);
    setError(null);
    try {
      await deleteAoi(rule.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete AOI rule');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 760, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Add AOI rule form */}
      <div className="wm-card" style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Add area-of-interest rule</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Name</span>
            <input
              className="wm-input"
              type="text"
              value={name}
              placeholder="e.g. Eastern Europe hotspots"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
              <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Kind</span>
              <select
                className="wm-select"
                value={kind}
                onChange={(e) => onKindChange(e.target.value as AoiKind)}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindIcons[k]} {kindLabels[k]}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 120px' }}>
              <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Weight (0–1)</span>
              <input
                className="wm-input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                style={!weightValid ? { borderColor: colors.critical } : undefined}
              />
            </label>
          </div>

          {/* Kind-aware definition editor */}
          {numFields && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {numFields.map((f) => (
                <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 110px' }}>
                  <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>{f.label}</span>
                  <input
                    className="wm-input"
                    type="number"
                    value={nums[f.key] ?? ''}
                    placeholder={f.placeholder}
                    onChange={(e) => setNums((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}

          {listSpec && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>{listSpec.label} (comma-separated)</span>
              <input
                className="wm-input"
                type="text"
                value={list}
                placeholder={listSpec.placeholder}
                onChange={(e) => setList(e.target.value)}
              />
            </label>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className="wm-btn wm-btn--primary"
              onClick={onAdd}
              disabled={!canSubmit || submitting}
            >
              {submitting ? 'Adding…' : 'Add rule'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--wm-muted)' }}>
              Events inside an AOI are scored <strong style={{ color: colors.live }}>up</strong> and tagged{' '}
              <code>in_aoi</code> — this drives the scheduler's score nudge.
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 3,
            border: `1px solid rgba(${rgb(colors.critical)}, 0.4)`,
            background: `rgba(${rgb(colors.critical)}, 0.12)`,
            color: colors.critical,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ fontSize: 13, color: 'var(--wm-dim)', marginBottom: 12 }}>
        {loading ? 'Loading…' : `${rules.length} rule${rules.length === 1 ? '' : 's'}`}
      </div>

      {/* AOI rule list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!loading && rules.length === 0 && (
          <div style={{ fontSize: 14, color: 'var(--wm-muted)', textAlign: 'center', padding: 24 }}>
            No AOI rules yet. Add one above to nudge in-scope events up the rankings.
          </div>
        )}
        {rules.map((rule) => {
          const busy = busyId === rule.id;
          return (
            <div
              key={rule.id}
              className="wm-card"
              style={{ padding: 16, opacity: rule.enabled ? 1 : 0.7 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{rule.name}</span>
                <span className="wm-chip" style={{ background: `rgba(${rgb(colors.purple)}, 0.18)`, color: colors.purple }}>
                  {kindIcons[rule.kind] ?? '🎯'} {kindLabels[rule.kind] ?? rule.kind}
                </span>
                <span
                  className="wm-chip"
                  style={{
                    background: rule.enabled ? `rgba(${rgb(colors.live)}, 0.15)` : `rgba(${rgb(colors.muted)}, 0.15)`,
                    color: rule.enabled ? colors.live : colors.dim,
                  }}
                >
                  {rule.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <span
                  className="wm-chip"
                  style={{ background: `rgba(${rgb(colors.elevated)}, 0.15)`, color: colors.elevated }}
                  title="Match weight (0–1)"
                >
                  w {rule.weight}
                </span>
                <span style={{ fontSize: 12, color: 'var(--wm-dim)', marginLeft: 'auto' }}>
                  {new Date(rule.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div
                className="wm-meta"
                style={{ fontSize: 13, color: 'var(--wm-text-2)', wordBreak: 'break-all', marginBottom: 12 }}
              >
                {definitionSummary(rule)}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="wm-btn" onClick={() => onToggle(rule)} disabled={busy}>
                  {rule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="wm-btn wm-btn--danger" onClick={() => onDelete(rule)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
