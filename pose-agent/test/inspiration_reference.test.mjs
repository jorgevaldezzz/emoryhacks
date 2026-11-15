import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import {
  buildSkeletonOverlay,
  fetchInspirationUpload,
  syncInspirationReference,
  uploadSkeletonToGallery,
} from '../inspiration_reference.mjs';

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('fetchInspirationUpload', () => {
  it('returns null when gallery env is missing', async () => {
    const result = await fetchInspirationUpload({ apiUrl: '', ingestSecret: 'x', email: 'a@b.com' });
    assert.equal(result, null);
  });

  it('looks up the latest upload then downloads its bytes', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/chert/reference')) {
        return {
          ok: true,
          json: async () => ({
            item: { id: 'g1', url: '/uploads/g1', mimeType: 'image/png' },
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => ONE_BY_ONE_PNG.buffer.slice(
          ONE_BY_ONE_PNG.byteOffset,
          ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
        ),
      };
    };

    const result = await fetchInspirationUpload({
      apiUrl: 'https://api.example.com',
      ingestSecret: 'ingest-secret',
      email: 'jorge@example.com',
      fetchImpl,
    });

    assert.equal(result.itemId, 'g1');
    assert.equal(result.mime, 'image/png');
    assert.equal(result.dataUrl, `data:image/png;base64,${ONE_BY_ONE_PNG.toString('base64')}`);
    assert.equal(calls[0].url, 'https://api.example.com/api/gallery/chert/reference?email=jorge%40example.com');
    assert.equal(calls[0].init.headers['X-Ingest-Secret'], 'ingest-secret');
    assert.equal(calls[1].url, 'https://api.example.com/uploads/g1');
  });

  it('returns null when the account has no upload yet', async () => {
    const result = await fetchInspirationUpload({
      apiUrl: 'https://api.example.com',
      ingestSecret: 'ingest-secret',
      email: 'jorge@example.com',
      fetchImpl: async () => ({ ok: false }),
    });
    assert.equal(result, null);
  });
});

describe('buildSkeletonOverlay', () => {
  it('returns null when no person is visible', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#000' } }).png().toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const overlay = await buildSkeletonOverlay({ dataUrl, detectPose: async () => ({ personVisible: false }) });
    assert.equal(overlay, null);
  });

  it('draws a PNG overlay when enough joints are visible', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#000' } }).png().toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const landmarks = {
      nose: { x: 0.5, y: 0.1, confidence: 1 },
      left_shoulder: { x: 0.3, y: 0.3, confidence: 1 },
      right_shoulder: { x: 0.7, y: 0.3, confidence: 1 },
      left_hip: { x: 0.3, y: 0.7, confidence: 1 },
      right_hip: { x: 0.7, y: 0.7, confidence: 1 },
    };
    const overlay = await buildSkeletonOverlay({
      dataUrl,
      detectPose: async () => ({ personVisible: true, landmarks }),
    });
    assert.ok(overlay);
    assert.ok(overlay.buffer.length > 0);
    assert.ok(overlay.drawn >= 5);
  });
});

describe('uploadSkeletonToGallery', () => {
  it('skips when gallery env is missing', async () => {
    const result = await uploadSkeletonToGallery({ bytes: Buffer.from([1]), apiUrl: '', ingestSecret: 's', email: 'a@b.com' });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  });

  it('posts the skeleton PNG with source upload and the Inspiration skeleton note', async () => {
    let seen;
    const result = await uploadSkeletonToGallery({
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      apiUrl: 'https://api.example.com',
      ingestSecret: 'ingest-secret',
      email: 'jorge@example.com',
      fetchImpl: async (url, init = {}) => {
        seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ item: { id: 'g2', source: 'upload' } }) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.item.id, 'g2');
    assert.equal(seen.url, 'https://api.example.com/api/gallery/chert');
    assert.equal(seen.body.source, 'upload');
    assert.equal(seen.body.note, 'Inspiration skeleton');
  });
});

describe('syncInspirationReference', () => {
  it('returns null (never throws) when the gallery env is missing', async () => {
    const result = await syncInspirationReference({
      apiUrl: '',
      ingestSecret: 'x',
      email: 'a@b.com',
      detectPose: async () => ({ personVisible: false }),
    });
    assert.equal(result, null);
  });

  it('fetches the upload, uploads a skeleton, and returns the original photo as the reference', async () => {
    const posted = [];
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      if (href.includes('/chert/reference')) {
        return { ok: true, json: async () => ({ item: { id: 'g1', url: '/uploads/g1', mimeType: 'image/png' } }) };
      }
      if (href.includes('/uploads/g1')) {
        return {
          ok: true,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => {
            const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#000' } }).png().toBuffer();
            return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
          },
        };
      }
      if (href.endsWith('/api/gallery/chert') && init.method === 'POST') {
        posted.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ item: { id: 'skeleton-1', source: 'upload' } }) };
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const landmarks = {
      nose: { x: 0.5, y: 0.1, confidence: 1 },
      left_shoulder: { x: 0.3, y: 0.3, confidence: 1 },
      right_shoulder: { x: 0.7, y: 0.3, confidence: 1 },
      left_hip: { x: 0.3, y: 0.7, confidence: 1 },
      right_hip: { x: 0.7, y: 0.7, confidence: 1 },
    };

    const result = await syncInspirationReference({
      apiUrl: 'https://api.example.com',
      ingestSecret: 'ingest-secret',
      email: 'jorge@example.com',
      fetchImpl,
      detectPose: async () => ({ personVisible: true, landmarks }),
    });

    assert.equal(result.path, 'gallery:g1');
    assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].source, 'upload');
    assert.equal(posted[0].note, 'Inspiration skeleton');
    assert.equal(posted[0].email, 'jorge@example.com');
  });
});
