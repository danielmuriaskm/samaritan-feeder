import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAbusech, parseAbusechDate, type ParsedIoc } from './abusech.js';
import { parseNgaMsi, extractLocation, severityConfidence, parseMsiDate } from './ngamsi.js';
import { parseReliefweb, buildRequestUrl, relevanceConfidence } from './reliefweb.js';
import { parseGdelt, parseGdeltDate, toneConfidence, buildDocUrl } from './gdelt.js';

// ---------------------------------------------------------------------------
// abuse.ch
// ---------------------------------------------------------------------------

test('abusech: URLhaus json_recent parses keyed-object payload to IOC events', () => {
  const payload = {
    '100': [
      {
        id: '100',
        url: 'http://evil.example/mal.exe',
        url_status: 'online',
        host: 'evil.example',
        date_added: '2024-03-01 10:00:00 UTC',
        threat: 'malware_download',
        tags: ['exe', 'Loki'],
        urlhaus_reference: 'https://urlhaus.abuse.ch/url/100/',
      },
    ],
    '101': [
      {
        id: '101',
        url: 'http://dead.example/x',
        url_status: 'offline',
        date_added: '2024-03-01 09:00:00 UTC',
        threat: 'malware_download',
        tags: null,
      },
    ],
  };
  const iocs = parseAbusech(payload, 'urlhaus');
  assert.equal(iocs.length, 2);
  const online = iocs.find((i) => i.value === 'http://evil.example/mal.exe') as ParsedIoc;
  assert.equal(online.iocType, 'url');
  assert.equal(online.threat, 'malware_download');
  assert.equal(online.malware, 'exe'); // first tag
  assert.ok(online.confidence > 0.8, 'online URL ranks higher');
  assert.equal(online.upstreamId, '100');
  const offline = iocs.find((i) => i.value === 'http://dead.example/x') as ParsedIoc;
  assert.ok(offline.confidence < online.confidence, 'offline URL ranks lower');
  assert.deepEqual(offline.tags, []); // null tags -> []
});

test('abusech: ThreatFox API payload normalizes ioc_type + confidence', () => {
  const payload = {
    query_status: 'ok',
    data: [
      {
        id: 5001,
        ioc: '1.2.3.4:443',
        ioc_type: 'ip:port',
        threat_type: 'botnet_cc',
        malware: 'win.cobalt_strike',
        malware_printable: 'Cobalt Strike',
        confidence_level: 90,
        first_seen: '2024-04-02 12:00:00 UTC',
        reference: 'https://threatfox.abuse.ch/ioc/5001/',
        tags: ['CobaltStrike'],
      },
      { id: 5002, ioc: 'abcd1234abcd1234abcd1234abcd1234', ioc_type: 'md5_hash', confidence_level: 50 },
    ],
  };
  const iocs = parseAbusech(payload, 'threatfox');
  assert.equal(iocs.length, 2);
  assert.equal(iocs[0].iocType, 'ip:port');
  assert.equal(iocs[0].malware, 'Cobalt Strike'); // printable preferred
  assert.ok(Math.abs(iocs[0].confidence - 0.9) < 1e-9);
  assert.equal(iocs[1].iocType, 'md5');
  assert.ok(Math.abs(iocs[1].confidence - 0.5) < 1e-9);
});

test('abusech: bad payloads and failed-query status yield no IOCs', () => {
  assert.deepEqual(parseAbusech(null, 'urlhaus'), []);
  assert.deepEqual(parseAbusech('nope', 'urlhaus'), []);
  assert.deepEqual(parseAbusech({ query_status: 'no_result', data: [] }, 'threatfox'), []);
  assert.deepEqual(parseAbusech({ query_status: 'ok', data: 'oops' }, 'threatfox'), []);
});

test('abusech: timestamp parsing handles "UTC" suffix and falls back', () => {
  const t = parseAbusechDate('2024-03-01 10:00:00 UTC');
  assert.equal(new Date(t).toISOString(), '2024-03-01T10:00:00.000Z');
  assert.ok(Number.isFinite(parseAbusechDate(undefined)));
  assert.ok(Number.isFinite(parseAbusechDate('garbage')));
});

