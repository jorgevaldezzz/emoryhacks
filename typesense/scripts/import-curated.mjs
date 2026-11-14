// Import hand-curated spots from data/curated/*.jsonl.
//
//   npm run seed:curated
//   npm run seed:curated -- --file data/curated/atlanta.jsonl
//
// Curated spots are the answer to OSM's blind spot: tags say what a place is,
// not whether it photographs well. These carry tips, a best time, and a high
// quality score so they outrank bulk-imported OSM rows.
import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { adminClient, COLLECTION, describeTarget } from '../src/client.mjs';
import { isValidLatLng, parseDirection } from '../src/geo.mjs';
import { log, main, n, warn } from './_cli.mjs';
import { importDocs } from './_import.mjs';

const curatedDir = new URL('../data/curated/', import.meta.url);

const { values } = parseArgs({
  options: {
    file: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  log(`Import curated spots.

  --file PATH     One or more JSONL files (default: every .jsonl in data/curated/)
  --dry-run       Validate only, import nothing

Each line is one JSON object:
  { "id": "atl-jackson-street-bridge", "name": "Jackson Street Bridge",
    "category": "viewpoint", "lat": 33.7556, "lng": -84.3715,
    "city": "Atlanta", "direction": "SW", "best_time": "golden hour",
    "quality": 95, "tips": ["Stand on the north sidewalk"] }

lat/lng may also be given as "location": [lat, lng]. direction accepts
degrees or a compass point.`);
  process.exit(0);
}

await main(async () => {
  const files = values.file?.length
    ? values.file.map(path => new URL(path, `file://${process.cwd()}/`))
    : (await readdir(curatedDir))
        .filter(name => name.endsWith('.jsonl'))
        .sort()
        .map(name => new URL(name, curatedDir));

  if (files.length === 0) {
    warn(`No .jsonl files in ${curatedDir.pathname}. Nothing to import.`);
    return;
  }

  const docs = [];
  const problems = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    let kept = 0;

    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const where = `${file.pathname.split('/').pop()}:${index + 1}`;

      let raw;
      try {
        raw = JSON.parse(trimmed);
      } catch (error) {
        problems.push(`${where} is not valid JSON: ${error.message}`);
        continue;
      }

      const doc = normalize(raw, problems, where);
      if (doc) {
        docs.push(doc);
        kept += 1;
      }
    }
    log(`${file.pathname.split('/').pop()}: ${n(kept)} spots`);
  }

  for (const problem of problems) warn(`  ! ${problem}`);
  if (docs.length === 0) throw new Error('No valid curated spots to import.');

  const ids = new Set();
  for (const doc of docs) {
    if (ids.has(doc.id)) warn(`  ! duplicate id "${doc.id}" — the last one wins`);
    ids.add(doc.id);
  }

  if (values['dry-run']) {
    log(`\nDry run: ${n(docs.length)} spots validated, nothing imported.`);
    return;
  }

  log(`\nImporting ${n(docs.length)} curated spots into "${COLLECTION}" at ${describeTarget()}...`);
  const { imported, failed, errors } = await importDocs(adminClient(), docs);
  log(`Imported ${n(imported)}${failed ? `, ${n(failed)} failed` : ''}.`);
  for (const error of errors) warn(`  ${error}`);
});

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Accept the friendly curated shape and produce a valid photo_spots document. */
function normalize(raw, problems, where) {
  const name = raw.name?.trim();
  if (!name) {
    problems.push(`${where} has no name`);
    return null;
  }

  const lat = Number(raw.lat ?? raw.location?.[0]);
  const lng = Number(raw.lng ?? raw.lon ?? raw.location?.[1]);
  if (!isValidLatLng(lat, lng)) {
    problems.push(`${where} ("${name}") has no usable lat/lng`);
    return null;
  }

  if (!raw.category) {
    problems.push(`${where} ("${name}") has no category`);
    return null;
  }

  const doc = {
    id: raw.id || `curated-${slug(raw.city ?? '')}-${slug(name)}`.replace(/--+/g, '-'),
    name,
    category: raw.category,
    location: [lat, lng],
    source: 'curated',
    // Curated beats OSM by default; override per spot when one is mediocre.
    quality: Number.isFinite(Number(raw.quality)) ? Math.round(Number(raw.quality)) : 85,
    updated_at: Math.floor(Date.now() / 1000),
  };

  if (raw.description) doc.description = String(raw.description);
  if (raw.city) doc.city = String(raw.city);
  if (raw.best_time) doc.best_time = String(raw.best_time);
  if (raw.indoor !== undefined) doc.indoor = Boolean(raw.indoor);
  if (raw.website) doc.website = String(raw.website);
  if (raw.image) doc.image = String(raw.image);
  if (raw.osm_id) doc.osm_id = String(raw.osm_id);

  const tags = Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : [];
  if (tags.length) doc.tags = tags;

  const tips = Array.isArray(raw.tips) ? raw.tips.map(String).filter(Boolean) : raw.tips ? [String(raw.tips)] : [];
  if (tips.length) doc.tips = tips;

  const direction = parseDirection(raw.direction);
  if (direction !== undefined) doc.direction = Math.round(direction);

  return doc;
}
