import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOverpassQuery, CATEGORIES, classify, normalizeElement, normalizeElements } from '../src/osm.mjs';

test('classify maps the documented tags', () => {
  assert.equal(classify({ tourism: 'viewpoint' }), 'viewpoint');
  assert.equal(classify({ tourism: 'artwork', artwork_type: 'mural' }), 'mural');
  assert.equal(classify({ tourism: 'artwork', artwork_type: 'graffiti' }), 'mural');
  assert.equal(classify({ tourism: 'artwork', artwork_type: 'statue' }), 'artwork');
  assert.equal(classify({ tourism: 'artwork' }), 'artwork');
  assert.equal(classify({ tourism: 'attraction' }), 'attraction');
  assert.equal(classify({ leisure: 'park' }), 'park');
  assert.equal(classify({ natural: 'beach' }), 'beach');
  assert.equal(classify({ waterway: 'waterfall' }), 'waterfall');
  assert.equal(classify({ man_made: 'pier' }), 'pier');
  assert.equal(classify({ natural: 'peak' }), 'peak');
  assert.equal(classify({ natural: 'cliff' }), 'cliff');
  assert.equal(classify({ man_made: 'bridge' }), 'bridge');
  assert.equal(classify({ amenity: 'cafe' }), undefined);
  // A viewpoint on a summit is still a viewpoint: it carries the view direction.
  assert.equal(classify({ natural: 'peak', tourism: 'viewpoint' }), 'viewpoint');
});

test('an unnamed summit is still a summit; an unnamed bridge is not a spot', () => {
  const peak = normalizeElement({ type: 'node', id: 11, lat: 44.27, lon: -71.3, tags: { natural: 'peak', ele: '1917' } });
  assert.equal(peak.category, 'peak');
  assert.match(peak.name, /summit/i);

  assert.equal(normalizeElement({ type: 'way', id: 12, center: { lat: 33.75, lon: -84.36 }, tags: { man_made: 'bridge' } }), null);
});

test('normalizeElement builds a document from a node', () => {
  const doc = normalizeElement(
    { type: 'node', id: 123, lat: 33.7556, lon: -84.3715, tags: { tourism: 'viewpoint', name: 'Jackson Street Bridge', direction: 'SW' } },
    { city: 'Atlanta', now: 1_700_000_000_000 },
  );
  assert.equal(doc.id, 'osm-node-123');
  assert.equal(doc.name, 'Jackson Street Bridge');
  assert.equal(doc.category, 'viewpoint');
  assert.deepEqual(doc.location, [33.7556, -84.3715]);
  assert.equal(doc.direction, 225);
  assert.equal(doc.city, 'Atlanta');
  assert.equal(doc.source, 'osm');
  assert.equal(doc.osm_id, 'node/123');
  assert.equal(doc.updated_at, 1_700_000_000);
});

test('normalizeElement reads the centre of a way', () => {
  const doc = normalizeElement({ type: 'way', id: 9, center: { lat: 33.78, lon: -84.37 }, tags: { leisure: 'park', name: 'Piedmont Park' } });
  assert.deepEqual(doc.location, [33.78, -84.37]);
  assert.equal(doc.id, 'osm-way-9');
});

test('normalizeElement drops elements with no coordinates or no category', () => {
  assert.equal(normalizeElement({ type: 'node', id: 1, tags: { tourism: 'viewpoint' } }), null);
  assert.equal(normalizeElement({ type: 'node', id: 2, lat: 1, lon: 1, tags: { amenity: 'bench' } }), null);
  assert.equal(normalizeElement(null), null);
});

test('unnamed murals survive, unnamed attractions do not', () => {
  const mural = normalizeElement({ type: 'node', id: 3, lat: 33.75, lon: -84.36, tags: { tourism: 'artwork', artwork_type: 'mural' } });
  assert.ok(mural);
  assert.match(mural.name, /mural/i);

  const attraction = normalizeElement({ type: 'node', id: 4, lat: 33.75, lon: -84.36, tags: { tourism: 'attraction' } });
  assert.equal(attraction, null);
});

