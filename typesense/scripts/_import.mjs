// Batched upsert into photo_spots, shared by the seeding scripts.
import { Errors } from 'typesense';
import { COLLECTION } from '../src/client.mjs';

const BATCH = 500;

/**
 * Upsert documents, in batches, tolerating per-document failures.
 *
 * The client throws ImportError when any row in a batch fails, with the
 * per-row results attached; we unwrap that instead of letting one malformed
 * spot lose the other nine hundred.
 *
 * @returns {Promise<{imported: number, failed: number, errors: string[]}>}
 */
export async function importDocs(client, docs, { batchSize = BATCH, onProgress } = {}) {
  const documents = client.collections(COLLECTION).documents();
  let imported = 0;
  let failed = 0;
  const errors = [];

  for (let start = 0; start < docs.length; start += batchSize) {
    const batch = docs.slice(start, start + batchSize);

    let results;
    try {
      results = await documents.import(batch, { action: 'upsert' });
    } catch (error) {
      if (!(error instanceof Errors.ImportError) || !Array.isArray(error.importResults)) throw error;
      results = error.importResults;
    }

    for (const [index, result] of results.entries()) {
      if (result?.success) {
        imported += 1;
      } else {
        failed += 1;
        if (errors.length < 20) errors.push(`${batch[index]?.id ?? '?'}: ${result?.error ?? 'unknown error'}`);
      }
    }
    onProgress?.({ imported, failed, total: docs.length });
  }

  return { imported, failed, errors };
}
