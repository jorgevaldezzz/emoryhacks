import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/client.mjs';
import { matchReferencePhoto } from '../src/match.mjs';
import { SpotSearchError } from '../src/search.mjs';
import { VisionError } from '../src/vision.mjs';

const LAT = 33.7556;
const LNG = -84.3715;
const REFERENCE = 'https://example.com/ridge.jpg';
const CURRENT = 'https://example.com/me.jpg';

/** The Typesense stand-in from search.test.mjs: records params, replays answers. */
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

const peak = (overrides = {}) => ({
  document: {
    id: 'osm-node-1',
    name: 'Stone Mountain Summit',
    category: 'peak',
    location: [33.8053, -84.1455],
    source: 'osm',
    quality: 75,
    ...overrides,
  },
});

/** A vision stand-in. Records what it was asked, returns what you tell it to. */
function fakeVision(result) {
  const calls = [];
  const compare = async args => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  compare.calls = calls;
  return compare;
}

const MISMATCH = {
  reference: { scene: 'mountain', tags: ['granite ridge'], background: 'a ridge at sunset' },
  current: { scene: 'interior', tags: ['white wall'], background: 'a bedroom wall' },
  similarity: 0.05,
  difference: 'You are against a bedroom wall; the reference is a mountain ridge.',
};

test('a background that already matches sends nobody anywhere', async () => {
  const client = fakeClient({ hits: [peak()], found: 1 });
  const compare = fakeVision({
    reference: { scene: 'mountain', tags: [] },
    current: { scene: 'mountain', tags: [] },
    similarity: 0.86,
  });

  const result = await matchReferencePhoto({ reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare });

  assert.equal(result.ok, true);
  assert.equal(result.matches, true);
  assert.equal(result.reason, 'already_matching');
  assert.deepEqual(result.spots, []);
  assert.equal(client.calls.length, 0, 'no search when the caller should stay put');
  assert.match(result.message, /already looks like the reference — a mountain/);
});

test('a mountain reference searches summits near the caller', async () => {
  const client = fakeClient({ hits: [peak()], found: 1 });
  const compare = fakeVision(MISMATCH);

  const result = await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare, radiusKm: 5,
  });

  const [params] = client.calls;
  assert.match(params.filter_by, /category:\[`peak`, `cliff`, `viewpoint`\]/);
  assert.match(params.filter_by, /^location:\(33\.7556, -84\.3715, 5 km\)/);
  assert.match(params.q, /granite ridge/);
  assert.match(params.q, /summit/);

  assert.equal(result.ok, true);
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'found');
  assert.equal(result.reference_scene, 'mountain');
  assert.equal(result.current_scene, 'interior');
  assert.equal(result.spots[0].name, 'Stone Mountain Summit');
  assert.match(result.message, /^You are against a bedroom wall; the reference is a mountain ridge\. Stone Mountain Summit,/);
  assert.match(result.attribution, /OpenStreetMap/);
});

test('the reference photo is what gets matched, not the caller', async () => {
  const client = fakeClient({ hits: [peak()], found: 1 });
  // Reference is a mural, caller is on a mountain: look for murals.
  const compare = fakeVision({
    reference: { scene: 'mural', tags: ['painted brick'] },
    current: { scene: 'mountain', tags: [] },
    similarity: 0.1,
  });

  await matchReferencePhoto({ reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare });
  assert.match(client.calls[0].filter_by, /category:\[`mural`, `artwork`\]/);
});

test('nothing in those categories falls back to the words alone', async () => {
  // Thin coverage: the categorised pass finds nothing, the relaxed one does.
  const client = fakeClient((params, call) => (call === 1 ? { hits: [], found: 0 } : { hits: [peak()], found: 1 }));
  const result = await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare: fakeVision(MISMATCH),
    radiusKm: 10, maxRadiusKm: 10,
  });

  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0].filter_by, /category:/);
  assert.doesNotMatch(client.calls[1].filter_by, /category:/, 'the second pass keeps only the geography and the words');
  assert.match(client.calls[1].q, /summit/);
  assert.equal(result.spots.length, 1);
});

