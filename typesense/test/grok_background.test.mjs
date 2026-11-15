import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrokBackgroundClassifier, GROK_BACKGROUND_ENDPOINT } from '../src/grok_background.mjs';
import { matchReferencePhoto } from '../src/match.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('Grok classifies only the reference image with a non-stored structured request', async () => {
  let request;
  const classify = createGrokBackgroundClassifier({
    apiKey: 'test-xai-key',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return Response.json({
        output_text: JSON.stringify({
          scene: 'forest',
          tags: ['trees', 'green trail'],
          background: 'trees and a grassy trail',
        }),
      });
    },
  });

  const result = await classify({ reference: png });
  assert.equal(request.url, GROK_BACKGROUND_ENDPOINT);
  assert.equal(request.body.store, false);
  assert.equal(request.body.model, 'grok-4.7');
  assert.equal(request.body.input[0].content.filter(item => item.type === 'input_image').length, 1);
  assert.match(request.body.input[0].content.find(item => item.type === 'input_image').image_url, /^data:image\/png;base64,/);
  assert.deepEqual(result.reference, {
    scene: 'forest',
    tags: ['trees', 'green trail'],
    background: 'trees and a grassy trail',
  });
});

test('unclear scenes and unsupported image types do not generate a search profile', async () => {
  const classifyUnknown = createGrokBackgroundClassifier({
    apiKey: 'test-xai-key',
    fetchImpl: async () => Response.json({
      output_text: JSON.stringify({ scene: 'unknown', tags: [], background: '' }),
    }),
  });
  await assert.rejects(classifyUnknown({ reference: png }), /could not identify a clear reference background/i);

  const classifyImage = createGrokBackgroundClassifier({ apiKey: 'test-xai-key' });
  await assert.rejects(classifyImage({ reference: Buffer.from('not an image') }), /not a JPEG, PNG/i);
});

test('missing Grok credentials fail without making a request', async () => {
  const classify = createGrokBackgroundClassifier({ apiKey: '' });
  await assert.rejects(classify({ reference: png }), /XAI_API_KEY is not configured/);
});

test('the Grok scene profile drives the nearby Typesense category and query', async () => {
  const calls = [];
  const client = {
    collections: () => ({
      documents: () => ({
        search: async params => {
          calls.push(params);
          return {
            hits: [{
              document: {
                id: 'curated-park',
                name: 'Piedmont Park',
                description: 'Open grass and trees',
                category: 'park',
                location: [33.786, -84.373],
                source: 'curated',
                quality: 88,
              },
            }],
            found: 1,
          };
        },
      }),
    }),
  };
  const classify = createGrokBackgroundClassifier({
    apiKey: 'test-xai-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, GROK_BACKGROUND_ENDPOINT);
      return Response.json({
        output_text: JSON.stringify({
          scene: 'forest',
          tags: ['trees', 'grassy trail'],
          background: 'trees and a grassy trail',
        }),
      });
    },
  });

  const result = await matchReferencePhoto({
    reference: png,
    lat: 33.7556,
    lng: -84.3715,
    compare: classify,
    client,
  });

  assert.equal(result.reason, 'found');
  assert.equal(result.reference_scene, 'forest');
  assert.equal(result.spots[0].name, 'Piedmont Park');
  assert.match(calls[0].filter_by, /location:\(33\.7556, -84\.3715, 3 km\)/);
  assert.match(calls[0].filter_by, /category:\[`park`, `garden`, `viewpoint`\]/);
  assert.match(calls[0].q, /grassy trail/);
});