// ---------------------------------------------------------------------------
// NGA MSI
// ---------------------------------------------------------------------------

test('ngamsi: parses warnings, builds stable upstream id, extracts location', () => {
  const payload = {
    'broadcast-warn': [
      {
        msgYear: 2024,
        msgNumber: 123,
        navArea: 'IV',
        subregion: '24',
        status: 'A',
        issueDate: '2024-05-01T00:00:00Z',
        text: 'DANGEROUS WRECK LOCATED IN POSITION 12-34.5N 098-76.5E. MARINERS ADVISED TO KEEP CLEAR.',
      },
      {
        msgYear: 2024,
        msgNumber: 124,
        navArea: 'IV',
        status: 'A',
        issueDate: '2024-05-02T00:00:00Z',
        text: 'BUOY OFF STATION, NO POSITION REPORTED.',
      },
    ],
  };
  const warns = parseNgaMsi(payload);
  assert.equal(warns.length, 2);
  assert.equal(warns[0].upstreamId, 'IV/2024/123');
  assert.ok(warns[0].location, 'first warning has a parsed position');
  assert.ok(Math.abs(warns[0].location!.lat - (12 + 34.5 / 60)) < 1e-4);
  assert.ok(Math.abs(warns[0].location!.lon - (98 + 76.5 / 60)) < 1e-4);
  assert.equal(warns[1].location, undefined, 'no coordinates -> no location');
  assert.ok(warns[0].confidence > warns[1].confidence, 'dangerous wreck ranks above buoy notice');
});

test('ngamsi: extractLocation handles S/W hemispheres as negatives', () => {
  const loc = extractLocation('OBSTRUCTION IN 33-30.0S 151-15.0W');
  assert.ok(loc);
  assert.ok(loc!.lat < 0, 'south is negative');
  assert.ok(loc!.lon < 0, 'west is negative');
  assert.equal(extractLocation('NO COORDINATES HERE'), undefined);
});

test('ngamsi: severityConfidence is bounded and keyword-sensitive', () => {
  const high = severityConfidence('UNEXPLODED MISSILE FIRING EXERCISE');
  const low = severityConfidence('ROUTINE NOTICE TO MARINERS');
  assert.ok(high > low);
  assert.ok(high <= 0.95 && low >= 0.4);
  assert.ok(Number.isFinite(parseMsiDate('not a date')));
});

test('ngamsi: non-list / empty payloads yield no warnings', () => {
  assert.deepEqual(parseNgaMsi(null), []);
  assert.deepEqual(parseNgaMsi({}), []);
  assert.deepEqual(parseNgaMsi({ 'broadcast-warn': [{ navArea: 'IV', text: '' }] }), []);
});

// ---------------------------------------------------------------------------
// ReliefWeb
// ---------------------------------------------------------------------------

test('reliefweb: parses disasters envelope with primary country + location', () => {
  const payload = {
    data: [
      {
        id: 52001,
        fields: {
          name: 'Cyclone Mocha - May 2024',
          status: 'ongoing',
          url_alias: 'https://reliefweb.int/disaster/tc-2024-000001',
          date: { created: '2024-05-14T00:00:00+00:00' },
          primary_country: { name: 'Myanmar', location: { lat: 21.9, lon: 95.9 } },
          type: [{ name: 'Tropical Cyclone' }],
          source: [{ shortname: 'OCHA' }, { name: 'IFRC' }, { name: 'WFP' }],
          body: 'Severe tropical cyclone made landfall affecting coastal regions.',
        },
      },
    ],
  };
  const items = parseReliefweb(payload, 'disasters');
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.title, 'Cyclone Mocha - May 2024');
  assert.equal(it.country, 'Myanmar');
  assert.equal(it.disasterType, 'Tropical Cyclone');
  assert.deepEqual(it.location, { lat: 21.9, lon: 95.9 });
  assert.equal(it.upstreamId, '52001');
  assert.deepEqual(it.sources, ['OCHA', 'IFRC', 'WFP']);
  // ongoing + has type + >=3 sources -> high band
  assert.ok(it.confidence >= 0.85);
});

