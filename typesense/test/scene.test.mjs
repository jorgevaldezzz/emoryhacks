import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORIES } from '../src/osm.mjs';
import { normalizeSceneKey, sceneLabel, SCENE_KEYS, SCENES, searchOptionsFor, sceneVocabulary } from '../src/scene.mjs';

test('every scene points at categories the index actually has', () => {
  for (const [key, scene] of Object.entries(SCENES)) {
    assert.ok(scene.look && scene.label, `${key} is missing look or label`);
    assert.ok(scene.terms.length > 0, `${key} has no terms`);
    for (const category of scene.categories) {
      assert.ok(CATEGORIES.includes(category), `scene "${key}" names unknown category "${category}"`);
    }
  }
});

test('a mountain photo searches summits, not parking lots', () => {
  const { categories, query } = searchOptionsFor({ scene: 'mountain', tags: ['granite ridge', 'pine trees'] });
  assert.deepEqual(categories, ['peak', 'cliff', 'viewpoint']);
  // The model's own words lead; the scene's words back them up.
  assert.match(query, /^granite ridge pine trees /);
  assert.match(query, /summit/);
});

test('tree and greenery backgrounds search parks, gardens, and viewpoints', () => {
  const forest = searchOptionsFor({ scene: 'forest', tags: ['trees', 'green trail'] });
  assert.deepEqual(forest.categories, ['park', 'garden', 'viewpoint']);
  assert.match(forest.query, /trees/);
  assert.match(forest.query, /trees green trail forest woods trail greenery/);

  const park = searchOptionsFor({ scene: 'park', tags: ['scattered trees', 'open grass'] });
  assert.deepEqual(park.categories, ['park', 'garden']);
});

test('unknown scenes filter nothing rather than guessing', () => {
  const { categories, query } = searchOptionsFor({ scene: 'volcano', tags: ['lava'] });
  assert.deepEqual(categories, []);
  assert.equal(query, 'lava');
  assert.equal(normalizeSceneKey('Volcano'), 'unknown');
  assert.equal(normalizeSceneKey('MOUNTAIN'), 'mountain');
  assert.equal(normalizeSceneKey(undefined), 'unknown');
});

test('a plain backdrop has no category to filter on', () => {
  assert.deepEqual(searchOptionsFor({ scene: 'plain' }).categories, []);
  assert.match(searchOptionsFor({ scene: 'plain' }).query, /wall/);
});

test('relax keeps the words and drops the categories', () => {
  const strict = searchOptionsFor({ scene: 'waterfall' });
  const relaxed = searchOptionsFor({ scene: 'waterfall' }, { relax: true });
  assert.deepEqual(strict.categories, ['waterfall']);
  assert.deepEqual(relaxed.categories, []);
  assert.equal(relaxed.query, strict.query);
});

test('model tags cannot smuggle filter syntax into the query', () => {
  const { query } = searchOptionsFor({ scene: 'mural', tags: ['`mural` && quality:>=99', 'x'.repeat(50), 'ok'] });
  assert.doesNotMatch(query, /[`&:>]/);
  assert.doesNotMatch(query, /x{30}/);
  assert.match(query, /\bok\b/);
});

test('labels are sayable and the vocabulary covers every scene', () => {
  assert.equal(sceneLabel('mountain'), 'a mountain');
  assert.match(sceneLabel('nope'), /could not place/);
  const vocabulary = sceneVocabulary();
  for (const key of SCENE_KEYS) assert.match(vocabulary, new RegExp(`^- ${key}: `, 'm'));
});
