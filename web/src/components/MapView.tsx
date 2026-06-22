import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import Hls from 'hls.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { colors, categoryColors, rgb } from '../lib/theme.js';
import { getAircraft, getShips, type Aircraft, type Ship } from '../lib/api.js';
import {
  ALT_BANDS,
  altBandFor,
  altitudeToColor,
  aircraftCategory,
  shipCategory,
  TrailStore,
  type AircraftCat,
  type ShipCat,
} from '../lib/radar.js';

interface Camera {
  name: string;
  lat: number;
  lon: number;
  category: string;
  country: string;
  region?: string;
  streamUrl?: string | null;
  infoUrl?: string;
  provider?: string;
  streamType?: string;
  embedId?: string;
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

// Marker fill map, sourced from the worldmonitor neon tokens (theme.ts). Keys are the
// camera categories this view sees; values map to the closest semantic/category hue.
const CATEGORY_COLORS: Record<string, string> = {
  traffic: categoryColors.traffic, // orange
  beach: categoryColors.beach, // blue
  city: colors.purple,
  nature: colors.normal, // green
  ski: colors.low, // blue
  weather: categoryColors.weather, // teal
  coastal: categoryColors.beach, // blue
  mountain: colors.normal, // green
  desert: colors.elevated, // amber
  rural: colors.normal, // green
  urban: colors.purple,
  highway: categoryColors.traffic, // orange
  bridge: colors.purple,
  windy: colors.pink,
  alert: categoryColors.alert, // red
  anomaly: categoryColors.anomaly, // orange
  unknown: colors.dim,
};

// Categories that should read as alerts get a subtle neon glow on their divIcon.
const ALERT_CATEGORIES = new Set(['alert', 'anomaly', 'traffic', 'highway']);

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category.toLowerCase()] ?? CATEGORY_COLORS[category] ?? colors.dim;
}

function createIcon(color: string, glow = false) {
  const shadow = glow
    ? `box-shadow:0 0 6px ${color};`
    : 'box-shadow:0 1px 4px rgba(0,0,0,0.4);';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="width:12px;height:12px;background:${color};border-radius:50%;border:2px solid #fff;${shadow}"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.9)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'zoom-out',
        padding: 24,
      }}
    >
      <img
        src={src}
        alt="Fullscreen snapshot"
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          borderRadius: 8,
          objectFit: 'contain',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'rgba(255,255,255,0.15)',
          border: 'none',
          color: colors.accent,
          fontSize: 24,
          width: 40,
          height: 40,
          borderRadius: '50%',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(4px)',
        }}
        title="Close"
      >
        ×
      </button>
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          color: colors.dim,
          fontSize: 12,
          background: 'rgba(0,0,0,0.6)',
          padding: '6px 14px',
          borderRadius: 16,
        }}
      >
        Click anywhere to close
      </div>
    </div>
  );
}

function HlsPlayer({ url, posterUrl }: { url: string; posterUrl?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    setError(false);
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError(true);
          hls.destroy();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = url;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(() => {});
      });
      video.addEventListener('error', () => {
        setError(true);
      });
    } else {
      setError(true);
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [url]);

  if (error && posterUrl) {
    return (
      <div style={{ padding: 8 }}>
        <div style={{ padding: '8px 0', color: colors.dim, fontSize: 12, textAlign: 'center' }}>
          📡 Live stream offline — showing last snapshot
        </div>
        <img
          src={posterUrl}
          alt="Last snapshot"
          onClick={() => setLightbox(true)}
          style={{
            width: '100%',
            borderRadius: 6,
            background: colors.base,
            cursor: 'zoom-in',
          }}
        />
        {lightbox && <ImageLightbox src={posterUrl} onClose={() => setLightbox(false)} />}
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <a href={url} target="_blank" rel="noreferrer" style={{ color: colors.info, fontSize: 12 }}>
            Try live stream
          </a>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: colors.dim, fontSize: 13 }}>
        <div>❌ HLS playback failed.</div>
        <div style={{ marginTop: 8 }}>
          <a href={url} target="_blank" rel="noreferrer" style={{ color: colors.info, fontSize: 12 }}>
            Open stream directly
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 8 }}>
      <video
        ref={videoRef}
        controls
        muted
        autoPlay
        playsInline
        style={{ width: '100%', borderRadius: 6, background: '#000' }}
      />
    </div>
  );
}

function isImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.gif') ||
    lower.includes('snapshot') ||
    lower.includes('webcapture') ||
    lower.includes('camera') ||
    lower.includes('image') ||
    lower.includes('jpg') ||
    lower.includes('live') ||
    lower.includes('cam')
  );
}

