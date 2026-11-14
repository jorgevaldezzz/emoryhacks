// Overpass -> normalized documents -> Typesense.
//
//   npm run seed:osm -- --city "Atlanta"
//   npm run seed:osm -- --around 33.7490,-84.3880 --radius 10
//   npm run seed:osm -- --bbox 33.64,-84.55,33.89,-84.29
//   npm run seed:osm -- --city "Atlanta" --dry-run     # count first, import nothing
//
// Run it with --dry-run on a new city before you trust the coverage: OSM is
// volunteer-mapped, so a smaller city can come back nearly empty.
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { adminClient, COLLECTION, describeTarget } from '../src/client.mjs';
import { ATTRIBUTION, buildOverpassQuery, CATEGORIES, fetchOverpass, normalizeElements } from '../src/osm.mjs';
import { log, main, n, warn } from './_cli.mjs';
import { importDocs } from './_import.mjs';

const { values } = parseArgs({
  options: {
    city: { type: 'string' },
    bbox: { type: 'string' },
    around: { type: 'string' },
    radius: { type: 'string', default: '5' },
    categories: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    out: { type: 'string' },
    timeout: { type: 'string', default: '180' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || (!values.city && !values.bbox && !values.around)) {
  log(`Seed photo_spots from OpenStreetMap.

  --city "Atlanta"            Administrative boundary by name
  --bbox s,w,n,e              Bounding box
  --around lat,lng            Point, with --radius KM (default 5)
  --radius 10                 Radius in km for --around
  --categories mural,park     Subset of: ${CATEGORIES.join(', ')}
  --dry-run                   Fetch and report counts, import nothing
  --out FILE                  Also write the normalized docs as JSONL
  --timeout 180               Overpass server-side timeout, seconds

${ATTRIBUTION}`);
  process.exit(values.help ? 0 : 2);
}

await main(async () => {
  const categories = values.categories
    ? values.categories.split(',').map(s => s.trim()).filter(Boolean)
    : CATEGORIES;

  const unknown = categories.filter(c => !CATEGORIES.includes(c));
  if (unknown.length) throw new Error(`Unknown categories: ${unknown.join(', ')}. Known: ${CATEGORIES.join(', ')}`);

  const scope = { categories, timeout: Number(values.timeout) };
  let label;
  if (values.city) {
    scope.areaName = values.city;
    label = values.city;
  } else if (values.bbox) {
    scope.bbox = values.bbox.split(',').map(Number);
    label = `bbox ${values.bbox}`;
  } else {
    const [lat, lng] = values.around.split(',').map(Number);
    scope.around = { lat, lng, radiusKm: Number(values.radius) };
    label = `${values.radius} km around ${lat},${lng}`;
  }

  const query = buildOverpassQuery(scope);
  log(`Querying Overpass for ${label}`);
  log(`Categories: ${categories.join(', ')}`);

  const started = Date.now();
  const elements = await fetchOverpass(query);
  log(`Overpass returned ${n(elements.length)} elements in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

  const { docs, skipped, duplicates } = normalizeElements(elements, { city: values.city });
  log(`Kept ${n(docs.length)} spots (dropped ${n(skipped)} unusable, merged ${n(Math.max(0, duplicates))} duplicates).`);

  const byCategory = {};
  for (const doc of docs) byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
  for (const [category, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    log(`  ${category.padEnd(12)} ${n(count)}`);
  }

  if (docs.length === 0) {
    warn('\nNothing usable came back. Check the spelling of --city, or try --bbox:');
    warn('OSM coverage is thin outside dense cities, and a boundary name has to match exactly.');
    return;
  }
  if (docs.length < 20) {
    warn(`\nOnly ${docs.length} spots. That is thin coverage — consider curating this city by hand (data/curated/).`);
  }

  const outPath = values.out ?? new URL(`../data/osm/${slug(label)}.jsonl`, import.meta.url);
  await mkdir(new URL('../data/osm/', import.meta.url), { recursive: true });
  await writeFile(outPath, docs.map(doc => JSON.stringify(doc)).join('\n') + '\n');
  log(`\nWrote ${n(docs.length)} docs to ${outPath.pathname ?? outPath}`);

  if (values['dry-run']) {
    log('Dry run: nothing imported.');
    return;
  }

  log(`Importing into "${COLLECTION}" at ${describeTarget()}...`);
  const { imported, failed, errors } = await importDocs(adminClient(), docs);
  log(`Imported ${n(imported)} spots${failed ? `, ${n(failed)} failed` : ''}.`);
  for (const error of errors.slice(0, 5)) warn(`  ${error}`);
  log(`\n${ATTRIBUTION} — attribute this anywhere the spots are shown.`);
});

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spots';
}
