// Smoke-test searchNearby from the shell, the same call the agent tool makes.
//
//   npm run query -- --at 33.7556,-84.3715
//   npm run query -- --at 33.7556,-84.3715 --q mural --radius 2
//   npm run query -- --at 33.7556,-84.3715 --categories viewpoint,mural --json
import { parseArgs } from 'node:util';
import { CATEGORIES, findNearbySpots } from '../src/search.mjs';
import { log, main } from './_cli.mjs';

// A southern or western coordinate starts with a dash, which parseArgs reads
// as another flag. `--at=-33.8,151.2` is the way through; say so rather than
// letting it throw a cryptic error.
let values;
try {
  ({ values } = parseArgs({
  options: {
    at: { type: 'string' },
    q: { type: 'string' },
    radius: { type: 'string', default: '3' },
    limit: { type: 'string', default: '5' },
    categories: { type: 'string' },
    curated: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  }));
} catch (error) {
  console.error(`${error.message}\n\nFor a negative coordinate, use an equals sign: --at=-33.8688,151.2093`);
  process.exit(2);
}

if (values.help || !values.at) {
  log(`Query photo_spots.

  --at lat,lng          Required. Where the caller is.
                        Negative values need an equals sign: --at=-33.87,151.21
  --q "mural"           Free text; omit to rank purely by distance
  --radius 3            Starting radius in km (it widens if nothing is found)
  --limit 5
  --categories a,b      Any of: ${CATEGORIES.join(', ')}
  --curated             Hand-picked spots only
  --json                Print the raw tool result`);
  process.exit(values.help ? 0 : 2);
}

await main(async () => {
  const [lat, lng] = values.at.split(',').map(Number);

  const result = await findNearbySpots({
    lat,
    lng,
    query: values.q,
    radiusKm: Number(values.radius),
    limit: Number(values.limit),
    categories: values.categories?.split(',').map(s => s.trim()).filter(Boolean),
    curatedOnly: values.curated,
  });

  if (values.json) {
    log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.ok) {
    log(`${result.reason}: ${result.message}`);
    if (result.detail) log(`  ${result.detail}`);
    process.exitCode = 1;
    return;
  }

  if (result.spots.length === 0) {
    log(result.message);
    return;
  }

  log(`${result.spots.length} spot(s) within ${result.radius_km} km:\n`);
  for (const spot of result.spots) {
    const facing = spot.faces ? `, faces ${spot.faces}` : '';
    const where = spot.heading_text ? `${spot.distance_text} ${spot.heading_text}` : spot.distance_text;
    log(`  ${spot.name}`);
    log(`    ${spot.category} · ${where}${facing} · quality ${spot.quality} · ${spot.source}`);
    if (spot.best_time) log(`    best: ${spot.best_time}`);
    for (const tip of spot.tips) log(`    tip: ${tip}`);
    log(`    ${spot.maps_url}`);
    log('');
  }
  log(`Agent would say: ${result.message}`);
  if (result.attribution) log(result.attribution);
});
