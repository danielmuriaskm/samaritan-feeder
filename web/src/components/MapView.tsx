import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';

interface WebcamMarker {
  name: string;
  lat: number;
  lon: number;
  category: string;
  country: string;
  url: string;
}

interface IntelEvent {
  id: string;
  sourceId: string;
  kind: string;
  title?: string;
  content: string;
  location?: { lat: number; lon: number };
  confidence: number;
  eventAt: number;
}

const categoryColors: Record<string, string> = {
  traffic: '#ef4444',
  beach: '#06b6d4',
  city: '#8b5cf6',
  nature: '#22c55e',
  ski: '#3b82f6',
  weather: '#f59e0b',
};

function createIcon(color: string) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="width:14px;height:14px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export default function MapView() {
  const [webcams, setWebcams] = useState<WebcamMarker[]>([]);
  const [events, setEvents] = useState<IntelEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/library/webcams').then((r) => r.json()),
      fetch('/api/events?limit=200').then((r) => r.json()),
    ])
      .then(([lib, ev]) => {
        setWebcams(lib.webcams ?? []);
        setEvents(ev.events ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 40 }}>Loading map...</div>;

  return (
    <MapContainer center={[20, 0]} zoom={2} style={{ height: '100%', width: '100%' }}>
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      {webcams.map((w) => (
        <Marker key={w.name} position={[w.lat, w.lon]} icon={createIcon(categoryColors[w.category] ?? '#999')}>
          <Popup>
            <div style={{ minWidth: 200 }}>
              <strong>{w.name}</strong>
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                {w.country} · {w.category}
              </div>
              <div style={{ marginTop: 8, fontSize: 11 }}>
                <a href={w.url} target="_blank" rel="noreferrer">View source</a>
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
      {events
        .filter((e) => e.location)
        .map((e) => (
          <Circle
            key={e.id}
            center={[e.location!.lat, e.location!.lon]}
            radius={5000}
            pathOptions={{
              color: e.confidence > 0.8 ? '#ef4444' : e.confidence > 0.5 ? '#f59e0b' : '#22c55e',
              fillOpacity: 0.3,
            }}
          >
            <Popup>
              <div style={{ minWidth: 180 }}>
                <strong>{e.title ?? e.kind}</strong>
                <div style={{ fontSize: 12, marginTop: 4 }}>{e.content.slice(0, 120)}...</div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                  Confidence: {Math.round(e.confidence * 100)}%
                </div>
              </div>
            </Popup>
          </Circle>
        ))}
    </MapContainer>
  );
}