function CameraPreview({ camera }: { camera: Camera }) {
  const [imgKey, setImgKey] = useState(0);
  const [imgError, setImgError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState(false);

  const type = (camera.streamType ?? 'image').toLowerCase();
  const url = camera.streamUrl || camera.infoUrl || '';

  const handleRefresh = useCallback(() => {
    setImgKey((k) => k + 1);
    setImgError(false);
    setLoading(true);
  }, []);

  if (!url) {
    return <div style={{ padding: 20, color: colors.dim, fontSize: 13, textAlign: 'center' }}>No stream URL available</div>;
  }

  if (type === 'rtsp') {
    return (
      <div style={{ padding: 16, color: colors.dim, fontSize: 13 }}>
        <div>🔒 RTSP stream cannot be played in-browser.</div>
        <div style={{ marginTop: 8 }}>
          <a href={url} target="_blank" rel="noreferrer" style={{ color: colors.info, fontSize: 12 }}>Open in VLC / external player</a>
        </div>
      </div>
    );
  }

  if (type === 'hls' || url.endsWith('.m3u8')) {
    const posterUrl = camera.embedId
      ? `/api/hispacams/poster?embedId=${camera.embedId}`
      : undefined;
    return <HlsPlayer key={url} url={url} posterUrl={posterUrl} />;
  }

  // image, mjpeg, or unknown — try <img>
  const isImg = type === 'image' || type === 'mjpeg' || isImageUrl(url);

  if (!isImg) {
    return (
      <div style={{ padding: 16, color: colors.dim, fontSize: 13 }}>
        <div>📄 HTML page — cannot embed preview.</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <a href={url} target="_blank" rel="noreferrer" style={{ color: colors.info, fontSize: 12 }}>Open page</a>
          {camera.infoUrl && camera.infoUrl !== url && (
            <a href={camera.infoUrl} target="_blank" rel="noreferrer" style={{ color: colors.info, fontSize: 12 }}>Info</a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 8 }}>
      {loading && (
        <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted, fontSize: 12 }}>
          Loading snapshot…
        </div>
      )}
      {!imgError ? (
        <img
          key={imgKey}
          src={url}
          alt={camera.name}
          onClick={() => setLightbox(true)}
          style={{ width: '100%', borderRadius: 6, display: loading ? 'none' : 'block', minHeight: 80, objectFit: 'cover', background: colors.base, cursor: 'zoom-in' }}
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setImgError(true);
          }}
        />
      ) : (
        <div style={{ padding: 20, color: colors.dim, fontSize: 13, textAlign: 'center' }}>
          <div>❌ Image failed to load</div>
          <div style={{ fontSize: 11, marginTop: 4, color: colors.muted }}>Camera may be offline or requires auth</div>
        </div>
      )}
      {lightbox && <ImageLightbox src={url} onClose={() => setLightbox(false)} />}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'center' }}>
        <button
          onClick={handleRefresh}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            borderRadius: 4,
            border: `1px solid ${colors.border}`,
            background: colors.base,
            color: colors.text,
            cursor: 'pointer',
          }}
        >
          🔄 Refresh
        </button>
        {camera.infoUrl && (
          <a
            href={camera.infoUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '4px 10px',
              fontSize: 11,
              borderRadius: 4,
              border: `1px solid ${colors.border}`,
              background: colors.base,
              color: colors.info,
              textDecoration: 'none',
              display: 'inline-block',
            }}
          >
            ℹ️ Info
          </a>
        )}
        {camera.streamUrl && camera.streamUrl !== camera.infoUrl && (
          <a
            href={camera.streamUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '4px 10px',
              fontSize: 11,
              borderRadius: 4,
              border: `1px solid ${colors.border}`,
              background: colors.base,
              color: colors.info,
              textDecoration: 'none',
              display: 'inline-block',
            }}
          >
            🔗 Direct
          </a>
        )}
      </div>
    </div>
  );
}

