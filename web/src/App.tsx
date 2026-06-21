import { useState } from 'react';
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

export default function App() {
  const [activeTab, setActiveTab] = useState<
    'map' | 'events' | 'live' | 'signals' | 'health' | 'brief' | 'channels' | 'sources' | 'stats' | 'graph' | 'mitre' | 'osint'
  >('map');

  const tabs = [
    { key: 'map' as const, label: '🗺️ Map', component: <MapView /> },
    { key: 'events' as const, label: '📋 Events', component: <EventFeed /> },
    { key: 'live' as const, label: '⚡ Live', component: <LiveFeed /> },
    { key: 'signals' as const, label: '🔀 Signals', component: <SignalsPanel /> },
    { key: 'health' as const, label: '🩺 Health', component: <SourceHealthPanel /> },
    { key: 'brief' as const, label: '📰 Brief', component: <BriefPanel /> },
    { key: 'channels' as const, label: '📣 Channels', component: <ChannelsPanel /> },
    { key: 'sources' as const, label: '📡 Sources', component: <SourcePanel /> },
    { key: 'graph' as const, label: '🔗 Graph', component: <GraphView /> },
    { key: 'mitre' as const, label: '🛡️ ATT&CK', component: <MitreMatrixView /> },
    { key: 'osint' as const, label: '🧰 OSINT', component: <OsintHub /> },
    { key: 'stats' as const, label: '📊 Stats', component: <DashboardStats /> },
  ];

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: '12px 20px', background: '#111', color: '#fff', display: 'flex', alignItems: 'center', gap: 24 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>🧠 Samaritan Intelligence Feeder</h1>
        <nav style={{ display: 'flex', gap: 8 }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: activeTab === tab.key ? '#333' : 'transparent',
                color: '#fff',
                border: 'none',
                padding: '6px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
                whiteSpace: 'nowrap',
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>
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
