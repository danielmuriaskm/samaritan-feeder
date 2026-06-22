import { useEffect, useState, useMemo } from 'react';
import { colors, rgb } from '../lib/theme.js';

interface Source {
  id: string;
  kind: string;
  name: string;
  description?: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  config: Record<string, unknown>;
  lastPolledAt?: number;
  lastEventAt?: number;
  errorCount: number;
  lastError?: string;
}

interface WindyWebcam {
  webcamId: string;
  title?: string;
  location?: { city?: string; country?: string; countryCode?: string; lat?: number; lon?: number };
  images?: { current?: { preview?: string; thumbnail?: string } };
  category?: string;
}

type Tab = 'sources' | 'add' | 'libraries';

interface SourceField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'number' | 'password' | 'select';
  placeholder?: string;
  required?: boolean;
  options?: string[];
  defaultValue?: string;
}

interface SourceKindDef {
  kind: string;
  label: string;
  icon: string;
  category: string;
  fields: SourceField[];
}

const SOURCE_KINDS: SourceKindDef[] = [
  // Social
  { kind: 'rss', label: 'RSS / Atom Feed', icon: '📰', category: 'Social & News', fields: [
    { key: 'url', label: 'Feed URL', type: 'url', placeholder: 'https://feeds.bbci.co.uk/news/rss.xml', required: true },
    { key: 'maxItems', label: 'Max items per poll', type: 'number', placeholder: '20' },
  ]},
  { kind: 'reddit', label: 'Reddit Subreddit', icon: '🤖', category: 'Social & News', fields: [
    { key: 'subreddit', label: 'Subreddit', type: 'text', placeholder: 'worldnews', required: true },
    { key: 'sort', label: 'Sort', type: 'select', options: ['new', 'hot', 'top'], defaultValue: 'new' },
    { key: 'maxItems', label: 'Max items per poll', type: 'number', placeholder: '25' },
  ]},
  { kind: 'hn', label: 'Hacker News', icon: '🧠', category: 'Social & News', fields: [
    { key: 'query', label: 'Search query (optional)', type: 'text', placeholder: 'AI OR security' },
    { key: 'maxItems', label: 'Max items per poll', type: 'number', placeholder: '30' },
  ]},
  { kind: 'bluesky', label: 'Bluesky Search', icon: '🦋', category: 'Social & News', fields: [
    { key: 'query', label: 'Search query', type: 'text', placeholder: 'breaking news', required: true },
    { key: 'maxItems', label: 'Max items per poll', type: 'number', placeholder: '25' },
  ]},
  { kind: 'twitter', label: 'Twitter / X', icon: '🐦', category: 'Social & News', fields: [
    { key: 'query', label: 'Search query', type: 'text', placeholder: 'from:elonmusk OR #news', required: true },
    { key: 'bearerToken', label: 'Bearer Token', type: 'password', placeholder: 'AAAAAAAA...', required: true },
    { key: 'maxItems', label: 'Max items per poll', type: 'number', placeholder: '25' },
  ]},
  { kind: 'instagram', label: 'Instagram', icon: '📸', category: 'Social & News', fields: [
    { key: 'username', label: 'Username (no @)', type: 'text', placeholder: 'natgeo', required: true },
    { key: 'sessionCookie', label: 'Session Cookie (for stories)', type: 'password', placeholder: 'sessionid=abc123...' },
    { key: 'proxyUrl', label: 'Proxy URL (optional)', type: 'url', placeholder: 'https://your-proxy.com' },
  ]},
  { kind: 'tiktok', label: 'TikTok Search', icon: '🎵', category: 'Social & News', fields: [
    { key: 'query', label: 'Search keyword or hashtag', type: 'text', placeholder: '#nyc OR protest', required: true },
    { key: 'maxItems', label: 'Max videos per poll', type: 'number', placeholder: '20' },
    { key: 'proxyUrl', label: 'Proxy URL (optional)', type: 'url', placeholder: 'https://your-proxy.com' },
  ]},
  { kind: 'telegram', label: 'Telegram Channel', icon: '✈️', category: 'Social & News', fields: [
    { key: 'channel', label: 'Channel username (no @)', type: 'text', placeholder: 'breakingmash', required: true },
    { key: 'maxItems', label: 'Max messages per poll', type: 'number', placeholder: '20' },
  ]},
  { kind: 'discord', label: 'Discord Monitor', icon: '🎮', category: 'Social & News', fields: [
    { key: 'botToken', label: 'Discord Bot Token', type: 'password', placeholder: 'MTA0N...', required: true },
    { key: 'channelId', label: 'Channel ID', type: 'text', placeholder: '104560123456789', required: true },
    { key: 'maxItems', label: 'Max messages per poll', type: 'number', placeholder: '50' },
  ]},
  { kind: 'youtube', label: 'YouTube Geo Search', icon: '📺', category: 'Social & News', fields: [
    { key: 'apiKey', label: 'YouTube Data API v3 Key', type: 'password', placeholder: 'AIzaSy...', required: true },
    { key: 'location', label: 'Location (lat,lon)', type: 'text', placeholder: '40.7128,-74.0060', required: true },
    { key: 'locationRadius', label: 'Search radius', type: 'text', placeholder: '50km', defaultValue: '50km' },
    { key: 'query', label: 'Search query (optional)', type: 'text', placeholder: 'protest OR breaking' },
    { key: 'maxItems', label: 'Max videos per poll', type: 'number', placeholder: '25' },
    { key: 'eventType', label: 'Event type', type: 'select', options: ['any', 'live'], defaultValue: 'any' },
  ]},
  // OSINT
  { kind: 'shodan', label: 'Shodan', icon: '🌐', category: 'OSINT', fields: [
    { key: 'apiKey', label: 'Shodan API Key', type: 'password', placeholder: 'your_key', required: true },
    { key: 'query', label: 'Query (IP or search)', type: 'text', placeholder: '8.8.8.8', required: true },
    { key: 'maxItems', label: 'Max results', type: 'number', placeholder: '20' },
  ]},
  { kind: 'censys', label: 'Censys', icon: '🔍', category: 'OSINT', fields: [
    { key: 'apiId', label: 'API ID', type: 'text', placeholder: 'your_id', required: true },
    { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'your_secret', required: true },
    { key: 'query', label: 'Search query', type: 'text', placeholder: 'services.http.status_code: 200', required: true },
    { key: 'maxItems', label: 'Max results', type: 'number', placeholder: '20' },
  ]},
  { kind: 'crtsh', label: 'crt.sh (CT Logs)', icon: '📜', category: 'OSINT', fields: [
    { key: 'domain', label: 'Domain', type: 'text', placeholder: 'example.com', required: true },
  ]},
  { kind: 'virustotal', label: 'VirusTotal', icon: '🛡️', category: 'OSINT', fields: [
    { key: 'apiKey', label: 'VirusTotal API Key', type: 'password', placeholder: 'your_key', required: true },
    { key: 'query', label: 'Query (domain/IP/hash/URL)', type: 'text', placeholder: 'google.com', required: true },
  ]},
  { kind: 'hibp', label: 'Have I Been Pwned', icon: '💀', category: 'OSINT', fields: [
    { key: 'apiKey', label: 'HIBP API Key', type: 'password', placeholder: 'your_key', required: true },
    { key: 'domain', label: 'Domain (or use email)', type: 'text', placeholder: 'example.com' },
    { key: 'email', label: 'Email (or use domain)', type: 'text', placeholder: 'user@example.com' },
  ]},
  { kind: 'sherlock', label: 'Sherlock (Username Probe)', icon: '🔎', category: 'OSINT', fields: [
    { key: 'username', label: 'Username', type: 'text', placeholder: 'johndoe', required: true },
    { key: 'maxProbes', label: 'Max platforms to probe', type: 'number', placeholder: '80' },
  ]},
  { kind: 'webcrawl', label: 'Web Crawler', icon: '🕷️', category: 'OSINT', fields: [
    { key: 'startUrl', label: 'Start URL', type: 'url', placeholder: 'https://example.com', required: true },
    { key: 'maxDepth', label: 'Max crawl depth', type: 'number', placeholder: '2' },
    { key: 'maxPages', label: 'Max pages', type: 'number', placeholder: '20' },
  ]},
  { kind: 'twitter_scrape', label: 'Twitter / X (Scraper)', icon: '🐦', category: 'Social & News', fields: [
    { key: 'query', label: 'Search query', type: 'text', placeholder: '#breaking OR keyword', required: true },
    { key: 'maxItems', label: 'Max tweets', type: 'number', placeholder: '20' },
  ]},
  { kind: 'reddit_scrape', label: 'Reddit (Scraper)', icon: '🤖', category: 'Social & News', fields: [
    { key: 'subreddit', label: 'Subreddit', type: 'text', placeholder: 'worldnews', required: true },
    { key: 'sort', label: 'Sort', type: 'select', options: ['new', 'hot', 'top'], defaultValue: 'new' },
    { key: 'maxItems', label: 'Max posts', type: 'number', placeholder: '25' },
  ]},
  // Cameras & Geo
  { kind: 'webcam', label: 'Webcam Library', icon: '📹', category: 'Cameras & Geo', fields: [
    { key: 'category', label: 'Category', type: 'text', placeholder: 'beach' },
  ]},
  { kind: 'ip_camera', label: 'IP Camera Library', icon: '📡', category: 'Cameras & Geo', fields: [
    { key: 'category', label: 'Category', type: 'text', placeholder: 'public' },
  ]},
  { kind: 'windy', label: 'Windy Webcams', icon: '🌬️', category: 'Cameras & Geo', fields: [
    { key: 'country', label: 'Country code', type: 'text', placeholder: 'CH' },
    { key: 'category', label: 'Category', type: 'text', placeholder: 'mountain' },
  ]},
  { kind: 'traffic_cam', label: 'Traffic Camera', icon: '🚗', category: 'Cameras & Geo', fields: [] },
  { kind: 'weather_cam', label: 'Weather Camera', icon: '🌤️', category: 'Cameras & Geo', fields: [] },
  // Academic & Data
  { kind: 'github', label: 'GitHub', icon: '💻', category: 'Data', fields: [
    { key: 'query', label: 'Search query', type: 'text', placeholder: 'CVE-2024', required: true },
  ]},
  { kind: 'arxiv', label: 'arXiv', icon: '📄', category: 'Data', fields: [
    { key: 'query', label: 'Search query', type: 'text', placeholder: 'artificial intelligence', required: true },
  ]},
  { kind: 'gdelt', label: 'GDELT', icon: '🌍', category: 'Data', fields: [
    { key: 'query', label: 'Search query', type: 'text', placeholder: 'protest', required: true },
  ]},
  { kind: 'news_api', label: 'News API', icon: '🗞️', category: 'Data', fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'your_key', required: true },
    { key: 'query', label: 'Query', type: 'text', placeholder: 'breaking', required: true },
  ]},
];