function MarkerClusterLayer({
  cameras,
  onCameraClick,
}: {
  cameras: Camera[];
  onCameraClick?: (cam: Camera) => void;
}) {
  const map = useMap();
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);

  useEffect(() => {
    const cluster = L.markerClusterGroup({
      chunkedLoading: true,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: true,
      zoomToBoundsOnClick: true,
      maxClusterRadius: 80,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        let size = 20 + Math.min(count * 2, 30);
        return L.divIcon({
          className: 'marker-cluster',
          html: `<div style="width:${size}px;height:${size}px;background:rgba(232,232,232,0.9);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#0a0a0a;font-weight:bold;font-size:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${count}</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
      },
    });

    const markers: L.Marker[] = [];
    for (const cam of cameras) {
      if (!cam.lat || !cam.lon) continue;
      const color = getCategoryColor(cam.category);
      const glow = ALERT_CATEGORIES.has(cam.category.toLowerCase());
      const marker = L.marker([cam.lat, cam.lon], { icon: createIcon(color, glow) });
      marker.bindPopup(
        `<div style="min-width:220px;">
          <strong style="font-size:13px;">${cam.name}</strong>
          <div style="font-size:11px;color:var(--wm-dim);margin-top:4px;">${cam.country}${cam.region ? ` · ${cam.region}` : ''} · ${cam.category}</div>
          ${cam.provider ? `<div style="font-size:10px;color:var(--wm-dim);margin-top:2px;">${cam.provider}</div>` : ''}
          <div style="margin-top:6px;font-size:11px;color:var(--wm-info);">👆 Click pin for live preview</div>
        </div>`
      );
      if (onCameraClick) {
        marker.on('click', () => onCameraClick(cam));
      }
      markers.push(marker);
    }

    cluster.addLayers(markers);
    map.addLayer(cluster);
    clusterRef.current = cluster;

    return () => {
      map.removeLayer(cluster);
      cluster.clearLayers();
    };
  }, [cameras, map, onCameraClick]);

  return null;
}

function EventLayer({ events }: { events: IntelEvent[] }) {
  const map = useMap();

  useEffect(() => {
    const circles: L.Circle[] = [];
    for (const e of events) {
      if (!e.location) continue;
      const circle = L.circle([e.location.lat, e.location.lon], {
        radius: 5000,
        color: e.confidence > 0.8 ? colors.critical : e.confidence > 0.5 ? colors.high : colors.normal,
        fillOpacity: 0.25,
        weight: 2,
      }).bindPopup(
        `<div style="min-width:180px;">
          <strong>${e.title ?? e.kind}</strong>
          <div style="font-size:11px;margin-top:4px;">${e.content.slice(0, 120)}...</div>
          <div style="font-size:10px;color:var(--wm-dim);margin-top:4px;">Confidence: ${Math.round(e.confidence * 100)}%</div>
        </div>`
      );
      circle.addTo(map);
      circles.push(circle);
    }
    return () => {
      for (const c of circles) c.removeFrom(map);
    };
  }, [events, map]);

  return null;
}

// ---- Live radar layers (ADS-B aircraft, AIS ships) ----------------------------
// Rotated, type-aware glyph markers colored by altitude band, with client-side
// position trails. Refetched on map move; trail history lives in the component.
// (Clean-room reimplementation of worldmonitor radar behaviors — see lib/radar.ts.)

// Aircraft glyphs vary by category; rotated so 0° heading points north.
function aircraftGlyph(cat: AircraftCat, color: string, rot: number, highlight: boolean): string {
  const ring = highlight ? `filter:drop-shadow(0 0 5px ${colors.accent});` : '';
  const glow = `text-shadow:0 0 4px ${color},0 1px 2px #000;`;
  switch (cat) {
    case 'heli':
      // Helicopter — non-directional rotor cross, no heading rotation.
      return `<div style="font-size:15px;line-height:1;color:${color};${glow}${ring}">✛</div>`;
    case 'ground':
      // On-ground vehicle/taxiing — small square, no rotation.
      return `<div style="width:7px;height:7px;background:${color};border:1px solid #000;${ring}"></div>`;
    case 'prop':
      // Prop/light — smaller plane glyph (✈ points NE by default → offset 45°).
      return `<div style="transform:rotate(${rot - 45}deg);font-size:13px;line-height:1;color:${color};${glow}${ring}">✈</div>`;
    case 'jet':
    default:
      // Jet/airliner — full-size plane glyph.
      return `<div style="transform:rotate(${rot - 45}deg);font-size:18px;line-height:1;color:${color};${glow}${ring}">✈</div>`;
  }
}

function aircraftIcon(a: Aircraft, highlight: boolean) {
  const cat = aircraftCategory(a);
  const color = altitudeToColor(a.alt);
  const rot = a.heading ?? 0;
  const sz = cat === 'jet' ? 20 : 16;
  return L.divIcon({
    className: 'radar-aircraft',
    html: aircraftGlyph(cat, color, rot, highlight),
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
  });
}

// Ship glyphs vary by category; the wedge points in the direction of travel.
function shipGlyph(cat: ShipCat, color: string, rot: number, highlight: boolean): string {
  const ring = highlight ? `filter:drop-shadow(0 0 5px ${colors.accent});` : `filter:drop-shadow(0 0 3px ${color});`;
  if (cat === 'passenger') {
    // Passenger/ferry — rounded dot with a heading wedge.
    return `<div style="transform:rotate(${rot}deg);width:10px;height:10px;background:${color};border-radius:50%;border:1.5px solid #fff;${ring}"></div>`;
  }
  if (cat === 'tanker') {
    // Tanker — wider, flatter wedge.
    return `<div style="transform:rotate(${rot}deg);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${color};${ring}"></div>`;
  }
  // cargo / other — narrow wedge (cargo slightly larger).
  const h = cat === 'cargo' ? 13 : 11;
  return `<div style="transform:rotate(${rot}deg);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:${h}px solid ${color};${ring}"></div>`;
}

function shipIcon(s: Ship, highlight: boolean) {
  const cat = shipCategory(s);
  const color = colors.low;
  const rot = s.heading ?? 0;
  return L.divIcon({
    className: 'radar-ship',
    html: shipGlyph(cat, color, rot, highlight),
    iconSize: [12, 13],
    iconAnchor: [6, 6.5],
  });
}

function aircraftPopupHtml(a: Aircraft): string {
  const band = altBandFor(a.alt);
  return `<div style="min-width:170px;">
      <strong style="font-size:13px;">✈ ${a.callsign ?? a.id}</strong>
      <div style="font-size:11px;color:var(--wm-dim);margin-top:4px;">${a.type ?? 'Unknown type'} · ${aircraftCategory(a)}</div>
      <div style="font-size:11px;color:var(--wm-dim);margin-top:2px;">
        <span style="color:${band.color};">●</span> ${a.alt != null ? `${a.alt.toLocaleString()} ft (${band.label})` : 'alt —'}
      </div>
      <div style="font-size:11px;color:var(--wm-dim);margin-top:2px;">
        ${a.speed != null ? `${Math.round(a.speed)} kt` : 'spd —'} ·
        ${a.heading != null ? `${Math.round(a.heading)}° hdg` : 'hdg —'}
      </div>
    </div>`;
}

function shipPopupHtml(s: Ship): string {
  return `<div style="min-width:170px;">
      <strong style="font-size:13px;">🚢 ${s.name ?? s.id}</strong>
      <div style="font-size:11px;color:var(--wm-dim);margin-top:4px;">MMSI ${s.id} · ${shipCategory(s)}${s.type ? ` (${s.type})` : ''}</div>
      <div style="font-size:11px;color:var(--wm-dim);margin-top:2px;">
        ${s.speed != null ? `${s.speed.toFixed(1)} kt` : 'spd —'} ·
        ${s.heading != null ? `${Math.round(s.heading)}° hdg` : 'hdg —'}
      </div>
    </div>`;
}

function AircraftLayer({
  aircraft,
  trails,
  followId,
  onSelect,
  onHover,
  highlightId,
}: {
  aircraft: Aircraft[];
  trails: TrailStore;
  followId: string | null;
  onSelect: (a: Aircraft | null) => void;
  onHover: (id: string | null) => void;
  highlightId: string | null;
}) {
  const map = useMap();
  useEffect(() => {
    const layers: L.Layer[] = [];
    for (const a of aircraft) {
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
      const highlight = a.id === highlightId || a.id === followId;

      // Fading trail polyline (altitude-colored), oldest → newest.
      const pts = trails.get(a.id);
      if (pts.length > 1) {
        const line = L.polyline(
          pts.map((p) => [p.lat, p.lon] as [number, number]),
          {
            color: altitudeToColor(a.alt),
            weight: highlight ? 2.5 : 1.5,
            opacity: highlight ? 0.85 : 0.5,
            dashArray: '6 4',
            interactive: false,
          },
        );
        line.addTo(map);
        layers.push(line);
      }

      const m = L.marker([a.lat, a.lon], { icon: aircraftIcon(a, highlight), zIndexOffset: highlight ? 900 : 500 });
      m.bindPopup(aircraftPopupHtml(a));
      m.on('mouseover', () => onHover(a.id));
      m.on('mouseout', () => onHover(null));
      m.on('click', () => onSelect(a));
      m.addTo(map);
      layers.push(m);
    }
    return () => {
      for (const l of layers) l.removeFrom(map);
    };
  }, [aircraft, trails, map, followId, onSelect, onHover, highlightId]);
  return null;
}

function ShipLayer({
  ships,
  trails,
  onHover,
  highlightId,
}: {
  ships: Ship[];
  trails: TrailStore;
  onHover: (id: string | null) => void;
  highlightId: string | null;
}) {
  const map = useMap();
  useEffect(() => {
    const layers: L.Layer[] = [];
    for (const s of ships) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const highlight = s.id === highlightId;

      const pts = trails.get(s.id);
      if (pts.length > 1) {
        const line = L.polyline(
          pts.map((p) => [p.lat, p.lon] as [number, number]),
          {
            color: colors.low,
            weight: highlight ? 2.5 : 1.5,
            opacity: highlight ? 0.8 : 0.45,
            dashArray: '5 4',
            interactive: false,
          },
        );
        line.addTo(map);
        layers.push(line);
      }

      const m = L.marker([s.lat, s.lon], { icon: shipIcon(s, highlight), zIndexOffset: highlight ? 800 : 400 });
      m.bindPopup(shipPopupHtml(s));
      m.on('mouseover', () => onHover(s.id));
      m.on('mouseout', () => onHover(null));
      m.addTo(map);
      layers.push(m);
    }
    return () => {
      for (const l of layers) l.removeFrom(map);
    };
  }, [ships, trails, map, onHover, highlightId]);
  return null;
}

// Stable empty store reused when trails are disabled (avoids re-renders).
const EMPTY_TRAILS = new TrailStore();

// Keeps the map centered on a followed aircraft as positions refresh.
function FollowController({ target }: { target: Aircraft | null }) {
  const map = useMap();
  useEffect(() => {
    if (target && Number.isFinite(target.lat) && Number.isFinite(target.lon)) {
      map.panTo([target.lat, target.lon], { animate: true, duration: 0.6 });
    }
  }, [target, map]);
  return null;
}

function MapFlyToListener() {
  const map = useMap();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.lat != null && detail?.lon != null) {
        map.flyTo([detail.lat, detail.lon], detail.zoom ?? 12, { duration: 1.5 });
      }
    };
    window.addEventListener('flyTo', handler);
    return () => window.removeEventListener('flyTo', handler);
  }, [map]);

  return null;
}

