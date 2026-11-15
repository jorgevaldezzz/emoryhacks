import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uploadCaptureToGallery } from '../gallery_upload.mjs';

describe('uploadCaptureToGallery', () => {
  it('skips when gallery env is missing', async () => {
    const result = await uploadCaptureToGallery({
      bytes: Buffer.from([1, 2, 3]),
      apiUrl: '',
      ingestSecret: 'secret',
      email: 'a@b.com',
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  });

  it('posts base64 PNG to /api/gallery/chert', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let seen;
    const result = await uploadCaptureToGallery({
      bytes,
      apiUrl: 'https://api.example.com',
      ingestSecret: 'ingest-secret',
      email: 'jorge@example.com',
      name: 'snap.png',
      fetchImpl: async (url, init = {}) => {
        seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
        return {
          ok: true,
          json: async () => ({ item: { id: 'g1', source: 'chert' } }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.item.id, 'g1');
    assert.equal(seen.url, 'https://api.example.com/api/gallery/chert');
    assert.equal(seen.headers['X-Ingest-Secret'], 'ingest-secret');
    assert.equal(seen.body.email, 'jorge@example.com');
    assert.equal(seen.body.imageBase64, bytes.toString('base64'));
  });
});
