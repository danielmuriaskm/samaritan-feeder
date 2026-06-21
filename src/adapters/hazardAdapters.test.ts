import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUsgs, magnitudeConfidence, type MakeEvent } from './usgs.js';
import { parseEonet } from './eonet.js';
import { parseGdacs, alertLevelConfidence } from './gdacs.js';
import { parseNws, severityConfidence } from './nws.js';

/**
 * Stub mirroring BaseAdapter#makeEvent: fills defaults so the parsers can be
 * exercised with no adapter instance and no network.
 */
const makeEvent: MakeEvent = (partial, sourceId) => ({
  sourceId,
  kind: partial.kind,
  title: partial.title,
  content: partial.content,
  rawData: partial.rawData,
  mediaUrls: partial.mediaUrls,
  eventAt: partial.eventAt ?? 0,
  confidence: partial.confidence ?? 0.5,
  tags: partial.tags,
  location: partial.location,
  dedupeContent: partial.dedupeContent,
});

// ---------------------------------------------------------------------------
// USGS
// ---------------------------------------------------------------------------

test('parseUsgs maps a GeoJSON feature with location, mag tags and stable dedupe', () => {
  const payload = {
    features: [
      {
        id: 'us7000abcd',
        properties: { mag: 5.4, place: '12km S of Town', time: 1700000000000, depth: 10, url: 'https://example/q', tsunami: 0 },
        geometry: { type: 'Point', coordinates: [-118.5, 34.1, 8.2] },
      },
    ],
  };
  const events = parseUsgs(payload, { sourceId: 'usgs_4.5_day', makeEvent });
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.kind, 'anomaly');
  assert.deepEqual(e.location, { lat: 34.1, lon: -118.5 });
  assert.equal(e.eventAt, 1700000000000);
  assert.equal(e.tags?.magnitude, 5.4);
  assert.equal(e.tags?.depth_km, 8.2); // depth comes from geometry coord[2], not props
  assert.equal(e.tags?.usgs_id, 'us7000abcd');
  assert.equal(e.dedupeContent, 'usgs:us7000abcd');
  assert.match(e.title ?? '', /M5\.4/);
  assert.ok((e.confidence as number) > 0.8);
});

test('parseUsgs honours minMagnitude and the per-poll cap', () => {
  const features = Array.from({ length: 60 }, (_, i) => ({
    id: `q${i}`,
    properties: { mag: i % 2 === 0 ? 6.0 : 2.0, place: `p${i}`, time: 1 },
    geometry: { coordinates: [0, 0, 1] },
  }));
  const filtered = parseUsgs({ features }, { sourceId: 's', minMagnitude: 5, makeEvent });
  assert.ok(filtered.every((e) => (e.tags?.magnitude as number) >= 5));
  const capped = parseUsgs({ features }, { sourceId: 's', max: 10, makeEvent });
  assert.equal(capped.length, 10);
});

test('parseUsgs tolerates a missing geometry / empty payload', () => {
  assert.deepEqual(parseUsgs({}, { sourceId: 's', makeEvent }), []);
  const noGeom = parseUsgs(
    { features: [{ id: 'x', properties: { mag: 4.6, place: 'p', time: 1 } }] },
    { sourceId: 's', makeEvent },
  );
  assert.equal(noGeom.length, 1);
  assert.equal(noGeom[0].location, undefined);
});

test('magnitudeConfidence is monotonic and clamped', () => {
  assert.ok(magnitudeConfidence(7.5) > magnitudeConfidence(5) );
  assert.ok(magnitudeConfidence(5) > magnitudeConfidence(2));
  assert.equal(magnitudeConfidence(undefined), 0.5);
  assert.equal(magnitudeConfidence(NaN), 0.5);
});

// ---------------------------------------------------------------------------
// EONET
// ---------------------------------------------------------------------------

