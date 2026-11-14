import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Errors } from 'typesense';
import { findNearbySpots, searchNearby, SpotSearchError, summarizeForVoice } from '../src/search.mjs';

const LAT = 33.7556;
const LNG = -84.3715;

/** A stand-in for the Typesense client that records params and replays answers. */
function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    collections: () => ({
      documents: () => ({
        search: async params => {
          calls.push(params);
          const answer = typeof responder === 'function' ? responder(params, calls.length) : responder;
          if (answer instanceof Error) throw answer;
          return answer;
        },
      }),
    }),
  };
}

const hit = (overrides = {}) => ({
  document: {
    id: 'atl-jackson-street-bridge',
    name: 'Jackson Street Bridge',
    category: 'viewpoint',
    location: [33.7556, -84.3715],
    direction: 225,
    source: 'curated',
    quality: 97,
    tips: ['Stand on the north sidewalk'],
    ...overrides,
  },
});

test('searchNearby rejects an unusable coordinate', async () => {
  await assert.rejects(() => searchNearby(NaN, LNG, { client: fakeClient({ hits: [] }) }), /Not a usable coordinate/);
  await assert.rejects(() => searchNearby(0, 0, { client: fakeClient({ hits: [] }) }), SpotSearchError);
});

test('searchNearby filters by radius and sorts by distance', async () => {
  const client = fakeClient({ hits: [hit()], found: 1 });
  const result = await searchNearby(LAT, LNG, { client, radiusKm: 2 });

  const [params] = client.calls;
  assert.match(params.filter_by, /^location:\(33\.7556, -84\.3715, 2 km\)/);
  assert.equal(params.sort_by, `location(${LAT}, ${LNG}):asc,quality:desc`);
  assert.equal(params.q, '*');
  assert.equal(result.spots.length, 1);
  assert.equal(result.radius_km, 2);
});

test('a text query buckets the match, then sorts by distance', async () => {
  const client = fakeClient({ hits: [hit()], found: 1 });
  await searchNearby(LAT, LNG, { client, query: '  mural  ' });
  assert.equal(client.calls[0].q, 'mural');
  // Bucketed, not raw: otherwise a far mural with the word in its name beats a
  // near one. See the comment on sort_by in search.mjs.
  assert.match(client.calls[0].sort_by, /^_text_match\(buckets: \d+\):desc,location/);
});

test('options become filters', async () => {
  const client = fakeClient({ hits: [hit()], found: 1 });
  await searchNearby(LAT, LNG, {
    client,
    categories: ['mural', 'viewpoint', 'bogus'],
    curatedOnly: true,
    minQuality: 70,
    city: 'Atlanta',
    excludeIndoor: true,
    bestTime: 'golden hour',
  });

  const { filter_by: filter } = client.calls[0];
  assert.match(filter, /category:\[`mural`, `viewpoint`\]/, 'unknown categories are dropped');
  assert.match(filter, /source:=curated/);
  assert.match(filter, /quality:>=70/);
  assert.match(filter, /city:=`Atlanta`/);
  assert.match(filter, /indoor:!=true/);
  assert.match(filter, /best_time:=`golden hour`/);
});

test('the radius widens until something is found', async () => {
  const client = fakeClient((params, call) => (call < 3 ? { hits: [], found: 0 } : { hits: [hit()], found: 1 }));
  const result = await searchNearby(LAT, LNG, { client, radiusKm: 1 });

  assert.equal(client.calls.length, 3);
  assert.equal(result.radius_km, 9, '1 km, then 3, then 9');
  assert.equal(result.spots.length, 1);
});

test('expansion stops at maxRadiusKm and gives up cleanly', async () => {
  const client = fakeClient({ hits: [], found: 0 });
  const result = await searchNearby(LAT, LNG, { client, radiusKm: 1, maxRadiusKm: 10 });

  assert.deepEqual(result.spots, []);
  assert.equal(result.radius_km, 10);
  assert.ok(client.calls.length <= 4);
  for (const call of client.calls) assert.match(call.filter_by, /, (1|3|9|10) km\)/);
});

test('expand: false searches exactly once', async () => {
  const client = fakeClient({ hits: [], found: 0 });
  await searchNearby(LAT, LNG, { client, radiusKm: 1, expand: false });
  assert.equal(client.calls.length, 1);
});