const CATEGORY_ORDER = ['Social & News', 'OSINT', 'Cameras & Geo', 'Data'];
const CATEGORY_COLORS: Record<string, string> = {
  'Social & News': colors.purple,
  'OSINT': colors.critical,
  'Cameras & Geo': colors.normal,
  'Data': colors.info,
};

const kindIcons: Record<string, string> = {
  rss: '📰', reddit: '🤖', hn: '🧠', bluesky: '🦋', twitter: '🐦', instagram: '📸',
  tiktok: '🎵', youtube: '📺', telegram: '✈️', discord: '🎮', webcam: '📹',
  traffic_cam: '🚗', weather_cam: '🌤️', ip_camera: '📡', news_api: '🗞️',
  gdelt: '🌍', github: '💻', arxiv: '📄', windy: '🌬️',
  shodan: '🌐', censys: '🔍', crtsh: '📜', virustotal: '🛡️', hibp: '💀',
  webcrawl: '🕷️', twitter_scrape: '🐦', reddit_scrape: '🤖', sherlock: '🔎',
};

function getHealthStatus(source: Source): 'healthy' | 'warning' | 'critical' | 'disabled' {
  if (!source.enabled) return 'disabled';
  if (source.errorCount >= 5) return 'critical';
  if (source.errorCount > 0) return 'warning';
  return 'healthy';
}

