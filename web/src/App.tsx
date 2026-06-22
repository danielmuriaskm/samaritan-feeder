import { useState, type ReactElement } from 'react';
import { useEventStream } from './lib/useSSE.js';
import Overview from './components/Overview.js';
import MapView from './components/MapView.js';
import EventFeed from './components/EventFeed.js';
import LiveFeed from './components/LiveFeed.js';
import SignalsPanel from './components/SignalsPanel.js';
import SourceHealthPanel from './components/SourceHealthPanel.js';
import BriefPanel from './components/BriefPanel.js';
import ChannelsPanel from './components/ChannelsPanel.js';
import SourcePanel from './components/SourcePanel.js';
import DashboardStats from './components/DashboardStats.js';
import GraphView from './components/GraphView.js';
import MitreMatrixView from './components/MitreMatrixView.js';
import OsintHub from './components/OsintHub.js';
import DiscoverPanel from './components/DiscoverPanel.js';

type TabKey =
  | 'overview' | 'map' | 'events' | 'live' | 'signals' | 'health'
  | 'brief' | 'discover' | 'channels' | 'sources' | 'graph' | 'mitre' | 'osint' | 'stats';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  // Header status only — a lightweight live tap on the SSE spine.
  const live = useEventStream('operator', { max: 100 });

  const tabs: { key: TabKey; label: string; component: ReactElement }[] = [
    { key: 'overview', label: '🌐 Overview', component: <Overview /> },
    { key: 'map', label: '🗺️ Map', component: <MapView /> },
    { key: 'events', label: '📋 Events', component: <EventFeed /> },
    { key: 'live', label: '⚡ Live', component: <LiveFeed /> },
    { key: 'signals', label: '🔀 Signals', component: <SignalsPanel /> },
    { key: 'health', label: '🩺 Health', component: <SourceHealthPanel /> },
    { key: 'brief', label: '📰 Brief', component: <BriefPanel /> },
    { key: 'discover', label: '🧭 Discover', component: <DiscoverPanel /> },
    { key: 'channels', label: '📣 Channels', component: <ChannelsPanel /> },
    { key: 'sources', label: '📡 Sources', component: <SourcePanel /> },
    { key: 'graph', label: '🔗 Graph', component: <GraphView /> },
    { key: 'mitre', label: '🛡️ ATT&CK', component: <MitreMatrixView /> },
    { key: 'osint', label: '🧰 OSINT', component: <OsintHub /> },
    { key: 'stats', label: '📊 Stats', component: <DashboardStats /> },
  ];

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 14px',
          height: 46,
          background: 'var(--wm-panel)',
          borderBottom: '1px solid var(--wm-border)',
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: 'var(--wm-text)',
            flex: '0 0 auto',
          }}
        >
          🧠 Samaritan Feeder
        </span>

        <nav style={{ display: 'flex', gap: 2, overflowX: 'auto', flex: 1 }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`wm-tab${activeTab === tab.key ? ' wm-tab--active' : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '0 0 auto' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }} className="wm-meta">
            <span
              className={`wm-dot wm-dot--glow${live.connected ? ' wm-live-dot' : ''}`}
              style={{
                background: live.connected ? 'var(--wm-live)' : 'var(--wm-critical)',
                color: live.connected ? 'var(--wm-live)' : 'var(--wm-critical)',
              }}
            />
            {live.connected ? 'LIVE' : 'OFFLINE'}
          </span>
          <span className="wm-meta" title="live events · signals this session">
            {live.events.length} ev · {live.signals.length} sig
          </span>
        </div>
      </header>

      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {tabs.map((tab) => (
          <div
            key={tab.key}
            style={{
              position: 'absolute',
              inset: 0,
              display: activeTab === tab.key ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            {tab.component}
          </div>
        ))}
      </main>
    </div>
  );
}
