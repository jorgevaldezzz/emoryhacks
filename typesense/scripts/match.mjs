// Smoke-test the photo match from the shell: the same call the website makes.
//
//   npm run match -- --reference ref.jpg --at 33.7556,-84.3715
//   npm run match -- --reference ref.jpg --current frame.jpg --at 33.7556,-84.3715
//   npm run match -- --reference https://example.com/ridge.jpg --json
//
// Needs OPENAI_API_KEY (or VISION_API_KEY) in .env.local for the vision call,
// and a seeded Typesense server for the spots.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { matchReferencePhoto } from '../src/match.mjs';
import { SCENE_KEYS } from '../src/scene.mjs';
import { log, main, warn } from './_cli.mjs';

let values;
try {
  ({ values } = parseArgs({
    options: {
      reference: { type: 'string' },
      current: { type: 'string' },
      at: { type: 'string' },
      radius: { type: 'string', default: '3' },
      limit: { type: 'string', default: '5' },
      threshold: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n\nFor a negative coordinate, use an equals sign: --at=-33.8688,151.2093`);
  process.exit(2);
}

if (values.help || !values.reference) {
  log(`Compare a background to a reference photo, and find spots that match it.

  --reference FILE|URL   Required. The look the caller wants.
  --current FILE|URL     A frame of the caller now. Omit to skip the comparison.
  --at lat,lng           Where the caller is. Omit for the comparison alone.
                         Negative values need an equals sign: --at=-33.87,151.21
  --radius 3             Starting radius in km (it widens to 10 km)
  --limit 5
  --threshold 0.65       Above this, the background already matches
  --json                 Print the raw tool result

Scenes: ${SCENE_KEYS.join(', ')}`);
  process.exit(values.help ? 0 : 2);
}

/** A path or a URL; URLs go to the model as-is, files are read off disk. */
const load = async where => (/^https?:\/\//.test(where) ? where : readFile(where));

await main(async () => {
  const [lat, lng] = values.at ? values.at.split(',').map(Number) : [];

  const result = await matchReferencePhoto({
    reference: await load(values.reference),
    current: values.current ? await load(values.current) : undefined,
    lat,
    lng,
    radiusKm: Number(values.radius),
    limit: Number(values.limit),
    threshold: values.threshold ? Number(values.threshold) : undefined,
  });

  if (values.json) {
    log(JSON.stringify(result, null, 2));
    return;
  }

  log(`reference: ${result.reference_scene ?? '—'}${result.reference_background ? ` (${result.reference_background})` : ''}`);
  if (result.current_scene) {
    log(`current:   ${result.current_scene}`);
    log(`similarity ${result.similarity?.toFixed(2)} → ${result.matches ? 'already matching' : 'different enough to move'}`);
  }
  log('');

  if (!result.ok) {
    warn(`${result.reason}: ${result.message}`);
    if (result.detail) warn(`  ${result.detail}`);
    process.exitCode = 1;
    return;
  }

  for (const spot of result.spots) {
    const facing = spot.faces ? `, faces ${spot.faces}` : '';
    const where = spot.heading_text ? `${spot.distance_text} ${spot.heading_text}` : spot.distance_text;
    log(`  ${spot.name}`);
    log(`    ${spot.category} · ${where}${facing} · quality ${spot.quality} · ${spot.source}`);
    for (const tip of spot.tips) log(`    tip: ${tip}`);
    log('');
  }

  log(`Agent would say: ${result.message}`);
  if (result.attribution) log(result.attribution);
});
