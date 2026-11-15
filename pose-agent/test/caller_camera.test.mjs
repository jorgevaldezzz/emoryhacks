import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { encodeFramePng, saveCapturePng, saveFrameCapture } from '../caller_camera.mjs';
import { drawFace } from '../face.mjs';

describe('encode and save caller frames', () => {
  it('writes a PNG with the frame aspect ratio', async () => {
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
      assert.deepEqual(await readFile(saved), encoded.bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downscales with fit:inside instead of stretching', async () => {
    const data = new Uint8Array(200 * 100 * 4);
    data.fill(180);
    const frame = new VideoFrame(data, 200, 100, VideoBufferType.RGBA);
    const encoded = await encodeFramePng(frame, { maxSide: 100 });
    assert.equal(encoded.width, 100);
    assert.equal(encoded.height, 50);
  });

  it('saves a camera capture without a remote pose service', async () => {
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
      assert.equal((await readFile(result.savedPath))[0], 0x89);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
