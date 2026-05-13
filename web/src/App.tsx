import { useState } from 'react';
import MapView from './components/MapView.js';
import EventFeed from './components/EventFeed.js';
import SourcePanel from './components/SourcePanel.js';
import DashboardStats from './components/DashboardStats.js';

export default function App() {
  const [activeTab, setActiveTab] = useState<'map' | 'events' | 'sources' | 'stats'>('map');

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: '12px 20px', background: '#111', color: '#fff', display: 'flex', alignItems: 'center', gap: 24 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>🧠 Samaritan Intelligence Feeder</h1>
        <nav style={{ display: 'flex', gap: 16 }}>
          {(['map', 'events', 'sources', 'stats'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: activeTab === tab ? '#333' : 'transparent',
                color: '#fff',
                border: 'none',
                padding: '6px 14px',
                borderRadius: 4,
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {tab}
            </button>
          ))}
        </nav>
      </header>

      <main style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'map' && <MapView />}
        {activeTab === 'events' && <EventFeed />}
        {activeTab === 'sources' && <SourcePanel />}
        {activeTab === 'stats' && <DashboardStats />}
      </main>
    </div>
  );
}
