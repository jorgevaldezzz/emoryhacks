// Guards the two files that are easy to break by hand: the collection schema
// and the curated spot list.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { isValidLatLng, parseDirection } from '../src/geo.mjs';
import { CATEGORIES } from '../src/osm.mjs';

const schema = JSON.parse(await readFile(new URL('../schema/photo_spots.json', import.meta.url), 'utf8'));

test('the schema is one Typesense collection with a geopoint', () => {
  assert.equal(schema.name, 'photo_spots');
  const byName = Object.fromEntries(schema.fields.map(field => [field.name, field]));
  assert.equal(byName.location.type, 'geopoint');
  assert.equal(byName.category.facet, true);
  assert.equal(byName.source.facet, true);
});

test('default_sorting_field is a required numeric field', () => {
  const field = schema.fields.find(f => f.name === schema.default_sorting_field);
  assert.ok(field, `${schema.default_sorting_field} is not in fields`);
  assert.ok(['int32', 'int64', 'float'].includes(field.type));
  assert.notEqual(field.optional, true, 'Typesense rejects an optional default_sorting_field');
});

test('non-indexed fields are optional, as Typesense requires', () => {
  for (const field of schema.fields.filter(f => f.index === false)) {
    assert.equal(field.optional, true, `${field.name} is index:false but not optional`);
  }
});

test('search queries only fields the schema indexes', () => {
  const indexed = new Set(schema.fields.filter(f => f.index !== false).map(f => f.name));
  for (const name of ['name', 'description', 'tags', 'city']) {
    assert.ok(indexed.has(name), `query_by names "${name}", which is not indexed`);
  }
});

const curatedDir = new URL('../data/curated/', import.meta.url);
const files = (await readdir(curatedDir)).filter(name => name.endsWith('.jsonl'));

test('there is curated data to seed', () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  test(`${file} is valid curated data`, async () => {
    const text = await readFile(new URL(file, curatedDir), 'utf8');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));
    assert.ok(lines.length > 0, 'file has no spots');

    const ids = new Set();
    for (const [index, line] of lines.entries()) {
      const where = `${file}:${index + 1}`;
      const spot = JSON.parse(line);

      assert.ok(spot.name, `${where} has no name`);
      assert.ok(CATEGORIES.includes(spot.category), `${where} has unknown category "${spot.category}"`);
      assert.ok(isValidLatLng(spot.lat, spot.lng), `${where} has a bad coordinate`);
      assert.ok(!ids.has(spot.id), `${where} repeats id "${spot.id}"`);
      ids.add(spot.id);

      if (spot.direction !== undefined) {
        assert.notEqual(parseDirection(spot.direction), undefined, `${where} has an unparseable direction`);
      }
      if (spot.quality !== undefined) {
        assert.ok(spot.quality >= 0 && spot.quality <= 100, `${where} quality out of range`);
      }
      for (const tip of spot.tips ?? []) assert.equal(typeof tip, 'string', `${where} has a non-string tip`);
    }
  });
}
