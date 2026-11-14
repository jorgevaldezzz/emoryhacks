// Generate a search-only API key for photo_spots.
//
//   npm run search-key
//
// The website and any browser code must use this, never TYPESENSE_ADMIN_KEY:
// the admin key can delete the collection, and anything in a browser bundle is
// public. Typesense shows the full key once, at creation. Copy it into
// TYPESENSE_SEARCH_KEY in .env.local and into the web app's own env.
import { parseArgs } from 'node:util';
import { adminClient, COLLECTION, describeTarget } from '../src/client.mjs';
import { log, main } from './_cli.mjs';

const { values } = parseArgs({
  options: {
    description: { type: 'string', default: 'photo_spots search-only' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  log('Usage: npm run search-key [-- --description "web app"]');
  process.exit(0);
}

await main(async () => {
  const client = adminClient();
  log(`Typesense: ${describeTarget()}`);

  const key = await client.keys().create({
    description: values.description,
    actions: ['documents:search'],
    collections: [COLLECTION],
  });

  log(`\nSearch-only key created (id ${key.id}):\n`);
  log(`  TYPESENSE_SEARCH_KEY=${key.value}`);
  log(`\nPaste that into .env.local. Typesense will not show the full value again.`);
});