test('an unnamed element borrows its street name', () => {
  const doc = normalizeElement({ type: 'node', id: 5, lat: 33.75, lon: -84.36, tags: { tourism: 'artwork', artwork_type: 'mural', 'addr:street': 'Wylie Street' } });
  assert.equal(doc.name, 'Mural on Wylie Street');
});

test('quality rewards description signals and penalises private access', () => {
  const plain = normalizeElement({ type: 'node', id: 6, lat: 33.75, lon: -84.36, tags: { tourism: 'viewpoint', name: 'A' } });
  const rich = normalizeElement({ type: 'node', id: 7, lat: 33.75, lon: -84.36, tags: { tourism: 'viewpoint', name: 'B', wikidata: 'Q1' } });
  const shut = normalizeElement({ type: 'node', id: 8, lat: 33.75, lon: -84.36, tags: { tourism: 'viewpoint', name: 'C', access: 'private' } });
  assert.ok(rich.quality > plain.quality);
  assert.ok(shut.quality < plain.quality);
  // The catch-all ranks below a viewpoint, as intended.
  const attraction = normalizeElement({ type: 'node', id: 9, lat: 33.75, lon: -84.36, tags: { tourism: 'attraction', name: 'D' } });
  assert.ok(attraction.quality < plain.quality);
});

test('normalizeElements merges duplicates and counts the rest', () => {
  const elements = [
    { type: 'node', id: 1, lat: 33.7556, lon: -84.3715, tags: { tourism: 'viewpoint', name: 'Bridge' } },
    { type: 'way', id: 2, center: { lat: 33.75561, lon: -84.37151 }, tags: { tourism: 'viewpoint', name: 'Bridge', wikidata: 'Q1' } },
    { type: 'node', id: 3, lat: 33.75, lon: -84.36, tags: { amenity: 'bench' } },
  ];
  const { docs, skipped } = normalizeElements(elements);
  assert.equal(docs.length, 1, 'the two mappings of one bridge collapse');
  assert.equal(docs[0].osm_id, 'way/2', 'the higher-quality mapping wins');
  assert.equal(skipped, 1);
});

test('buildOverpassQuery scopes by area, bbox and radius', () => {
  const byArea = buildOverpassQuery({ areaName: 'Atlanta' });
  assert.match(byArea, /area\["name"="Atlanta"\]\["boundary"="administrative"\]->\.a;/);
  assert.match(byArea, /\(area\.a\);/);
  assert.match(byArea, /out center tags;$/);

  assert.match(buildOverpassQuery({ bbox: [33.6, -84.6, 33.9, -84.2] }), /\(33\.6,-84\.6,33\.9,-84\.2\);/);
  assert.match(buildOverpassQuery({ around: { lat: 33.75, lng: -84.39, radiusKm: 2 } }), /\(around:2000,33\.75,-84\.39\);/);
});

test('buildOverpassQuery filters to the asked-for categories', () => {
  const query = buildOverpassQuery({ areaName: 'Atlanta', categories: ['mural'] });
  assert.match(query, /artwork_type/);
  assert.doesNotMatch(query, /leisure"="park/);
});

test('buildOverpassQuery rejects bad scopes', () => {
  assert.throws(() => buildOverpassQuery({}), /exactly one/);
  assert.throws(() => buildOverpassQuery({ areaName: 'A', bbox: [1, 2, 3, 4] }), /exactly one/);
  assert.throws(() => buildOverpassQuery({ areaName: 'A', categories: ['nope'] }), /No known categories/);
  assert.throws(() => buildOverpassQuery({ bbox: [1, 2] }), /four numbers/);
});

test('an area name cannot break out of the Overpass string literal', () => {
  const query = buildOverpassQuery({ areaName: 'At"lanta\\' });
  assert.match(query, /\["name"="Atlanta"\]/);
});

test('CATEGORIES covers every rule', () => {
  assert.ok(CATEGORIES.includes('viewpoint') && CATEGORIES.includes('attraction'));
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
});
