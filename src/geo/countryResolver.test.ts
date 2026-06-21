import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCountry,
  resolveRegion,
  tagLocation,
  pointInPolygon,
} from './countryResolver.js';

test('resolveCountry returns expected ISO2 for well-known city coordinates', () => {
  assert.equal(resolveCountry(40.4168, -3.7038), 'ES'); // Madrid
  assert.equal(resolveCountry(35.6762, 139.6503), 'JP'); // Tokyo
  assert.equal(resolveCountry(40.7128, -74.006), 'US'); // New York
  assert.equal(resolveCountry(51.5074, -0.1278), 'GB'); // London
  assert.equal(resolveCountry(30.0444, 31.2357), 'EG'); // Cairo
  assert.equal(resolveCountry(-23.5505, -46.6333), 'BR'); // Sao Paulo
});

test('resolveCountry picks the smallest containing box on overlap', () => {
  // Kuwait City sits inside KW, IQ, SA and IR rectangles; the tight KW box wins.
  assert.equal(resolveCountry(29.3759, 47.9774), 'KW');
  // Doha is inside both QA and the much larger SA/IR rectangles -> QA.
  assert.equal(resolveCountry(25.2854, 51.531), 'QA');
});

test('resolveCountry covers non-contiguous territory under one ISO code', () => {
  assert.equal(resolveCountry(61.2181, -149.9003), 'US'); // Anchorage, Alaska
  assert.equal(resolveCountry(54.7104, 20.4522), 'RU'); // Kaliningrad
});

test('resolveCountry returns undefined for ocean and invalid input', () => {
  assert.equal(resolveCountry(0, -150), undefined); // mid Pacific
  assert.equal(resolveCountry(-40, -30), undefined); // South Atlantic
  assert.equal(resolveCountry(NaN, 10), undefined);
  assert.equal(resolveCountry(95, 10), undefined); // out-of-range lat
  assert.equal(resolveCountry(10, 200), undefined); // out-of-range lon
});

test('resolveRegion maps coordinates to coarse strategic regions', () => {
  assert.equal(resolveRegion(40.4168, -3.7038), 'EU'); // Madrid
  assert.equal(resolveRegion(35.6762, 139.6503), 'EAST_ASIA'); // Tokyo
  assert.equal(resolveRegion(40.7128, -74.006), 'NORTH_AMERICA'); // New York
  assert.equal(resolveRegion(30.0444, 31.2357), 'MENA'); // Cairo
  assert.equal(resolveRegion(28.6139, 77.209), 'SOUTH_ASIA'); // New Delhi
  assert.equal(resolveRegion(-33.8688, 151.2093), 'OCEANIA'); // Sydney
  assert.equal(resolveRegion(-1.2921, 36.8219), 'AFRICA'); // Nairobi
});

test('resolveRegion returns undefined for ocean and invalid input', () => {
  assert.equal(resolveRegion(0, -150), undefined); // mid Pacific
  assert.equal(resolveRegion(Infinity, 0), undefined);
});

test('tagLocation merges country + region tags, or {} when no location', () => {
  assert.deepEqual(tagLocation({ location: { lat: 35.6762, lon: 139.6503 } }), {
    country: 'JP',
    region: 'EAST_ASIA',
  });
  // Ocean point: a region may or may not match, but no country tag is emitted.
  const ocean = tagLocation({ location: { lat: 0, lon: -150 } });
  assert.equal(ocean.country, undefined);
  // No / malformed location -> empty object so callers can spread safely.
  assert.deepEqual(tagLocation({}), {});
  assert.deepEqual(tagLocation({ location: null }), {});
  assert.deepEqual(
    tagLocation({ location: { lat: NaN as unknown as number, lon: 10 } }),
    {},
  );
});

test('pointInPolygon ray-cast helper handles inside/outside', () => {
  // Unit square ring of [lon, lat] vertices.
  const square: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(pointInPolygon(5, 5, square), true); // center
  assert.equal(pointInPolygon(15, 5, square), false); // east of box
  assert.equal(pointInPolygon(5, -5, square), false); // west of box
});