test('relax: false asks once', async () => {
  const client = fakeClient({ hits: [], found: 0 });
  const result = await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare: fakeVision(MISMATCH),
    relax: false, radiusKm: 10, maxRadiusKm: 10,
  });

  assert.equal(client.calls.length, 1);
  assert.equal(result.reason, 'no_results');
  assert.match(result.message, /Nothing like it is mapped within 10 km/);
});

test('one photo and no location still says what to look for', async () => {
  const client = fakeClient({ hits: [peak()], found: 1 });
  const compare = fakeVision({ reference: { scene: 'waterfall', tags: ['cascade'] } });
  const result = await matchReferencePhoto({ reference: REFERENCE, client, compare });

  assert.equal(result.ok, true);
  assert.equal(result.matches, false, 'with nothing to compare, nothing is claimed to match');
  assert.equal(result.reason, 'no_location');
  assert.equal(client.calls.length, 0);
  assert.match(result.message, /The reference is a waterfall\. Share a location/);
});

test('a reference alone, with a location, searches for places like it', async () => {
  const client = fakeClient({ hits: [peak()], found: 1 });
  const compare = fakeVision({ reference: { scene: 'mountain', tags: [] } });
  const result = await matchReferencePhoto({ reference: REFERENCE, lat: LAT, lng: LNG, client, compare });

  assert.equal(result.reason, 'found');
  assert.equal(result.similarity, undefined);
  assert.match(client.calls[0].filter_by, /category:\[`peak`/);
});

test('no reference photo asks for one instead of guessing', async () => {
  const result = await matchReferencePhoto({ lat: LAT, lng: LNG, client: fakeClient({ hits: [] }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_reference');
  assert.match(result.message, /send the look they are going for/);
});

test('a vision failure degrades instead of throwing', async () => {
  for (const [error, reason] of [
    [new VisionError('unavailable', 'the model did not answer'), 'unavailable'],
    [new VisionError('bad_image', 'Not a JPEG, PNG, GIF or WebP.'), 'bad_image'],
    [new ConfigError('No vision key.'), 'not_configured'],
    [new Error('boom'), 'unavailable'],
  ]) {
    const result = await matchReferencePhoto({
      reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG,
      client: fakeClient({ hits: [peak()], found: 1 }), compare: fakeVision(error),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.spots, []);
    assert.match(result.message, /Describe the background you want instead/);
    assert.ok(result.detail, 'the real cause stays available for logs');
  }
});

test('a search failure still reports what the photos showed', async () => {
  const result = await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG,
    client: fakeClient(new Error('connect ECONNREFUSED 127.0.0.1:8108')), compare: fakeVision(MISMATCH),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
  assert.equal(result.reference_scene, 'mountain', 'the comparison survived the failed search');
  assert.match(result.message, /bedroom wall/);
  assert.match(result.message, /work with the light where you are/);
});

test('a bad coordinate is a search failure, not a crash', async () => {
  const result = await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: 0, lng: 0,
    client: fakeClient({ hits: [] }), compare: fakeVision(MISMATCH),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_input');
  assert.ok(SpotSearchError, 'the code comes from the SpotSearchError the search threw');
});

test('the threshold decides, and the caller can move it', async () => {
  const compare = fakeVision({ ...MISMATCH, similarity: 0.7 });
  const client = fakeClient({ hits: [peak()], found: 1 });

  const lenient = await matchReferencePhoto({ reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare });
  assert.equal(lenient.matches, true, '0.7 clears the 0.65 default');

  const strict = await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG, client, compare, threshold: 0.9,
  });
  assert.equal(strict.matches, false);
});

test('the vision call is given the caller abort signal', async () => {
  const compare = fakeVision(MISMATCH);
  const signal = AbortSignal.timeout(50_000);
  await matchReferencePhoto({
    reference: REFERENCE, current: CURRENT, lat: LAT, lng: LNG,
    client: fakeClient({ hits: [peak()], found: 1 }), compare, signal,
  });
  assert.equal(compare.calls[0].signal, signal);
  assert.equal(compare.calls[0].reference, REFERENCE);
  assert.equal(compare.calls[0].current, CURRENT);
});
