import { useState, useMemo } from 'react';
import tools from '../data/osintTools.json';

interface OsintTool {
  name: string;
  category: string;
  description: string;
  url: string;
}

const CATEGORIES: Record<string, string> = {
  'threat-intel': '🛡️ Threat Intel',
  'ip': '🌐 IP & Network',
  'domain': '🌐 Domain',
  'email': '📧 Email',
  'archives': '📚 Archives',
  'recon': '🔍 Reconnaissance',
  'leaks': '💧 Breaches & Leaks',
  'images': '🖼️ Images',
  'social': '👥 Social Media',
  'geo': '📍 Geolocation',
  'secrets': '🔐 Secrets & Leaks',
  'code': '💻 Code & Repos',
  'vuln': '🐛 Vulnerability',
};

const CATEGORY_COLORS: Record<string, string> = {
  'threat-intel': '#ef4444',
  'ip': '#3b82f6',
  'domain': '#06b6d4',
  'email': '#8b5cf6',
  'archives': '#f59e0b',
  'recon': '#22c55e',
  'leaks': '#ec4899',
  'images': '#10b981',
  'social': '#6366f1',
  'geo': '#f97316',
  'secrets': '#d946ef',
  'code': '#14b8a6',
  'vuln': '#f43f5e',
};

export default function OsintHub() {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedTool, setSelectedTool] = useState<OsintTool | null>(null);
  const [query, setQuery] = useState('');

  const categories = useMemo(() => {
    const cats = new Set(tools.map((t) => t.category));
    return ['all', ...Array.from(cats)];
  }, []);

  const filtered = useMemo(() => {
    return (tools as OsintTool[]).filter((t) => {
      if (selectedCategory !== 'all' && t.category !== selectedCategory) return false;
      if (search) {
        const q = search.toLowerCase();
        return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
      }
      return true;
    });
  }, [search, selectedCategory]);

  const grouped = useMemo(() => {
    const map: Record<string, OsintTool[]> = {};
    for (const tool of filtered) {
      if (!map[tool.category]) map[tool.category] = [];
      map[tool.category].push(tool);
    }
    return map;
  }, [filtered]);

  const launchUrl = (tool: OsintTool, searchQuery: string): string => {
    if (!searchQuery) return tool.url.replace('/{query}', '').replace('={query}', '');
    return tool.url.replace(/{query}/g, encodeURIComponent(searchQuery));
  };

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--wm-base)' }}>
      {/* Sidebar */}
      <div style={{ width: 280, padding: 20, background: 'var(--wm-panel)', borderRight: '1px solid var(--wm-border)', overflow: 'auto' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18, color: 'var(--wm-text)' }}>🧰 OSINT Tools</h2>

        <input
          className="wm-input"
          type="text"
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            marginBottom: 12,
            fontSize: 13,
          }}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              style={{
                padding: '6px 10px',
                borderRadius: 3,
                border: '1px solid',
                borderColor: selectedCategory === cat ? 'var(--wm-accent)' : 'transparent',
                background: selectedCategory === cat ? 'var(--wm-hover)' : 'transparent',
                color: selectedCategory === cat ? 'var(--wm-accent)' : 'var(--wm-dim)',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: selectedCategory === cat ? 600 : 400,
              }}
            >
              {CATEGORIES[cat] || cat}
            </button>
          ))}
        </div>

        {selectedTool && (
          <div className="wm-card" style={{ marginTop: 20, padding: 14 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--wm-text)' }}>{selectedTool.name}</h3>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--wm-dim)' }}>{selectedTool.description}</p>
            <input
              className="wm-input"
              type="text"
              placeholder="Enter query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
            />
            <a
              className="wm-btn wm-btn--primary"
              href={launchUrl(selectedTool, query)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                textAlign: 'center',
                textDecoration: 'none',
                fontSize: 12,
              }}
            >
              🚀 Launch
            </a>
          </div>
        )}
      </div>

      {/* Tool grid */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {Object.entries(grouped).map(([category, catTools]) => (
          <div key={category} style={{ marginBottom: 24 }}>
            <h3
              style={{
                margin: '0 0 12px',
                fontSize: 14,
                color: CATEGORY_COLORS[category] || '#64748b',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: CATEGORY_COLORS[category] || '#64748b', display: 'inline-block' }} />
              {CATEGORIES[category] || category}
              <span style={{ color: 'var(--wm-muted)', fontWeight: 400, fontSize: 12 }}>({catTools.length})</span>
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {catTools.map((tool) => {
                const selected = selectedTool?.name === tool.name;
                return (
                  <button
                    key={tool.name}
                    className="wm-card wm-card--hover"
                    onClick={() => {
                      setSelectedTool(tool);
                      setQuery('');
                    }}
                    style={{
                      padding: 14,
                      background: selected ? 'var(--wm-hover)' : undefined,
                      borderColor: selected ? 'var(--wm-accent)' : undefined,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--wm-text)', marginBottom: 4 }}>{tool.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--wm-dim)', lineHeight: 1.4 }}>{tool.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--wm-muted)' }}>
            No tools match your search.
          </div>
        )}
      </div>
    </div>
  );
}