test('a hit becomes a spot an agent can read out', async () => {
  // A point roughly 1 km north of the caller.
  const north = hit({ location: [33.7646, -84.3715], name: 'North Spot' });
  const client = fakeClient({ hits: [north], found: 1 });
  const { spots } = await searchNearby(LAT, LNG, { client });
  const [spot] = spots;

  assert.equal(spot.name, 'North Spot');
  assert.equal(spot.heading, 'N');
  assert.equal(spot.heading_text, 'north');
  assert.equal(spot.faces, 'southwest', 'direction 225 reads as the view direction');
  assert.ok(spot.distance_km > 0.9 && spot.distance_km < 1.1);
  assert.equal(spot.distance_text, '1.0 km');
  assert.match(spot.maps_url, /maps\/search/);
});

test('Typesense geo_distance_meters is preferred over our own maths', async () => {
  const client = fakeClient({ hits: [{ ...hit({ location: [33.76, -84.37] }), geo_distance_meters: { location: 4242 } }], found: 1 });
  const { spots } = await searchNearby(LAT, LNG, { client });
  assert.equal(spots[0].distance_km, 4.24);
});

test('a missing collection says how to seed it', async () => {
  const missing = new Errors.ObjectNotFound('Not Found');
  const client = fakeClient(missing);
  await assert.rejects(() => searchNearby(LAT, LNG, { client }), error => {
    assert.equal(error.code, 'not_seeded');
    assert.match(error.message, /npm run collection/);
    return true;
  });
});

test('findNearbySpots never throws when the server is down', async () => {
  const client = fakeClient(new Error('connect ECONNREFUSED 127.0.0.1:8108'));
  const result = await findNearbySpots({ lat: LAT, lng: LNG, client });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(result.spots, []);
  assert.match(result.message, /Carry on coaching/, 'the agent gets something safe to say');
  assert.match(result.detail, /ECONNREFUSED/, 'the real cause stays available for logs');
});

test('findNearbySpots asks for a location rather than guessing', async () => {
  const result = await findNearbySpots({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_location');
  assert.match(result.message, /share one/);
});

test('an empty area is a success, with advice to fall back on', async () => {
  const client = fakeClient({ hits: [], found: 0 });
  const result = await findNearbySpots({ lat: LAT, lng: LNG, client, radiusKm: 1, maxRadiusKm: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no_results');
  assert.deepEqual(result.spots, []);
  assert.match(result.message, /Coverage is thin/);
});

test('bad input degrades instead of throwing', async () => {
  const result = await findNearbySpots({ lat: 'north', lng: LNG, client: fakeClient({ hits: [] }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_input');
});

test('summarizeForVoice stays short', () => {
  const spots = [
    { name: 'A', distance_text: '250 m', heading_text: 'north', faces: 'southwest' },
    { name: 'B', distance_text: '1.2 km', heading_text: 'east' },
    { name: 'C', distance_text: '3 km', heading_text: 'south' },
  ];
  const line = summarizeForVoice(spots);
  assert.match(line, /^A, 250 m north, facing southwest; and B, 1\.2 km east\.$/);
  assert.ok(!line.includes('C'), 'only the top two are spoken');
  assert.equal(summarizeForVoice([]), 'No spots nearby.');
});

test('a spot underfoot gets no invented bearing', async () => {
  const client = fakeClient({ hits: [hit({ location: [LAT, LNG] })], found: 1 });
  const { spots } = await searchNearby(LAT, LNG, { client });

  assert.equal(spots[0].distance_text, 'right here');
  assert.equal(spots[0].heading, undefined);
  assert.equal(spots[0].heading_text, undefined);
  assert.match(summarizeForVoice(spots), /^Jackson Street Bridge, right here, facing southwest\.$/);
});

test('attribution is claimed only when an OSM row is in the answer', async () => {
  const curated = await searchNearby(LAT, LNG, { client: fakeClient({ hits: [hit({ source: 'curated' })], found: 1 }) });
  assert.equal(curated.attribution, '');

  const osm = await searchNearby(LAT, LNG, { client: fakeClient({ hits: [hit({ source: 'osm' })], found: 1 }) });
  assert.match(osm.attribution, /OpenStreetMap/);
});
