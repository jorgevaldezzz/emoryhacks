// Create the photo_spots collection from schema/photo_spots.json.
//
//   npm run collection
//   npm run collection -- --force     # drop and recreate (deletes every document)
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { adminClient, describeTarget, isMissing } from '../src/client.mjs';
import { log, main, n } from './_cli.mjs';

const schemaPath = new URL('../schema/photo_spots.json', import.meta.url);

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  log('Usage: npm run collection [-- --force]\n\n  --force  Drop the existing collection first. Deletes every document.');
  process.exit(0);
}

await main(async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const client = adminClient();
  log(`Typesense: ${describeTarget()}`);

  let existing;
  try {
    existing = await client.collections(schema.name).retrieve();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (existing && !values.force) {
    log(`Collection "${schema.name}" already exists with ${n(existing.num_documents)} documents. Nothing to do.`);
    log('Pass --force to drop and recreate it.');
    return;
  }

  if (existing) {
    log(`Dropping "${schema.name}" (${n(existing.num_documents)} documents)...`);
    await client.collections(schema.name).delete();
  }

  const created = await client.collections().create(schema);
  log(`Created "${created.name}" with ${created.fields.length} fields.`);
  log('Next: npm run seed:curated   and   npm run seed:osm -- --city "Atlanta"');
});
