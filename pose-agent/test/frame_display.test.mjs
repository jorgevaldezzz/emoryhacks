import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { containRgba, cropFacetimeFrame, cropFacetimeRgba, frameToAgentRgba, scaleRgba } from '../frame_display.mjs';
import { drawFace } from '../face.mjs';

describe('scaleRgba', () => {
  it('scales a tiny buffer up', () => {
    const src = Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const out = scaleRgba(src, 2, 2, 4, 4);
    assert.equal(out.length, 4 * 4 * 4);
    assert.equal(out[0], 10);
  });
});

describe('containRgba', () => {
  it('letterboxes a wide frame without stretching into a square canvas', () => {
    // 4x2 bright frame into 4x4 canvas → 4x2 centered with bars above/below.
    const src = new Uint8Array(4 * 2 * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 200; src[i + 1] = 40; src[i + 2] = 40; src[i + 3] = 255;
    }
    const out = containRgba(src, 4, 2, 4, 4, [0, 0, 0]);
    assert.equal(out.length, 4 * 4 * 4);
    // Top bar should be fill black.
    assert.equal(out[0], 0);
    assert.equal(out[1], 0);
    assert.equal(out[2], 0);
    // Middle row (y=1) should keep the red content.
    const mid = (1 * 4 + 0) * 4;
    assert.equal(out[mid], 200);
    assert.equal(out[mid + 1], 40);
  });
});

describe('cropFacetimeRgba', () => {
  it('removes bottom chrome and keeps the center', () => {
    const width = 100;
    const height = 100;
    const src = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        src[i] = x; src[i + 1] = y; src[i + 2] = 0; src[i + 3] = 255;
      }
    }
    const cropped = cropFacetimeRgba(src, width, height, { left: 0.1, right: 0.1, top: 0.1, bottom: 0.2 });
    assert.equal(cropped.width, 80);
    assert.equal(cropped.height, 70);
    // Top-left of crop should be near (10,10) of the source.
    assert.equal(cropped.data[0], 10);
    assert.equal(cropped.data[1], 10);
  });
});

describe('frameToAgentRgba', () => {
  it('crops then letterboxes to the agent size without square stretch', () => {
    const data = new Uint8Array(80 * 80 * 4);
    data.fill(128);
    const frame = new VideoFrame(data, 80, 80, VideoBufferType.RGBA);
    const out = frameToAgentRgba(frame, 16, 9, { margins: { left: 0, right: 0, top: 0, bottom: 0 } });
    assert.equal(out.length, 16 * 9 * 4);
  });
});

describe('cropFacetimeFrame', () => {
  it('returns an RGBA VideoFrame', () => {
    const data = new Uint8Array(40 * 40 * 4);
    data.fill(90);
    const frame = new VideoFrame(data, 40, 40, VideoBufferType.RGBA);
    const cropped = cropFacetimeFrame(frame, { margins: { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 } });
    assert.equal(cropped.type, VideoBufferType.RGBA);
    assert.equal(cropped.width, 32);
    assert.equal(cropped.height, 32);
  });
});

describe('agent face', () => {
  it('keeps the AI face by default and overlays countdown digits', () => {
    const idle = drawFace(0, false, false, 0);
    const three = drawFace(0, false, false, 3);
    assert.notDeepEqual(idle, three);
    // Idle face should not look like a skeleton-only stage (mint face at center).
    const i = (170 * 640 + 320) * 4;
    assert.equal(idle[i], 141);
  });
});