test('parseEonet uses most-recent geometry point and category titles', () => {
  const payload = {
    events: [
      {
        id: 'EONET_6789',
        title: 'Wildfire X',
        closed: null,
        categories: [{ id: 'wildfires', title: 'Wildfires' }],
        geometry: [
          { date: '2026-06-01T00:00:00Z', type: 'Point', coordinates: [-120, 38] },
          { date: '2026-06-02T00:00:00Z', type: 'Point', coordinates: [-121, 39] },
        ],
        sources: [{ id: 'InciWeb', url: 'https://example/eonet' }],
      },
    ],
  };
  const events = parseEonet(payload, { sourceId: 'eonet', makeEvent });
  assert.equal(events.length, 1);
  const e = events[0];
  assert.deepEqual(e.location, { lat: 39, lon: -121 }); // latest geometry
  assert.equal(e.eventAt, Date.parse('2026-06-02T00:00:00Z'));
  assert.deepEqual(e.tags?.categories, ['Wildfires']);
  assert.equal(e.tags?.ongoing, true);
  assert.equal(e.dedupeContent, 'eonet:EONET_6789');
  assert.ok((e.confidence as number) > 0.7); // ongoing > closed
});

test('parseEonet category filter matches by id or title (case-insensitive)', () => {
  const payload = {
    events: [
      { id: 'a', title: 'A', categories: [{ id: 'volcanoes', title: 'Volcanoes' }], geometry: [{ coordinates: [1, 2] }] },
      { id: 'b', title: 'B', categories: [{ id: 'wildfires', title: 'Wildfires' }], geometry: [{ coordinates: [3, 4] }] },
    ],
  };
  const byId = parseEonet(payload, { sourceId: 's', category: 'wildfires', makeEvent });
  assert.deepEqual(byId.map((e) => e.tags?.eonet_id), ['b']);
  const byTitle = parseEonet(payload, { sourceId: 's', category: 'VOLCANOES', makeEvent });
  assert.deepEqual(byTitle.map((e) => e.tags?.eonet_id), ['a']);
});

test('parseEonet marks a closed event with lower confidence', () => {
  const payload = {
    events: [{ id: 'c', title: 'Done', closed: '2026-05-01T00:00:00Z', categories: [], geometry: [{ coordinates: [5, 6], date: '2026-05-01T00:00:00Z' }] }],
  };
  const [e] = parseEonet(payload, { sourceId: 's', makeEvent });
  assert.equal(e.tags?.ongoing, false);
  assert.ok((e.confidence as number) < 0.75);
});

// ---------------------------------------------------------------------------
// GDACS
// ---------------------------------------------------------------------------

test('parseGdacs maps alert level to kind and confidence', () => {
  const payload = {
    features: [
      {
        properties: {
          eventtype: 'TC',
          eventid: 1000123,
          episodeid: 5,
          name: 'Cyclone Foo',
          alertlevel: 'Red',
          fromdate: '2026-06-10T00:00:00Z',
          country: 'Fooland',
          htmldescription: '<b>Strong</b> winds expected',
          url: { report: 'https://example/gdacs' },
        },
        geometry: { type: 'Point', coordinates: [90.5, 22.3] },
      },
    ],
  };
  const [e] = parseGdacs(payload, { sourceId: 'gdacs', makeEvent });
  assert.equal(e.kind, 'alert'); // red -> push-worthy
  assert.deepEqual(e.location, { lat: 22.3, lon: 90.5 });
  assert.equal(e.tags?.event_type, 'TC');
  assert.equal(e.tags?.event_type_label, 'Tropical Cyclone');
  assert.equal(e.tags?.alert_level, 'red');
  assert.equal(e.dedupeContent, 'gdacs:TC_1000123_5');
  assert.match(e.content, /Strong winds expected/); // html stripped
  assert.ok((e.confidence as number) >= 0.95);
});

