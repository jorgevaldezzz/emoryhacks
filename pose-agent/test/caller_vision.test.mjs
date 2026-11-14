import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import {
  cueFromVisionText,
  encodeFramePng,
  resultFromVisionText,
  saveCapturePng,
  takePhotoFromFrame,
} from '../caller_vision.mjs';
import { drawFace } from '../face.mjs';

describe('resultFromVisionText', () => {
  it('reads seen and cue from JSON', () => {
    assert.deepEqual(
      resultFromVisionText('{"seen": true, "cue": "  You are smiling at the camera.  "}'),
      { seen: true, cue: 'You are smiling at the camera.' },
    );
  });

  it('treats a cue without seen as visible', () => {
    assert.deepEqual(
      resultFromVisionText('Here you go: {"cue": "Raise your chin."}'),
      { seen: true, cue: 'Raise your chin.' },
    );
  });

  it('returns null cue when the person is not seen', () => {
    assert.deepEqual(
      resultFromVisionText('{"seen": false, "cue": null}'),
      { seen: false, cue: null },
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
});

describe('encode and save capture', () => {
  it('writes a PNG the vision path can reuse', async () => {
    const frame = new VideoFrame(drawFace(3, false, false, 0), 640, 360, VideoBufferType.RGBA);
    const encoded = await encodeFramePng(frame);
    assert.ok(encoded?.bytes?.length > 100);
    assert.equal(encoded.bytes[0], 0x89);
    assert.equal(encoded.bytes[1], 0x50);

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
      assert.equal(result.cue, 'You just turned away from the camera.');
      assert.equal(result.message, 'You just turned away from the camera.');
      assert.match(result.savedPath ?? '', /\d{4}-\d{2}-\d{2}T.+\.png$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      assert.equal(result.cue, null);
      assert.equal(result.savedPath, undefined);
      assert.match(result.message, /no person/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
