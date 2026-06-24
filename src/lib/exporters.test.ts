import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csvCell, toCsv, toNdjson, escapeXml, toGexf, toSigmaJson, parentChildToTree } from './exporters.js';

test('csvCell quotes commas/quotes/newlines and JSON-encodes objects', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  // objects are JSON-encoded, then CSV-quoted because the JSON contains quotes.
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

test('toCsv emits a header then rows; toNdjson is one JSON object per line', () => {
  const rows = [{ a: 1, b: 'x,y' }, { a: 2, b: 'z' }];
  const csv = toCsv(rows, ['a', 'b']);
  assert.ok(csv.startsWith('a,b\r\n'));
  assert.ok(csv.includes('1,"x,y"'));

  const nd = toNdjson(rows).trim().split('\n');
  assert.equal(nd.length, 2);
  assert.deepEqual(JSON.parse(nd[0]), { a: 1, b: 'x,y' });
});

test('escapeXml escapes the five predefined entities', () => {
  assert.equal(escapeXml(`a & b < c > "d" 'e'`), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
});

test('toGexf produces well-formed XML with escaped labels and edges', () => {
  const gexf = toGexf(
    [{ id: 'n1', label: 'A & B', attributes: { type: 'org' } }, { id: 'n2', label: 'C' }],
    [{ source: 'n1', target: 'n2', weight: 0.5 }],
  );
  assert.ok(gexf.includes('<gexf'));
  assert.ok(gexf.includes('label="A &amp; B"')); // label escaped
  assert.ok(gexf.includes('source="n1" target="n2"'));
});

test('toSigmaJson returns a parseable { nodes, edges }', () => {
  const json = JSON.parse(toSigmaJson([{ id: 'n1', label: 'A' }], [{ source: 'n1', target: 'n1' }]));
  assert.equal(json.nodes.length, 1);
  assert.equal(json.edges.length, 1);
  assert.equal(json.nodes[0].id, 'n1');
});

test('parentChildToTree builds a bounded tree and prunes cycles', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' }, // cycle back to root
  ];
  const tree = parentChildToTree('a', edges, { maxDepth: 5 });
  assert.equal(tree.id, 'a');
  assert.equal(tree.children[0].id, 'b');
  assert.equal(tree.children[0].children[0].id, 'c');
  // the c -> a edge is a cycle and must be pruned (a already on the path).
  assert.equal(tree.children[0].children[0].children.length, 0);
});
