import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import {
  buildVisionPrompt,
  cueFromVisionText,
  encodeFramePng,
  resultFromVisionText,
  saveCapturePng,
  saveFrameCapture,
  takePhotoFromFrame,
} from '../caller_vision.mjs';
import { drawFace } from '../face.mjs';

describe('resultFromVisionText', () => {
  it('reads seen, ready, and cue from JSON', () => {
    assert.deepEqual(
      resultFromVisionText('{"seen": true, "ready": false, "cue": "  Raise your left arm.  "}'),
      { seen: true, ready: false, cue: 'Raise your left arm.' },
    );
  });

  it('marks ready when the pose matches', () => {
    assert.deepEqual(
      resultFromVisionText('{"seen": true, "ready": true, "cue": "You look lined up and ready."}'),
      { seen: true, ready: true, cue: 'You look lined up and ready.' },
    );
  });

  it('treats a cue without seen as visible and not ready', () => {
    assert.deepEqual(
      resultFromVisionText('Here you go: {"cue": "Raise your chin."}'),
      { seen: true, ready: false, cue: 'Raise your chin.' },
    );
  });

  it('returns null cue when the person is not seen', () => {
    assert.deepEqual(
      resultFromVisionText('{"seen": false, "ready": true, "cue": null}'),
      { seen: false, ready: false, cue: null },
    );
  });
});

describe('cueFromVisionText', () => {
  it('keeps the old helper working', () => {
    assert.equal(cueFromVisionText('{"cue": "Square your shoulders."}'), 'Square your shoulders.');
    assert.equal(cueFromVisionText('not json'), null);
  });
});

describe('drawFace shutter', () => {
  it('changes pixels when snapping', () => {
    const idle = drawFace(0, false, false, 0);
    const snap = drawFace(0, false, true, 0);
    assert.notDeepEqual(idle, snap);
  });

  it('draws the AI face circle, not a blank stage', () => {
    const idle = drawFace(10, false, false, 0);
    // Center of the face circle should be the mint FACE color, not the dark background.
    const cx = 320;
    const cy = 170;
    const i = (cy * 640 + cx) * 4;
    assert.equal(idle[i], 141);
    assert.equal(idle[i + 1], 224);
    assert.equal(idle[i + 2], 196);
  });
});

describe('buildVisionPrompt', () => {
  it('coaches toward the attached reference pose', () => {
    const prompt = buildVisionPrompt({ hasReference: true });
    assert.match(prompt, /TARGET reference pose/);
    assert.match(prompt, /arms-out scaffold/i);
    assert.match(prompt, /"ready"/);
    assert.match(prompt, /Hold still/);
    assert.match(prompt, /Never mention photos/);
    assert.match(prompt, /Do not tell them to say cheese/);
    assert.doesNotMatch(prompt, /say cheese when you want/i);
    assert.doesNotMatch(prompt, /Standing portrait facing the camera/);
  });

  it('does not fall back to the arms-out scaffold without a reference', () => {
    const prompt = buildVisionPrompt({ hasReference: false });
    assert.match(prompt, /reference pose still needs to be set|target pose loaded/i);
    assert.doesNotMatch(prompt, /arms slightly out/);
    assert.doesNotMatch(prompt, /Standing portrait/);
  });
});