test('parseGdacs minLevel drops lower-severity disasters; green -> anomaly', () => {
  const payload = {
    features: [
      { properties: { eventtype: 'FL', eventid: 1, name: 'Flood A', alertlevel: 'Green' }, geometry: { coordinates: [0, 0] } },
      { properties: { eventtype: 'EQ', eventid: 2, name: 'Quake B', alertlevel: 'Orange' }, geometry: { coordinates: [0, 0] } },
    ],
  };
  const all = parseGdacs(payload, { sourceId: 's', makeEvent });
  assert.equal(all.length, 2);
  assert.equal(all.find((e) => e.tags?.alert_level === 'green')?.kind, 'anomaly');
  const onlyOrange = parseGdacs(payload, { sourceId: 's', minLevel: 'orange', makeEvent });
  assert.equal(onlyOrange.length, 1);
  assert.equal(onlyOrange[0].tags?.alert_level, 'orange');
});

test('alertLevelConfidence orders red > orange > green', () => {
  assert.ok(alertLevelConfidence('Red') > alertLevelConfidence('Orange'));
  assert.ok(alertLevelConfidence('Orange') > alertLevelConfidence('Green'));
});

// ---------------------------------------------------------------------------
// NWS
// ---------------------------------------------------------------------------

test('parseNws maps a severe alert to kind:alert with centroid location', () => {
  const payload = {
    features: [
      {
        id: 'urn:oid:nws-1',
        geometry: {
          type: 'Polygon',
          // a unit square 0..2 -> centroid (1,1)
          coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]],
        },
        properties: {
          id: 'nws-1',
          event: 'Tornado Warning',
          severity: 'Severe',
          urgency: 'Immediate',
          certainty: 'Observed',
          areaDesc: 'Some County, KS',
          headline: 'Tornado Warning issued',
          onset: '2026-06-21T18:00:00Z',
          messageType: 'Alert',
        },
      },
    ],
  };
  const [e] = parseNws(payload, { sourceId: 'nws', makeEvent });
  assert.equal(e.kind, 'alert');
  assert.deepEqual(e.location, { lat: 1, lon: 1 });
  assert.equal(e.eventAt, Date.parse('2026-06-21T18:00:00Z'));
  assert.equal(e.tags?.severity, 'Severe');
  assert.equal(e.dedupeContent, 'nws:nws-1');
  assert.match(e.title ?? '', /Tornado Warning/);
});

test('parseNws skips cancellations and applies minSeverity', () => {
  const payload = {
    features: [
      { properties: { id: 'a', event: 'Flood', severity: 'Minor', messageType: 'Alert' } },
      { properties: { id: 'b', event: 'Heat', severity: 'Extreme', messageType: 'Alert' } },
      { properties: { id: 'c', event: 'Wind', severity: 'Extreme', messageType: 'Cancel' } },
    ],
  };
  const all = parseNws(payload, { sourceId: 's', makeEvent });
  assert.deepEqual(all.map((e) => e.tags?.nws_id).sort(), ['a', 'b']); // 'c' cancelled
  const severe = parseNws(payload, { sourceId: 's', minSeverity: 'severe', makeEvent });
  assert.deepEqual(severe.map((e) => e.tags?.nws_id), ['b']); // minor dropped
});

test('parseNws minor severity is recorded as kind:text, not a push alert', () => {
  const [e] = parseNws(
    { features: [{ properties: { id: 'm', event: 'Frost Advisory', severity: 'Minor' } }] },
    { sourceId: 's', makeEvent },
  );
  assert.equal(e.kind, 'text');
  assert.ok((e.confidence as number) < 0.7);
});

test('severityConfidence orders extreme > severe > moderate > minor', () => {
  assert.ok(severityConfidence('Extreme') > severityConfidence('Severe'));
  assert.ok(severityConfidence('Severe') > severityConfidence('Moderate'));
  assert.ok(severityConfidence('Moderate') > severityConfidence('Minor'));
});