function MapBoundsListener({ onChange }: { onChange: (bounds: string, zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const update = () => {
      const b = map.getBounds();
      const zoom = map.getZoom();
      const boundsStr = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
      onChange(boundsStr, zoom);
    };

    // Initial bounds
    update();

    map.on('moveend', update);
    map.on('zoomend', update);
    return () => {
      map.off('moveend', update);
      map.off('zoomend', update);
    };
  }, [map, onChange]);

  return null;
}

function ResizablePanel({
  width,
  onResize,
  onMaximize,
  isMaximized,
  camera,
  onClose,
}: {
  width: number;
  onResize: (w: number) => void;
  onMaximize: () => void;
  isMaximized: boolean;
  camera: Camera;
  onClose: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const rect = panelRef.current.getBoundingClientRect();
      const newWidth = Math.max(320, Math.min(1200, e.clientX - rect.left));
      onResize(newWidth);
    };

    const handleUp = () => setIsDragging(false);

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging, onResize]);

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        bottom: 20,
        right: 20,
        width,
        maxHeight: '80vh',
        background: colors.panel,
        borderRadius: 10,
        border: `1px solid ${colors.border}`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {camera.name}
          </div>
          <div style={{ fontSize: 11, color: colors.dim, marginTop: 2 }}>
            {camera.country}
            {camera.region ? ` · ${camera.region}` : ''} · {camera.category}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={onMaximize}
            style={{
              background: 'transparent',
              border: 'none',
              color: colors.dim,
              fontSize: 14,
              cursor: 'pointer',
              lineHeight: 1,
              padding: 0,
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
            }}
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? '⤓' : '⤢'}
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: colors.dim,
              fontSize: 18,
              cursor: 'pointer',
              lineHeight: 1,
              padding: 0,
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
            }}
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* Preview */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        <CameraPreview camera={camera} />
      </div>

      {/* Resize handle */}
      {!isMaximized && (
        <div
          onMouseDown={() => setIsDragging(true)}
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: 20,
            height: 20,
            cursor: 'nwse-resize',
            background: `linear-gradient(135deg, transparent 50%, rgba(${rgb(colors.dim)},0.4) 50%)`,
            borderBottomRightRadius: 10,
          }}
          title="Drag to resize"
        />
      )}
    </div>
  );
}