describe('encode and save capture', () => {
  it('writes a PNG that keeps the frame aspect ratio', async () => {
    const frame = new VideoFrame(drawFace(3, false, false, 0), 640, 360, VideoBufferType.RGBA);
    const encoded = await encodeFramePng(frame);
    assert.ok(encoded?.bytes?.length > 100);
    assert.equal(encoded.bytes[0], 0x89);
    assert.equal(encoded.bytes[1], 0x50);
    assert.equal(encoded.width, 640);
    assert.equal(encoded.height, 360);

    const dir = await mkdtemp(path.join(tmpdir(), 'pose-capture-'));
    try {
      const at = new Date('2026-11-14T21:46:00.123Z');
      const saved = await saveCapturePng(encoded.bytes, { dir, at });
      assert.equal(saved, path.join(dir, '2026-11-14T21-46-00-123Z.png'));
      const second = await saveCapturePng(encoded.bytes, { dir, at: new Date('2026-11-14T21:46:01.000Z') });
      assert.equal(second, path.join(dir, '2026-11-14T21-46-01-000Z.png'));
      const roundTrip = await readFile(saved);
      assert.deepEqual(roundTrip, encoded.bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downscales with fit:inside instead of squashing to a square', async () => {
    const data = new Uint8Array(200 * 100 * 4);
    data.fill(180);
    const frame = new VideoFrame(data, 200, 100, VideoBufferType.RGBA);
    const encoded = await encodeFramePng(frame, { maxSide: 100 });
    assert.equal(encoded.width, 100);
    assert.equal(encoded.height, 50);
  });

  it('saves a cheese snap without waiting on vision', async () => {
    const frame = new VideoFrame(drawFace(4, false, false, 0), 640, 360, VideoBufferType.RGBA);
    const dir = await mkdtemp(path.join(tmpdir(), 'pose-snap-'));
    try {
      const result = await saveFrameCapture(frame, {
        captureDir: dir,
        at: new Date('2026-11-14T22:30:00.000Z'),
      });
      assert.equal(result.ok, true);
      assert.equal(result.savedPath, path.join(dir, '2026-11-14T22-30-00-000Z.png'));
      assert.equal(result.width, 640);
      assert.equal(result.height, 360);
      const bytes = await readFile(result.savedPath);
      assert.equal(bytes[0], 0x89);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('takePhotoFromFrame', () => {
  it('returns a spoken message when vision sees the caller', async () => {
    const frame = new VideoFrame(drawFace(1, false, false, 0), 640, 360, VideoBufferType.RGBA);
    const dir = await mkdtemp(path.join(tmpdir(), 'pose-photo-'));
    try {
      const result = await takePhotoFromFrame(frame, {
        apiKey: 'test-key',
        captureDir: dir,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            output_text: '{"seen": true, "cue": "You just turned away from the camera."}',
          }),
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.seen, true);
      assert.equal(result.ready, false);
      assert.equal(result.cue, 'You just turned away from the camera.');
      assert.equal(result.message, 'You just turned away from the camera.');
      assert.match(result.savedPath ?? '', /\d{4}-\d{2}-\d{2}T.+\.png$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends the reference image before the caller frame', async () => {
    const frame = new VideoFrame(drawFace(5, false, false, 0), 640, 360, VideoBufferType.RGBA);
    /** @type {unknown} */
    let body;
    const result = await takePhotoFromFrame(frame, {
      apiKey: 'test-key',
      save: false,
      referenceImage: 'data:image/jpeg;base64,AAA',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body ?? '{}'));
        return {
          ok: true,
          json: async () => ({
            output_text: '{"seen": true, "ready": false, "cue": "Raise your left elbow higher."}',
          }),
        };
      },
    });
    assert.equal(result.cue, 'Raise your left elbow higher.');
    const content = body?.input?.[0]?.content ?? [];
    assert.equal(content[0]?.type, 'input_image');
    assert.equal(content[0]?.image_url, 'data:image/jpeg;base64,AAA');
    assert.equal(content[1]?.type, 'input_image');
    assert.match(content[1]?.image_url ?? '', /^data:image\/png;base64,/);
    assert.match(content[2]?.text ?? '', /TARGET reference pose/);
  });

  it('does not save when nobody is in frame', async () => {
    const frame = new VideoFrame(drawFace(2, true, false, 0), 640, 360, VideoBufferType.RGBA);
    const dir = await mkdtemp(path.join(tmpdir(), 'pose-empty-'));
    try {
      const result = await takePhotoFromFrame(frame, {
        apiKey: 'test-key',
        captureDir: dir,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            output: [{ content: [{ text: '{"seen": false, "cue": null}' }] }],
          }),
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.seen, false);
      assert.equal(result.ready, false);
      assert.equal(result.cue, null);
      assert.equal(result.savedPath, undefined);
      assert.match(result.message, /no person/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