test('reliefweb: falls back to country[] primary, drops out-of-range coords', () => {
  const payload = {
    data: [
      {
        id: 1,
        fields: {
          title: 'Flood Situation Report',
          date: { changed: '2024-06-01T00:00:00Z' },
          country: [
            { name: 'Elsewhere', primary: false, location: { lat: 0, lon: 0 } },
            { name: 'Nepal', primary: true, location: { lat: 999, lon: 999 } },
          ],
        },
      },
    ],
  };
  const items = parseReliefweb(payload, 'reports');
  assert.equal(items[0].country, 'Nepal');
  assert.equal(items[0].location, undefined, 'invalid lat/lon rejected');
});

test('reliefweb: relevanceConfidence + URL builder + empty payloads', () => {
  assert.ok(relevanceConfidence({ status: 'alert', source: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, 'Flood') > 0.89);
  assert.ok(relevanceConfidence({}, undefined) >= 0.3);
  const url = buildRequestUrl('disasters', 25, 'earthquake');
  assert.match(url, /\/v1\/disasters\?/);
  assert.match(url, /appname=samaritan-feeder/);
  assert.match(url, /limit=25/);
  assert.match(url, /query%5Bvalue%5D=earthquake/);
  assert.deepEqual(parseReliefweb(null, 'disasters'), []);
  assert.deepEqual(parseReliefweb({ data: 'x' }, 'disasters'), []);
});

// ---------------------------------------------------------------------------
// GDELT
// ---------------------------------------------------------------------------

test('gdelt: parses ArtList payload, derives domain, maps tone to confidence', () => {
  const payload = {
    articles: [
      {
        url: 'https://news.example.com/a/story-1',
        title: 'Major flooding reported in region',
        seendate: '20240601T120000Z',
        domain: 'news.example.com',
        language: 'English',
        sourcecountry: 'United States',
        tone: -8.5,
      },
      {
        // no domain field -> derived from URL; tone as string
        url: 'https://other.example.org/b',
        title: 'Calm market update',
        seendate: '20240601T130000Z',
        tone: '0.2',
      },
      { title: 'missing url -> skipped', seendate: '20240601T140000Z' },
    ],
  };
  const arts = parseGdelt(payload);
  assert.equal(arts.length, 2, 'article without url is dropped');
  assert.equal(arts[0].domain, 'news.example.com');
  assert.equal(new Date(arts[0].eventAt).toISOString(), '2024-06-01T12:00:00.000Z');
  assert.equal(arts[1].domain, 'other.example.org', 'domain derived from URL');
  assert.equal(arts[1].tone, 0.2, 'string tone coerced to number');
  assert.ok(arts[0].confidence > arts[1].confidence, 'strongly-toned article ranks higher than neutral');
});

test('gdelt: compact timestamp parsing + tone confidence bounds', () => {
  assert.equal(new Date(parseGdeltDate('20240101T000000Z')).toISOString(), '2024-01-01T00:00:00.000Z');
  assert.ok(Number.isFinite(parseGdeltDate('garbage')));
  assert.equal(toneConfidence(undefined), 0.5);
  assert.ok(toneConfidence(-50) <= 0.9, 'confidence saturates, never exceeds cap');
  assert.ok(toneConfidence(0) >= 0.4);
  assert.ok(toneConfidence(-9) > toneConfidence(-1));
});

test('gdelt: bad payloads yield no articles; URL builder is well-formed', () => {
  assert.deepEqual(parseGdelt(null), []);
  assert.deepEqual(parseGdelt({ articles: 'nope' }), []);
  const url = buildDocUrl('flood OR earthquake', 10, '12h');
  assert.match(url, /\/api\/v2\/doc\/doc\?/);
  assert.match(url, /mode=ArtList/);
  assert.match(url, /format=json/);
  assert.match(url, /maxrecords=10/);
  assert.match(url, /timespan=12h/);
});