export default function MapView() {
  const [viewportCameras, setViewportCameras] = useState<Camera[]>([]);
  const [events, setEvents] = useState<IntelEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [panelWidth, setPanelWidth] = useState(360);
  const [isMaximized, setIsMaximized] = useState(false);
  const [mapZoom, setMapZoom] = useState(2);
  const [boundsStr, setBoundsStr] = useState('');
  const [viewportLoading, setViewportLoading] = useState(false);

  // All categories / countries for filter dropdowns (fetched once)
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [allCountries, setAllCountries] = useState<string[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [showIpCameras, setShowIpCameras] = useState(true);
  const [showWebcams, setShowWebcams] = useState(true);
  const [showWindy, setShowWindy] = useState(true);
  const [showHlsOnly, setShowHlsOnly] = useState(false);
  const [showEvents, setShowEvents] = useState(true);
  const [showEventsFeed, setShowEventsFeed] = useState(true);

  // Live radar layers (on-demand, refetched on map move)
  const [showAircraft, setShowAircraft] = useState(false);
  const [showShips, setShowShips] = useState(false);
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [radarLoading, setRadarLoading] = useState(false);

  // Radar filters + interaction state.
  const [altMin, setAltMin] = useState(0); // feet; aircraft below this hidden
  const [altMax, setAltMax] = useState(50000); // feet; aircraft above this hidden
  const [showTrails, setShowTrails] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [followed, setFollowed] = useState<Aircraft | null>(null);

  // Client-side position trails (persist across refreshes). Stored in refs so
  // pushing samples doesn't trigger re-renders; a bump counter forces re-draw.
  const aircraftTrails = useRef(new TrailStore());
  const shipTrails = useRef(new TrailStore());

  const MAX_RENDERED = 600; // cap rendered markers per layer for performance

  // Fetch events + filter options once on mount
  useEffect(() => {
    let cancelled = false;

    cacheGet<{ events: IntelEvent[] }>('map-events')
      .then((cached) => {
        if (cancelled) return;
        if (cached?.events && Array.isArray(cached.events)) {
          setEvents(cached.events);
        }
      })
      .catch(() => {});

    Promise.all([
      fetch('/api/library').then((r) => (r.ok ? r.json() : Promise.reject(r.statusText))),
      fetch('/api/ipcameras').then((r) => (r.ok ? r.json() : Promise.reject(r.statusText))),
      fetch('/api/sources').then((r) => (r.ok ? r.json() : Promise.reject(r.statusText))),
      fetch('/api/events?limit=200').then((r) => (r.ok ? r.json() : Promise.reject(r.statusText))),
    ])
      .then(([lib, ipLib, srcData, ev]) => {
        if (cancelled) return;

        // Build category list for dropdowns
        const catSet = new Set<string>();
        for (const c of lib.categories ?? []) {
          catSet.add(c.key);
        }
        for (const c of ipLib.categories ?? []) {
          catSet.add(c.key);
        }
        // We'll also derive countries from a small sample by fetching one category
        // For now, just set categories; countries will be populated after first camera fetch
        setAllCategories(Array.from(catSet).sort());

        // Windy cameras are few enough to load all
        const windyCams: Camera[] = (srcData.sources ?? [])
          .filter((s: any) => s.kind === 'windy')
          .map((s: any) => ({
            name: s.name,
            lat: s.config?.lat ?? 0,
            lon: s.config?.lon ?? 0,
            category: s.config?.category ?? 'windy',
            country: s.config?.country ?? '',
            region: s.config?.city ?? '',
            streamUrl: s.config?.previewUrl ?? null,
            infoUrl: null,
            provider: 'windy',
            streamType: 'image',
          }))
          .filter((c: Camera) => c.lat !== 0 && c.lon !== 0);

        // Store windy for re-use in viewport merges
        (window as any).__windyCams = windyCams;

        setEvents(ev.events ?? []);
        setLoading(false);
        cacheSet('map-events', { events: ev.events ?? [] }).catch(() => {});
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  // Fetch cameras by viewport bounds (debounced)
  const fetchViewport = useCallback((bounds: string, zoom: number) => {
    if (zoom <= 3) {
      setViewportCameras([]);
      setViewportLoading(false);
      return;
    }

    setViewportLoading(true);
    Promise.all([
      fetch(`/api/library/webcams?bounds=${encodeURIComponent(bounds)}`).then((r) => (r.ok ? r.json() : { webcams: [] })),
      fetch(`/api/ipcameras/cameras?bounds=${encodeURIComponent(bounds)}`).then((r) => (r.ok ? r.json() : { cameras: [] })),
    ])
      .then(([lib, ipLib]) => {
        const webcams: Camera[] = (lib.webcams ?? []).map((w: any) => ({
          ...w,
          lon: w.lon ?? w.lng ?? 0,
        }));
        const ipCameras: Camera[] = (ipLib.cameras ?? []).map((c: any) => ({
          ...c,
          lon: c.lon ?? c.lng ?? 0,
        }));
        const windyCams: Camera[] = (window as any).__windyCams ?? [];
        const all = [
          ...webcams.map((c) => ({ ...c, category: c.category ?? 'webcam' })),
          ...ipCameras.map((c) => ({ ...c, category: c.category ?? 'ip_camera' })),
          ...windyCams,
        ];
        setViewportCameras(all);
        setViewportLoading(false);

        // Update country list from viewport results
        const countrySet = new Set<string>();
        for (const c of all) if (c.country) countrySet.add(c.country);
        setAllCountries(Array.from(countrySet).sort());
      })
      .catch(() => {
        setViewportLoading(false);
      });
  }, []);

  // Debounced bounds fetch
  useEffect(() => {
    if (!boundsStr) return;
    const id = setTimeout(() => {
      fetchViewport(boundsStr, mapZoom);
    }, 300);
    return () => clearTimeout(id);
  }, [boundsStr, mapZoom, fetchViewport]);

  // Debounced radar fetch (aircraft + ships) on map move/zoom. boundsStr is
  // already "minLat,minLon,maxLat,maxLon" — exactly the bbox the radar API wants.
  useEffect(() => {
    if (!boundsStr || (!showAircraft && !showShips)) {
      setAircraft((a) => (a.length ? [] : a));
      setShips((s) => (s.length ? [] : s));
      return;
    }
    // Radar is dense at low zoom; only query once the view is reasonably tight.
    if (mapZoom <= 4) {
      setAircraft((a) => (a.length ? [] : a));
      setShips((s) => (s.length ? [] : s));
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      setRadarLoading(true);
      try {
        const [ac, sh] = await Promise.all([
          showAircraft ? getAircraft(boundsStr, 1500).catch(() => [] as Aircraft[]) : Promise.resolve([] as Aircraft[]),
          showShips ? getShips(boundsStr, 1500).catch(() => [] as Ship[]) : Promise.resolve([] as Ship[]),
        ]);
        if (cancelled) return;

        // Accumulate client-side trails, then evict ids no longer present.
        const acIds = new Set<string>();
        for (const a of ac) {
          if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) {
            aircraftTrails.current.push(a.id, a.lat, a.lon);
            acIds.add(a.id);
          }
        }
        aircraftTrails.current.prune(acIds);

        const shIds = new Set<string>();
        for (const s of sh) {
          if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
            shipTrails.current.push(s.id, s.lat, s.lon);
            shIds.add(s.id);
          }
        }
        shipTrails.current.prune(shIds);

        setAircraft(ac);
        setShips(sh);

        // Keep the follow target's position fresh so the map can recenter.
        setFollowed((prev) => (prev ? ac.find((a) => a.id === prev.id) ?? prev : prev));
      } finally {
        if (!cancelled) setRadarLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [boundsStr, mapZoom, showAircraft, showShips]);

  // Clear trails when a layer is turned off so they don't reappear stale.
  useEffect(() => {
    if (!showAircraft) aircraftTrails.current.clear();
  }, [showAircraft]);
  useEffect(() => {
    if (!showShips) shipTrails.current.clear();
  }, [showShips]);

  // Aircraft that pass the altitude range filter + render cap.
  const visibleAircraft = useMemo(() => {
    const out = aircraft.filter((a) => {
      const alt = a.alt ?? 0;
      return alt >= altMin && alt <= altMax;
    });
    return out.length > MAX_RENDERED ? out.slice(0, MAX_RENDERED) : out;
  }, [aircraft, altMin, altMax]);

  const visibleShips = useMemo(
    () => (ships.length > MAX_RENDERED ? ships.slice(0, MAX_RENDERED) : ships),
    [ships],
  );

  // Per-category live counts for the control panel.
  const aircraftCounts = useMemo(() => {
    const c: Record<AircraftCat, number> = { jet: 0, prop: 0, heli: 0, ground: 0 };
    for (const a of aircraft) c[aircraftCategory(a)]++;
    return c;
  }, [aircraft]);
  const shipCounts = useMemo(() => {
    const c: Record<ShipCat, number> = { cargo: 0, tanker: 0, passenger: 0, other: 0 };
    for (const s of ships) c[shipCategory(s)]++;
    return c;
  }, [ships]);

  // Apply filters
  const isHlsCamera = useCallback((c: Camera) => {
    return c.streamType === 'hls' || !!c.streamUrl?.includes('.m3u8');
  }, []);

  const filtered = useMemo(() => {
    return viewportCameras.filter((c) => {
      if (!showWebcams && c.category !== 'ip_camera' && !c.provider?.toLowerCase().includes('ip') && c.provider !== 'windy') return false;
      if (!showIpCameras && (c.category === 'ip_camera' || c.provider?.toLowerCase().includes('ip'))) return false;
      if (!showWindy && c.provider === 'windy') return false;
      if (showHlsOnly && !isHlsCamera(c)) return false;
      if (selectedCategory !== 'all' && c.category !== selectedCategory) return false;
      if (selectedCountry !== 'all' && c.country !== selectedCountry) return false;
      if (search) {
        const q = search.toLowerCase();
        const text = `${c.name} ${c.country} ${c.region ?? ''} ${c.category}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [viewportCameras, search, selectedCategory, selectedCountry, showIpCameras, showWebcams, showWindy, showHlsOnly, isHlsCamera]);

  const stats = useMemo(() => {
    return {
      total: viewportCameras.length,
      filtered: filtered.length,
      webcams: viewportCameras.filter((c) => c.category !== 'ip_camera' && !c.provider?.toLowerCase().includes('ip') && c.provider !== 'windy').length,
      ipCameras: viewportCameras.filter((c) => c.category === 'ip_camera' || c.provider?.toLowerCase().includes('ip')).length,
      windy: viewportCameras.filter((c) => c.provider === 'windy').length,
      hls: viewportCameras.filter(isHlsCamera).length,
    };
  }, [viewportCameras, filtered]);

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.base, color: colors.text }}>
        <div>Loading map...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.base, color: colors.critical }}>
        <div>Error loading map: {error}</div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', background: colors.bg2 }}>
      {/* Sidebar */}
      <div
        style={{
          width: 260,
          background: colors.panel,
          color: colors.text,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflowY: 'auto',
          borderRight: `1px solid ${colors.border}`,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, color: colors.accent }}>🗺️ Camera Map</h2>

        <div style={{ fontSize: 12, color: colors.dim }}>
          {viewportLoading ? 'Loading viewport cameras...' : `Showing ${filtered.length.toLocaleString()} of ${stats.total.toLocaleString()} cameras in view`}
        </div>
        {mapZoom <= 3 && (
          <div style={{ fontSize: 11, color: colors.elevated, background: `rgba(${rgb(colors.elevated)},0.12)`, padding: '4px 8px', borderRadius: 4 }}>
            🔍 Zoom in to load cameras
          </div>
        )}
        {events.length > 0 && (
          <div style={{ fontSize: 11, color: colors.normal }}>
            📡 {events.length.toLocaleString()} intelligence events
          </div>
        )}

        {/* Search */}
        <input
          type="text"
          placeholder="Search cameras..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
            background: colors.base,
            color: colors.text,
            fontSize: 13,
            outline: 'none',
          }}
        />

        {/* Type toggles */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={showWebcams} onChange={(e) => setShowWebcams(e.target.checked)} />
            Curated Webcams ({stats.webcams.toLocaleString()})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={showIpCameras} onChange={(e) => setShowIpCameras(e.target.checked)} />
            IP Cameras ({stats.ipCameras.toLocaleString()})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={showWindy} onChange={(e) => setShowWindy(e.target.checked)} />
            Windy ({stats.windy.toLocaleString()})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: colors.elevated }}>
            <input type="checkbox" checked={showHlsOnly} onChange={(e) => setShowHlsOnly(e.target.checked)} />
            🔴 HLS Only ({stats.hls.toLocaleString()})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: colors.normal }}>
            <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} />
            📡 Intelligence Events ({events.length.toLocaleString()})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: colors.teal }}>
            <input type="checkbox" checked={showAircraft} onChange={(e) => setShowAircraft(e.target.checked)} />
            ✈ Aircraft (ADS-B){showAircraft ? ` (${aircraft.length.toLocaleString()})` : ''}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: colors.low }}>
            <input type="checkbox" checked={showShips} onChange={(e) => setShowShips(e.target.checked)} />
            🚢 Ships (AIS){showShips ? ` (${ships.length.toLocaleString()})` : ''}
          </label>
        </div>
        {(showAircraft || showShips) && (
          <div style={{ fontSize: 11, color: radarLoading ? colors.elevated : colors.dim }}>
            {mapZoom <= 4
              ? '🔍 Zoom in to load live radar'
              : radarLoading
                ? 'Updating live radar…'
                : `Live radar: ${showAircraft ? `${aircraft.length} ✈` : ''}${showAircraft && showShips ? ' · ' : ''}${showShips ? `${ships.length} 🚢` : ''}`}
          </div>
        )}

        {/* Radar control panel — altitude filter, trails, per-category counts */}
        {(showAircraft || showShips) && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 10,
              borderRadius: 8,
              background: colors.base,
              border: `1px solid ${colors.border}`,
            }}
          >
            <div style={{ fontSize: 11, textTransform: 'uppercase', color: colors.dim, letterSpacing: 0.5 }}>
              Radar Controls
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} />
              Trails
              <button
                onClick={(e) => {
                  e.preventDefault();
                  aircraftTrails.current.clear();
                  shipTrails.current.clear();
                  setHoveredId((h) => h); // nudge a re-render
                }}
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 4,
                  border: `1px solid ${colors.border}`,
                  background: colors.panel,
                  color: colors.dim,
                  cursor: 'pointer',
                }}
                title="Clear all accumulated trails"
              >
                Clear
              </button>
            </label>

            {showAircraft && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: colors.dim, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Altitude range</span>
                  <span style={{ color: colors.text2 }}>
                    {(altMin / 1000).toFixed(0)}k–{altMax >= 50000 ? '50k+' : `${(altMax / 1000).toFixed(0)}k`} ft
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={50000}
                  step={1000}
                  value={altMin}
                  onChange={(e) => setAltMin(Math.min(Number(e.target.value), altMax))}
                  style={{ width: '100%', accentColor: colors.teal }}
                />
                <input
                  type="range"
                  min={0}
                  max={50000}
                  step={1000}
                  value={altMax}
                  onChange={(e) => setAltMax(Math.max(Number(e.target.value), altMin))}
                  style={{ width: '100%', accentColor: colors.teal }}
                />
                <div style={{ fontSize: 10, color: colors.muted, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                  <span>✈ jet {aircraftCounts.jet}</span>
                  <span>prop {aircraftCounts.prop}</span>
                  <span>heli {aircraftCounts.heli}</span>
                  <span>grnd {aircraftCounts.ground}</span>
                </div>
              </div>
            )}

            {showShips && (
              <div style={{ fontSize: 10, color: colors.muted, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                <span>🚢 cargo {shipCounts.cargo}</span>
                <span>tanker {shipCounts.tanker}</span>
                <span>pax {shipCounts.passenger}</span>
                <span>other {shipCounts.other}</span>
              </div>
            )}

            {/* Altitude band legend */}
            {showAircraft && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', color: colors.dim, letterSpacing: 0.5 }}>
                  Altitude bands
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                  {ALT_BANDS.map((b) => (
                    <span key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: colors.text2 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: b.color, display: 'inline-block' }} />
                      {b.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Followed-aircraft detail panel */}
        {followed && (
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              background: colors.base,
              border: `1px solid ${colors.teal}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: colors.teal }}>
                📍 Following ✈ {followed.callsign ?? followed.id}
              </span>
              <button
                onClick={() => setFollowed(null)}
                style={{ background: 'transparent', border: 'none', color: colors.dim, fontSize: 14, cursor: 'pointer', lineHeight: 1 }}
                title="Stop following"
              >
                ×
              </button>
            </div>
            <div style={{ fontSize: 11, color: colors.dim }}>
              {followed.type ?? 'Unknown type'} · {aircraftCategory(followed)}
            </div>
            <div style={{ fontSize: 11, color: colors.dim, marginTop: 2 }}>
              <span style={{ color: altBandFor(followed.alt).color }}>●</span>{' '}
              {followed.alt != null ? `${followed.alt.toLocaleString()} ft` : 'alt —'} ·{' '}
              {followed.speed != null ? `${Math.round(followed.speed)} kt` : 'spd —'} ·{' '}
              {followed.heading != null ? `${Math.round(followed.heading)}°` : 'hdg —'}
            </div>
          </div>
        )}

        {/* Category filter */}
        <div>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: colors.dim, letterSpacing: 0.5 }}>Category</label>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            style={{
              width: '100%',
              marginTop: 4,
              padding: '6px 8px',
              borderRadius: 6,
              border: `1px solid ${colors.border}`,
              background: colors.base,
              color: colors.text,
              fontSize: 13,
            }}
          >
            <option value="all">All categories</option>
            {allCategories.map((cat) =>(
              <option key={cat} value={cat}>
                {cat.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
              </option>
            ))}
          </select>
        </div>

        {/* Country filter */}
        <div>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: colors.dim, letterSpacing: 0.5 }}>Country</label>
          <select
            value={selectedCountry}
            onChange={(e) => setSelectedCountry(e.target.value)}
            style={{
              width: '100%',
              marginTop: 4,
              padding: '6px 8px',
              borderRadius: 6,
              border: `1px solid ${colors.border}`,
              background: colors.base,
              color: colors.text,
              fontSize: 13,
            }}
          >
            <option value="all">All countries</option>
            {allCountries.map((cc) => (
              <option key={cc} value={cc}>
                {cc}
              </option>
            ))}
          </select>
        </div>

        {/* Intelligence Events Feed */}
        {showEventsFeed && events.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: 11, textTransform: 'uppercase', color: colors.dim, letterSpacing: 0.5 }}>Intelligence Feed</label>
              <button
                onClick={() => setShowEventsFeed(false)}
                style={{ background: 'transparent', border: 'none', color: colors.dim, fontSize: 11, cursor: 'pointer' }}
              >
                Hide
              </button>
            </div>
            {events.slice(0, 30).map((ev) => (
              <div
                key={ev.id}
                onClick={() => {
                  if (ev.location) {
                    setSelectedCamera(null);
                    // Dispatch a custom event that MapFlyTo will pick up
                    window.dispatchEvent(new CustomEvent('flyTo', { detail: { lat: ev.location.lat, lon: ev.location.lon, zoom: 10 } }));
                  }
                }}
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: colors.base,
                  border: `1px solid ${colors.borderSubtle}`,
                  cursor: ev.location ? 'pointer' : 'default',
                  fontSize: 12,
                  lineHeight: 1.4,
                }}
                title={ev.content}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: ev.confidence > 0.8 ? colors.critical : ev.confidence > 0.5 ? colors.high : colors.normal,
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: colors.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ev.title ?? ev.kind}
                  </span>
                </div>
                <div style={{ color: colors.muted, fontSize: 10, marginLeft: 14 }}>
                  {ev.kind} · {ev.confidence > 0.8 ? 'High' : ev.confidence > 0.5 ? 'Med' : 'Low'} confidence
                  {ev.location && ' · 📍'}
                </div>
              </div>
            ))}
          </div>
        )}
        {!showEventsFeed && events.length > 0 && (
          <button
            onClick={() => setShowEventsFeed(true)}
            style={{
              background: 'transparent',
              border: `1px solid ${colors.border}`,
              color: colors.dim,
              fontSize: 11,
              padding: '6px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            📡 Show Intelligence Feed ({events.length.toLocaleString()} events)
          </button>
        )}

        {/* Legend */}
        <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: colors.dim, letterSpacing: 0.5, marginBottom: 8 }}>Legend</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px' }}>
            {Object.entries(CATEGORY_COLORS).slice(0, 8).map(([cat, color]) => (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
                {cat}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer center={[25, 10]} zoom={2} style={{ height: '100%', width: '100%' }} minZoom={2} worldCopyJump>
          <TileLayer
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />
          <MapBoundsListener onChange={(bounds, zoom) => { setBoundsStr(bounds); setMapZoom(zoom); }} />
          <MarkerClusterLayer cameras={filtered} onCameraClick={setSelectedCamera} />
          {showEvents && <EventLayer events={events} />}
          {showAircraft && (
            <AircraftLayer
              aircraft={visibleAircraft}
              trails={showTrails ? aircraftTrails.current : EMPTY_TRAILS}
              followId={followed?.id ?? null}
              onSelect={(a) => setFollowed((prev) => (prev && a && prev.id === a.id ? null : a))}
              onHover={setHoveredId}
              highlightId={hoveredId}
            />
          )}
          {showShips && (
            <ShipLayer
              ships={visibleShips}
              trails={showTrails ? shipTrails.current : EMPTY_TRAILS}
              onHover={setHoveredId}
              highlightId={hoveredId}
            />
          )}
          {showAircraft && followed && <FollowController target={followed} />}
          <MapFlyToListener />
        </MapContainer>

        {/* Camera Preview Panel */}
        {selectedCamera && (
          <ResizablePanel
            width={isMaximized ? Math.min(900, typeof window !== 'undefined' ? window.innerWidth - 100 : 900) : panelWidth}
            onResize={setPanelWidth}
            onMaximize={() => setIsMaximized((m) => !m)}
            isMaximized={isMaximized}
            camera={selectedCamera}
            onClose={() => { setSelectedCamera(null); setIsMaximized(false); }}
          />
        )}
      </div>
    </div>
  );
}
