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
    <div style={{ display: 'flex', height: '100%', background: '#f8fafc' }}>
      {/* Sidebar */}
      <div style={{ width: 280, padding: 20, background: '#fff', borderRight: '1px solid #e2e8f0', overflow: 'auto' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18, color: '#1e293b' }}>🧰 OSINT Tools</h2>

        <input
          type="text"
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #e2e8f0',
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
                borderRadius: 4,
                border: 'none',
                background: selectedCategory === cat ? '#e0e7ff' : 'transparent',
                color: selectedCategory === cat ? '#4338ca' : '#475569',
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
          <div style={{ marginTop: 20, padding: 14, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#1e293b' }}>{selectedTool.name}</h3>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b' }}>{selectedTool.description}</p>
            <input
              type="text"
              placeholder="Enter query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid #e2e8f0', marginBottom: 8, fontSize: 12 }}
            />
            <a
              href={launchUrl(selectedTool, query)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                textAlign: 'center',
                padding: '8px',
                background: '#3b82f6',
                color: '#fff',
                borderRadius: 4,
                textDecoration: 'none',
                fontSize: 12,
                fontWeight: 600,
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
              <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 12 }}>({catTools.length})</span>
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {catTools.map((tool) => (
                <button
                  key={tool.name}
                  onClick={() => {
                    setSelectedTool(tool);
                    setQuery('');
                  }}
                  style={{
                    padding: 14,
                    background: selectedTool?.name === tool.name ? '#eff6ff' : '#fff',
                    border: selectedTool?.name === tool.name ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                    borderRadius: 8,
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b', marginBottom: 4 }}>{tool.name}</div>
                  <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.4 }}>{tool.description}</div>
                </button>
              ))}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
            No tools match your search.
          </div>
        )}
      </div>
    </div>
  );
}
