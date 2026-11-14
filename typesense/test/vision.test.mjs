import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/client.mjs';
import { compareBackgrounds, toImageUrl, VisionError } from '../src/vision.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const env = { OPENAI_API_KEY: 'test-key' };

/** A stand-in for the model endpoint that records requests and replays answers. */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const reply = typeof answer === 'function' ? answer(calls.length) : answer;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  impl.calls = calls;
  return impl;
}

const ok = content => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }),
});

const SEEN = {
  reference: { scene: 'mountain', tags: ['ridge', 'pines'], background: 'a granite ridge at sunset' },
  current: { scene: 'interior', tags: ['white wall'], background: 'a bedroom wall' },
  similarity: 0.05,
  difference: 'You are indoors against a white wall; the reference is a ridge at sunset.',
};

test('bytes become a data URL with the right type', () => {
  assert.match(toImageUrl(JPEG), /^data:image\/jpeg;base64,/);
  assert.match(toImageUrl(PNG), /^data:image\/png;base64,/);
  assert.match(toImageUrl(new Uint8Array(PNG).buffer), /^data:image\/png;base64,/);
  assert.match(toImageUrl({ data: JPEG.toString('base64') }), /^data:image\/jpeg;base64,/);
});

test('URLs and data URLs pass straight through', () => {
  assert.equal(toImageUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  const inline = 'data:image/png;base64,AAAA';
  assert.equal(toImageUrl(inline), inline);
});

test('anything that is not an image is refused before a request is spent', async () => {
  assert.throws(() => toImageUrl(Buffer.from('not an image at all')), /Not a JPEG/);
  assert.throws(() => toImageUrl(''), VisionError);
  assert.throws(() => toImageUrl('/home/me/photo.jpg'), /data: URL or an http/);
  assert.throws(() => toImageUrl(Buffer.alloc(0)), /empty/);
  assert.throws(() => toImageUrl(Buffer.concat([JPEG, Buffer.alloc(9e6)])), /under 8 MB/);

  const fetchImpl = fakeFetch(ok(SEEN));
  await assert.rejects(() => compareBackgrounds({ reference: 'nope', env, fetchImpl }), VisionError);
  assert.equal(fetchImpl.calls.length, 0, 'a bad image never reaches the model');
});

test('both backgrounds go up in one request', async () => {
  const fetchImpl = fakeFetch(ok(SEEN));
  const result = await compareBackgrounds({ reference: JPEG, current: PNG, env, fetchImpl });

  assert.equal(fetchImpl.calls.length, 1, 'one call, not one per image');
  const { body, url } = fetchImpl.calls[0];
  assert.match(url, /\/chat\/completions$/);
  assert.equal(body.response_format.type, 'json_object');
  const images = body.messages[1].content.filter(part => part.type === 'image_url');
  assert.equal(images.length, 2);
  assert.match(body.messages[0].content, /^- mountain: /m, 'the prompt carries the scene vocabulary');

  assert.equal(result.reference.scene, 'mountain');
  assert.equal(result.current.scene, 'interior');
  assert.equal(result.similarity, 0.05);
  assert.match(result.difference, /white wall/);
});

test('one image means no comparison is invented', async () => {
  const fetchImpl = fakeFetch(ok({ reference: SEEN.reference, similarity: 0.9 }));
  const result = await compareBackgrounds({ reference: JPEG, env, fetchImpl });

  assert.equal(fetchImpl.calls[0].body.messages[1].content.filter(p => p.type === 'image_url').length, 1);
  assert.equal(result.current, undefined);
  assert.equal(result.similarity, undefined, 'a similarity with nothing to compare to is dropped');
});

test('a scene the vocabulary does not have becomes unknown', async () => {
  const fetchImpl = fakeFetch(ok({ reference: { scene: 'the moon' }, current: { scene: 'mountain' }, similarity: 'very' }));
  const result = await compareBackgrounds({ reference: JPEG, current: PNG, env, fetchImpl });
  assert.equal(result.reference.scene, 'unknown');
  // No usable number, and the two scenes differ: do not read that as a match.
  assert.equal(result.similarity, 0.2);
});

test('a missing similarity falls back to the two scene keys', async () => {
  const fetchImpl = fakeFetch(ok({ reference: { scene: 'beach' }, current: { scene: 'beach' } }));
  const { similarity } = await compareBackgrounds({ reference: JPEG, current: PNG, env, fetchImpl });
  assert.equal(similarity, 0.8);
});

test('similarity is clamped to 0..1', async () => {
  const fetchImpl = fakeFetch(ok({ ...SEEN, similarity: 42 }));
  const { similarity } = await compareBackgrounds({ reference: JPEG, current: PNG, env, fetchImpl });
  assert.equal(similarity, 1);
});

test('failures carry a code the caller can branch on', async () => {
  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env: {}, fetchImpl: fakeFetch(ok(SEEN)) }),
    ConfigError,
    'no key is a configuration problem, not a model problem',
  );

  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env, fetchImpl: fakeFetch({ ok: false, status: 401, text: async () => 'bad key' }) }),
    ConfigError,
  );

  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env, fetchImpl: fakeFetch({ ok: false, status: 503, text: async () => 'busy' }) }),
    error => (assert.equal(error.code, 'unavailable'), true),
  );

  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env, fetchImpl: fakeFetch(ok('not json at all')) }),
    error => (assert.equal(error.code, 'unreadable'), true),
  );

  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env, fetchImpl: fakeFetch(ok({ similarity: 1 })) }),
    error => (assert.equal(error.code, 'unreadable'), true),
  );

  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env, fetchImpl: fakeFetch(new Error('fetch failed')) }),
    error => (assert.equal(error.code, 'unavailable'), true),
  );
});

test('a caller abort stops the request', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => {
    controller.abort();
    assert.equal(init.signal.aborted, true);
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(
    () => compareBackgrounds({ reference: JPEG, env, fetchImpl, signal: controller.signal }),
    error => (assert.equal(error.code, 'unavailable'), true),
  );
});
