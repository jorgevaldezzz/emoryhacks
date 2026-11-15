import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { drawPoseSkeleton, saveDebugSkeleton } from '../debug_skeleton.mjs';

describe('drawPoseSkeleton', () => {
  it('draws the live joints onto the caller frame', () => {
    const width = 40;
    const height = 30;
    const pixels = new Uint8Array(width * height * 4);
    pixels.fill(10);
    const drawn = drawPoseSkeleton(pixels, width, height, {
      left_shoulder: { x: 0.25, y: 0.5, confidence: 0.9 },
      left_elbow: { x: 0.75, y: 0.5, confidence: 0.9 },
    });
    assert.equal(drawn, 2);
    const shoulder = (15 * width + 10) * 4;
    assert.equal(pixels[shoulder], 255);
    assert.equal(pixels[shoulder + 1], 176);
    const mid = (15 * width + 20) * 4;
    assert.equal(pixels[mid], 64);
    assert.equal(pixels[mid + 1], 214);
    assert.equal(pixels[mid + 2], 255);
  });

  it('skips a low-confidence joint', () => {
    const pixels = new Uint8Array(10 * 10 * 4);
    pixels.fill(10);
    const drawn = drawPoseSkeleton(pixels, 10, 10, {
      nose: { x: 0.5, y: 0.5, confidence: 0.1 },
    });
    assert.equal(drawn, 0);
    assert.equal(pixels[0], 10);
  });
});

describe('saveDebugSkeleton', () => {
  it('writes a png that is not shown by publishing a track', async () => {
    const width = 40;
    const height = 30;
    const data = new Uint8Array(width * height * 4);
    data.fill(12);
    const frame = new VideoFrame(data, width, height, VideoBufferType.RGBA);
    const dir = await mkdtemp(path.join(tmpdir(), 'debug-skeleton-'));
    try {
      const saved = await saveDebugSkeleton(frame, {
        left_shoulder: { x: 0.2, y: 0.4, confidence: 0.95 },
        left_elbow: { x: 0.7, y: 0.4, confidence: 0.95 },
      }, { dir, at: new Date('2026-11-14T23:00:00.000Z') });
      assert.equal(saved, path.join(dir, '2026-11-14T23-00-00-000Z.png'));
      const bytes = await readFile(saved);
      assert.equal(bytes[0], 0x89);
      const raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
      assert.ok(raw.includes(64), 'expected the skeleton bone color in the saved png');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