const HEALTH_DOT: Record<string, string> = {
  healthy: colors.live,
  warning: colors.elevated,
  critical: colors.critical,
  disabled: colors.muted,
};

export default function SourcePanel() {
  const [tab, setTab] = useState<Tab>('sources');
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());

  // Add source form
  const [selectedKind, setSelectedKind] = useState('');
  const [formName, setFormName] = useState('');
  const [formInterval, setFormInterval] = useState(300);
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  // Libraries
  const [library, setLibrary] = useState<Array<{ key: string; name: string; count: number }>>([]);
  const [ipCameraLibrary, setIpCameraLibrary] = useState<Array<{ key: string; name: string; count: number }>>([]);
  const [windyQuery, setWindyQuery] = useState('');
  const [windyCountry, setWindyCountry] = useState('');
  const [windyCategory, setWindyCategory] = useState('');
  const [windyResults, setWindyResults] = useState<WindyWebcam[]>([]);
  const [windyLoading, setWindyLoading] = useState(false);
  const [selectedWindy, setSelectedWindy] = useState<Set<string>>(new Set());

  const refreshSources = () => {
    setLoading(true);
    fetch('/api/sources')
      .then((r) => r.json())
      .then((data) => { setSources(data.sources ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    refreshSources();
    fetch('/api/library').then((r) => r.json()).then((d) => setLibrary(d.categories ?? []));
    fetch('/api/ipcameras').then((r) => r.json()).then((d) => setIpCameraLibrary(d.categories ?? []));
  }, []);

  const filteredSources = useMemo(() => {
    return sources.filter((s) => {
      if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.kind.includes(search.toLowerCase())) return false;
      if (categoryFilter) {
        const def = SOURCE_KINDS.find((k) => k.kind === s.kind);
        if (def?.category !== categoryFilter) return false;
      }
      if (statusFilter) {
        const status = getHealthStatus(s);
        if (status !== statusFilter) return false;
      }
      return true;
    });
  }, [sources, search, categoryFilter, statusFilter]);

  const groupedSources = useMemo(() => {
    const map: Record<string, Source[]> = {};
    for (const s of filteredSources) {
      const def = SOURCE_KINDS.find((k) => k.kind === s.kind);
      const cat = def?.category ?? 'Other';
      if (!map[cat]) map[cat] = [];
      map[cat].push(s);
    }
    return map;
  }, [filteredSources]);

  const toggleSource = async (id: string, enabled: boolean) => {
    await fetch(`/api/sources/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
  };

  const bulkToggle = async (enable: boolean) => {
    await Promise.all(
      Array.from(selectedSources).map((id) =>
        fetch(`/api/sources/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enable }),
        }),
      ),
    );
    setSelectedSources(new Set());
    refreshSources();
  };

  const bulkDelete = async () => {
    if (!confirm(`Delete ${selectedSources.size} sources?`)) return;
    await Promise.all(
      Array.from(selectedSources).map((id) => fetch(`/api/sources/${id}`, { method: 'DELETE' })),
    );
    setSelectedSources(new Set());
    refreshSources();
  };

  const deleteSource = async (id: string) => {
    if (!confirm('Delete this source?')) return;
    await fetch(`/api/sources/${id}`, { method: 'DELETE' });
    refreshSources();
  };

  const updateSourceConfig = async () => {
    if (!editingSource) return;
    await fetch(`/api/sources/${editingSource.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editingSource.name,
        pollIntervalSeconds: editingSource.pollIntervalSeconds,
        config: editingSource.config,
      }),
    });
    setEditingSource(null);
    refreshSources();
  };

  const submitNewSource = async () => {
    setFormError('');
    setFormSuccess('');
    const kindDef = SOURCE_KINDS.find((k) => k.kind === selectedKind);
    if (!kindDef) { setFormError('Select a source type'); return; }
    if (!formName.trim()) { setFormError('Name is required'); return; }

    const config: Record<string, unknown> = {};
    for (const field of kindDef.fields) {
      const val = formConfig[field.key];
      if (field.required && (!val || val.trim() === '')) {
        setFormError(`${field.label} is required`); return;
      }
      if (field.type === 'number' && val) config[field.key] = Number(val);
      else if (val) config[field.key] = val;
    }

    const res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: selectedKind, name: formName.trim(), config, enabled: true, pollIntervalSeconds: formInterval }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      setFormError(err.error ?? 'Failed'); return;
    }
    setFormSuccess('Source created');
    setFormName(''); setFormConfig({}); setSelectedKind('');
    refreshSources();
    setTimeout(() => setFormSuccess(''), 3000);
  };

  // Libraries
  const importCategory = async (categoryKey: string) => {
    const res = await fetch(`/api/library/webcams?category=${categoryKey}`);
    const data = await res.json();
    const names = (data.webcams ?? []).map((w: { name: string }) => w.name);
    await fetch('/api/library/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) });
    refreshSources();
  };

  const importIpCameraCategory = async (categoryKey: string) => {
    const res = await fetch(`/api/ipcameras/cameras?category=${categoryKey}`);
    const data = await res.json();
    const names = (data.cameras ?? []).map((c: { name: string }) => c.name);
    await fetch('/api/ipcameras/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) });
    refreshSources();
  };

  const searchWindy = async () => {
    setWindyLoading(true);
    const params = new URLSearchParams();
    params.set('limit', '20');
    if (windyCountry) params.set('country', windyCountry);
    if (windyCategory) params.set('category', windyCategory);
    if (windyQuery) params.set('q', windyQuery);
    try {
      const res = await fetch(`/api/windy/search?${params.toString()}`);
      const data = await res.json();
      setWindyResults(Array.isArray(data.webcams) ? data.webcams : data.webcams?.data ?? []);
    } finally { setWindyLoading(false); }
  };

  const toggleWindySelection = (id: string) => {
    setSelectedWindy((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const importSelectedWindy = async () => {
    const toImport = windyResults.filter((w) => selectedWindy.has(w.webcamId));
    if (toImport.length === 0) return;
    await fetch('/api/windy/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webcams: toImport }) });
    setSelectedWindy(new Set());
    refreshSources();
  };

  const toggleSelect = (id: string) => {
    setSelectedSources((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const toggleSelectAll = () => {
    const allIds = new Set(filteredSources.map((s) => s.id));
    const allSelected = filteredSources.every((s) => selectedSources.has(s.id));
    setSelectedSources(allSelected ? new Set() : allIds);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Sub-nav */}
      <div style={{ display: 'flex', gap: 8, padding: '0 20px', borderBottom: '1px solid var(--wm-border)' }}>
        {([
          { key: 'sources' as Tab, label: 'Sources', count: sources.length },
          { key: 'add' as Tab, label: 'Add Source', count: null },
          { key: 'libraries' as Tab, label: 'Libraries', count: null },
        ]).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`wm-tab${tab === t.key ? ' wm-tab--active' : ''}`}>
            {t.label} {t.count !== null && `(${t.count})`}
          </button>
        ))}
      </div>

      {/* Sources List */}
      {tab === 'sources' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Filters + Bulk */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="wm-input" type="text" placeholder="Search sources..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 180 }} />
            <select className="wm-select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">All categories</option>
              {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="wm-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All status</option>
              <option value="healthy">Healthy</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
              <option value="disabled">Disabled</option>
            </select>
            {(search || categoryFilter || statusFilter) && (
              <button className="wm-btn" onClick={() => { setSearch(''); setCategoryFilter(''); setStatusFilter(''); }}>
                Clear
              </button>
            )}
          </div>

          {/* Bulk actions */}
          {selectedSources.size > 0 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, padding: '8px 12px', background: `rgba(${rgb(colors.info)}, 0.12)`, borderRadius: 3, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: colors.info, fontWeight: 500 }}>{selectedSources.size} selected</span>
              <button onClick={() => bulkToggle(true)} style={{ padding: '4px 10px', borderRadius: 3, border: 'none', background: colors.normal, color: '#0a0a0a', cursor: 'pointer', fontSize: 12 }}>Enable</button>
              <button onClick={() => bulkToggle(false)} style={{ padding: '4px 10px', borderRadius: 3, border: 'none', background: colors.elevated, color: '#0a0a0a', cursor: 'pointer', fontSize: 12 }}>Disable</button>
              <button onClick={bulkDelete} style={{ padding: '4px 10px', borderRadius: 3, border: 'none', background: colors.critical, color: '#0a0a0a', cursor: 'pointer', fontSize: 12 }}>Delete</button>
            </div>
          )}

          <div style={{ fontSize: 13, color: 'var(--wm-dim)', marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={filteredSources.length > 0 && filteredSources.every((s) => selectedSources.has(s.id))}
                onChange={toggleSelectAll} />
              <span>Select all</span>
            </label>
            <span>{filteredSources.length} of {sources.length} sources</span>
            <span>·</span>
            <span>{sources.filter((s) => s.enabled).length} enabled</span>
            <span>·</span>
            <span style={{ color: colors.critical }}>{sources.filter((s) => s.errorCount > 0).length} with errors</span>
          </div>

          {loading ? (
            <div style={{ color: 'var(--wm-dim)', padding: 40 }}>Loading sources...</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {CATEGORY_ORDER.map((cat) => {
                const catSources = groupedSources[cat];
                if (!catSources || catSources.length === 0) return null;
                return (
                  <div key={cat}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className="wm-dot" style={{ background: CATEGORY_COLORS[cat] || colors.dim }} />
                      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--wm-text-2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{cat}</h3>
                      <span style={{ fontSize: 12, color: 'var(--wm-muted)' }}>({catSources.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {catSources.map((source) => {
                        const health = getHealthStatus(source);
                        const isSelected = selectedSources.has(source.id);
                        return (
                          <div key={source.id} className="wm-card" style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 14px',
                            background: isSelected ? `rgba(${rgb(colors.info)}, 0.12)` : undefined,
                            borderColor: isSelected ? colors.info : undefined,
                          }}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(source.id)} />
                            <div className="wm-dot" style={{ background: HEALTH_DOT[health] }} title={health} />
                            <div style={{ fontSize: 18 }}>{kindIcons[source.kind] ?? '📡'}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 14, color: source.enabled ? 'var(--wm-text)' : 'var(--wm-muted)' }}>{source.name}</div>
                              <div className="wm-meta" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                                <span style={{ textTransform: 'capitalize' }}>{source.kind.replace(/_/g, ' ')}</span>
                                <span>·</span>
                                <span>poll {source.pollIntervalSeconds}s</span>
                                <span>·</span>
                                <span>last: {source.lastPolledAt ? new Date(source.lastPolledAt).toLocaleTimeString() : 'never'}</span>
                                {source.lastEventAt && <span>· event: {new Date(source.lastEventAt).toLocaleTimeString()}</span>}
                                {source.errorCount > 0 && <span style={{ color: colors.critical }}>· ⚠️ {source.errorCount} errors</span>}
                              </div>
                              {source.lastError && (
                                <div style={{ fontSize: 10, color: colors.critical, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {source.lastError}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => toggleSource(source.id, source.enabled)} style={{
                                padding: '5px 12px', borderRadius: 3, border: 'none',
                                background: source.enabled ? colors.normal : colors.muted, color: '#0a0a0a', cursor: 'pointer', fontSize: 12,
                              }}>
                                {source.enabled ? 'On' : 'Off'}
                              </button>
                              <button className="wm-btn" onClick={() => setEditingSource(source)} style={{ padding: '5px 10px', fontSize: 12 }}>
                                Edit
                              </button>
                              <button className="wm-btn wm-btn--danger" onClick={() => deleteSource(source.id)} style={{ padding: '5px 10px', fontSize: 12 }}>
                                🗑️
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Edit Modal */}
      {editingSource && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setEditingSource(null)}>
          <div className="wm-card" style={{ padding: 24, width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>Edit Source</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 500 }}>Name</label>
                <input className="wm-input" value={editingSource.name} onChange={(e) => setEditingSource({ ...editingSource, name: e.target.value })}
                  style={{ width: '100%', marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 500 }}>Poll interval (seconds)</label>
                <input className="wm-input" type="number" min={10} max={86400} value={editingSource.pollIntervalSeconds}
                  onChange={(e) => setEditingSource({ ...editingSource, pollIntervalSeconds: Number(e.target.value) })}
                  style={{ width: '100%', marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 500 }}>Config (JSON)</label>
                <textarea className="wm-input" value={JSON.stringify(editingSource.config, null, 2)}
                  onChange={(e) => { try { setEditingSource({ ...editingSource, config: JSON.parse(e.target.value) }); } catch { /* ignore */ } }}
                  rows={8}
                  style={{ width: '100%', marginTop: 4, fontSize: 13, fontFamily: 'var(--wm-font-mono)' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="wm-btn wm-btn--primary" onClick={updateSourceConfig} style={{ flex: 1, padding: '10px' }}>Save</button>
                <button className="wm-btn" onClick={() => setEditingSource(null)} style={{ flex: 1, padding: '10px' }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Source */}
      {tab === 'add' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <h2 style={{ margin: '0 0 20px' }}>Add Intelligence Source</h2>

          {!selectedKind ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {CATEGORY_ORDER.map((cat) => {
                const kinds = SOURCE_KINDS.filter((k) => k.category === cat);
                return (
                  <div key={cat}>
                    <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: CATEGORY_COLORS[cat] || 'var(--wm-text-2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {cat}
                    </h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                      {kinds.map((k) => (
                        <button key={k.kind} className="wm-card wm-card--hover" onClick={() => {
                          setSelectedKind(k.kind);
                          const defaults: Record<string, string> = {};
                          for (const f of k.fields) { if (f.defaultValue) defaults[f.key] = f.defaultValue; }
                          setFormConfig(defaults);
                          setFormError('');
                        }} style={{
                          padding: 14, color: 'var(--wm-text)',
                          cursor: 'pointer', textAlign: 'left', fontSize: 14,
                        }}>
                          <div style={{ fontSize: 22, marginBottom: 4 }}>{k.icon}</div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{k.label}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ maxWidth: 600 }}>
              <button className="wm-btn" onClick={() => { setSelectedKind(''); setFormError(''); }} style={{ marginBottom: 16, padding: '6px 12px', fontSize: 13 }}>← Back to types</button>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500 }}>Source Name *</label>
                  <input className="wm-input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={`e.g. My ${SOURCE_KINDS.find((k) => k.kind === selectedKind)?.label}`}
                    style={{ width: '100%', marginTop: 4 }} />
                </div>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500 }}>Poll Interval (seconds)</label>
                  <input className="wm-input" type="number" min={10} max={86400} value={formInterval} onChange={(e) => setFormInterval(Number(e.target.value))}
                    style={{ width: '100%', marginTop: 4 }} />
                  <div style={{ fontSize: 11, color: 'var(--wm-muted)', marginTop: 2 }}>{Math.round(formInterval / 60)} minutes</div>
                </div>
                {SOURCE_KINDS.find((k) => k.kind === selectedKind)?.fields.map((field) => (
                  <div key={field.key}>
                    <label style={{ fontSize: 13, fontWeight: 500 }}>{field.label}{field.required && <span style={{ color: colors.critical }}> *</span>}</label>
                    {field.type === 'select' ? (
                      <select className="wm-select" value={formConfig[field.key] ?? field.defaultValue ?? ''} onChange={(e) => setFormConfig({ ...formConfig, [field.key]: e.target.value })}
                        style={{ width: '100%', marginTop: 4 }}>
                        {field.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input className="wm-input" type={field.type === 'password' ? 'password' : field.type} value={formConfig[field.key] ?? ''}
                        onChange={(e) => setFormConfig({ ...formConfig, [field.key]: e.target.value })}
                        placeholder={field.placeholder}
                        style={{ width: '100%', marginTop: 4 }} />
                    )}
                  </div>
                ))}
                {formError && <div style={{ padding: '10px 12px', borderRadius: 3, background: `rgba(${rgb(colors.critical)}, 0.12)`, color: colors.critical, fontSize: 13 }}>{formError}</div>}
                {formSuccess && <div style={{ padding: '10px 12px', borderRadius: 3, background: `rgba(${rgb(colors.live)}, 0.12)`, color: colors.live, fontSize: 13 }}>{formSuccess}</div>}
                <button className="wm-btn wm-btn--primary" onClick={submitNewSource} style={{ padding: '10px 20px', fontSize: 15, marginTop: 4 }}>Create Source</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Libraries */}
      {tab === 'libraries' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Windy */}
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>🌬️ Windy Webcams</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <input className="wm-input" placeholder="Country (e.g. CH, US)" value={windyCountry} onChange={(e) => setWindyCountry(e.target.value)}
              style={{ minWidth: 160 }} />
            <input className="wm-input" placeholder="Category" value={windyCategory} onChange={(e) => setWindyCategory(e.target.value)}
              style={{ minWidth: 160 }} />
            <input className="wm-input" placeholder="Query" value={windyQuery} onChange={(e) => setWindyQuery(e.target.value)}
              style={{ minWidth: 160 }} />
            <button className="wm-btn wm-btn--primary" onClick={searchWindy} disabled={windyLoading}>
              {windyLoading ? '...' : 'Search'}
            </button>
          </div>
          {selectedWindy.size > 0 && (
            <div style={{ marginBottom: 12 }}>
              <button className="wm-btn wm-btn--primary" onClick={importSelectedWindy} style={{ fontSize: 13 }}>
                Import {selectedWindy.size} selected
              </button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 32 }}>
            {windyResults.map((cam) => {
              const camSelected = selectedWindy.has(cam.webcamId);
              return (
              <div key={cam.webcamId} className="wm-card wm-card--hover" onClick={() => toggleWindySelection(cam.webcamId)} style={{
                padding: 10, cursor: 'pointer', position: 'relative',
                borderColor: camSelected ? colors.info : undefined,
              }}>
                {cam.images?.current?.preview && (
                  <img src={cam.images.current.preview} alt={cam.title ?? 'webcam'}
                    style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 3, marginBottom: 6 }} loading="lazy" />
                )}
                <div style={{ fontWeight: 600, fontSize: 13 }}>{cam.title ?? `Webcam ${cam.webcamId}`}</div>
                <div style={{ fontSize: 11, color: 'var(--wm-dim)' }}>{[cam.location?.city, cam.location?.country].filter(Boolean).join(', ')}</div>
                {camSelected && (
                  <div style={{ position: 'absolute', top: 6, right: 6, background: colors.info, color: '#0a0a0a', borderRadius: 12, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✓</div>
                )}
              </div>
              );
            })}
          </div>

          {/* Webcam Library */}
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>📹 Webcam Library</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 32 }}>
            {library.map((cat) => (
              <div key={cat.key} className="wm-card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{cat.name}</div>
                <div style={{ fontSize: 12, color: 'var(--wm-dim)', marginBottom: 10 }}>{cat.count} cameras</div>
                <button className="wm-btn wm-btn--primary" onClick={() => importCategory(cat.key)}
                  style={{ width: '100%', padding: '7px 12px', fontSize: 13 }}>
                  Import All
                </button>
              </div>
            ))}
          </div>

          {/* IP Camera Library */}
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>📡 IP Camera Library</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {ipCameraLibrary.map((cat) => (
              <div key={cat.key} className="wm-card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{cat.name}</div>
                <div style={{ fontSize: 12, color: 'var(--wm-dim)', marginBottom: 10 }}>{cat.count} cameras</div>
                <button className="wm-btn" onClick={() => importIpCameraCategory(cat.key)}
                  style={{ width: '100%', padding: '7px 12px', fontSize: 13, borderColor: colors.info, color: colors.info }}>
                  Import All
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
