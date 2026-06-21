import { useEffect, useState } from 'react';

interface MatrixCell {
  id: string;
  name: string;
  eventCount: number;
}

interface MatrixData {
  tactics: string[];
  matrix: Record<string, MatrixCell[]>;
}

const TACTIC_COLORS: Record<string, string> = {
  'Reconnaissance': '#6366f1',
  'Resource Development': '#8b5cf6',
  'Initial Access': '#ef4444',
  'Execution': '#f97316',
  'Persistence': '#f59e0b',
  'Privilege Escalation': '#eab308',
  'Defense Evasion': '#84cc16',
  'Credential Access': '#22c55e',
  'Discovery': '#10b981',
  'Lateral Movement': '#06b6d4',
  'Collection': '#0ea5e9',
  'Command and Control': '#3b82f6',
  'Exfiltration': '#6366f1',
  'Impact': '#a855f7',
};

export default function MitreMatrixView() {
  const [data, setData] = useState<MatrixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTechnique, setSelectedTechnique] = useState<MatrixCell | null>(null);
  const [techniqueEvents, setTechniqueEvents] = useState<Array<{ id: string; title?: string; content: string; eventAt: number }>>([]);

  useEffect(() => {
    loadMatrix();
  }, []);

  const loadMatrix = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mitre/matrix');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MatrixData;
      setData(json);
    } catch (err) {
      console.error('Failed to load MITRE matrix:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTechniqueEvents = async (techniqueId: string) => {
    try {
      const res = await fetch(`/api/mitre/events?techniqueId=${encodeURIComponent(techniqueId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { events: Array<{ id: string; title?: string; content: string; eventAt: number }> };
      setTechniqueEvents(json.events ?? []);
    } catch (err) {
      console.error('Failed to load technique events:', err);
      setTechniqueEvents([]);
    }
  };

  const maxCount = data
    ? Math.max(
        1,
        ...Object.values(data.matrix).flatMap((cells) => cells.map((c) => c.eventCount)),
      )
    : 1;

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
        Loading MITRE ATT&CK matrix...
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#ef4444' }}>
        Failed to load MITRE ATT&CK data.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: '#f8fafc' }}>
      {/* Matrix */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 20, color: '#1e293b' }}>
          🛡️ MITRE ATT&CK Matrix
        </h2>

        <div style={{ display: 'flex', gap: 12, minWidth: 1200 }}>
          {data.tactics.map((tactic) => {
            const cells = data.matrix[tactic] ?? [];
            const color = TACTIC_COLORS[tactic] || '#64748b';

            return (
              <div key={tactic} style={{ flex: 1, minWidth: 140 }}>
                <div
                  style={{
                    background: color,
                    color: '#fff',
                    padding: '8px 10px',
                    borderRadius: '6px 6px 0 0',
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: 'center',
                    minHeight: 48,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {tactic}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
                  {cells.slice(0, 20).map((cell) => {
                    const intensity = cell.eventCount / maxCount;
                    const bgColor = intensity > 0 ? `rgba(${hexToRgb(color)}, ${0.1 + intensity * 0.85})` : '#f1f5f9';
                    const textColor = intensity > 0.5 ? '#fff' : '#334155';

                    return (
                      <button
                        key={cell.id}
                        onClick={() => {
                          setSelectedTechnique(cell);
                          fetchTechniqueEvents(cell.id);
                        }}
                        style={{
                          background: bgColor,
                          color: textColor,
                          border: selectedTechnique?.id === cell.id ? `2px solid ${color}` : '1px solid #e2e8f0',
                          borderRadius: 4,
                          padding: '6px 8px',
                          fontSize: 11,
                          textAlign: 'left',
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                          lineHeight: 1.3,
                        }}
                        onMouseEnter={(e) => {
                          (e.target as HTMLButtonElement).style.transform = 'scale(1.02)';
                        }}
                        onMouseLeave={(e) => {
                          (e.target as HTMLButtonElement).style.transform = 'scale(1)';
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{cell.id}</div>
                        <div style={{ fontSize: 10, opacity: 0.9 }}>{cell.name}</div>
                        {cell.eventCount > 0 && (
                          <div style={{ fontSize: 10, marginTop: 2, fontWeight: 700 }}>
                            {cell.eventCount} event{cell.eventCount > 1 ? 's' : ''}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail panel */}
      {selectedTechnique && (
        <div
          style={{
            width: 360,
            padding: 20,
            background: '#fff',
            borderLeft: '1px solid #e2e8f0',
            overflow: 'auto',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#1e293b' }}>
            {selectedTechnique.id}: {selectedTechnique.name}
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b' }}>
            {selectedTechnique.eventCount} event{selectedTechnique.eventCount !== 1 ? 's' : ''} detected
          </p>

          <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#334155' }}>Events</h4>
          {techniqueEvents.length === 0 && (
            <p style={{ fontSize: 12, color: '#94a3b8' }}>No events tagged with this technique.</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {techniqueEvents.map((ev) => (
              <div
                key={ev.id}
                style={{
                  padding: 10,
                  background: '#f8fafc',
                  borderRadius: 6,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4, color: '#1e293b' }}>
                  {ev.title || 'Untitled'}
                </div>
                <div style={{ color: '#64748b', lineHeight: 1.4 }}>{ev.content.slice(0, 200)}...</div>
                <div style={{ color: '#94a3b8', marginTop: 4, fontSize: 11 }}>
                  {new Date(ev.eventAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '99, 102, 241';
  return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
}
