import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { frameToAgentRgba, scaleRgba } from '../frame_display.mjs';

describe('scaleRgba', () => {
  it('scales a tiny buffer up', () => {
    const src = Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const out = scaleRgba(src, 2, 2, 4, 4);
    assert.equal(out.length, 4 * 4 * 4);
    assert.equal(out[0], 10);
    assert.equal(out[1], 20);
    assert.equal(out[2], 30);
  });
});

describe('frameToAgentRgba', () => {
  it('keeps matching RGBA frames', () => {
    const data = new Uint8Array(8 * 8 * 4);
    data.fill(128);
    const frame = new VideoFrame(data, 8, 8, VideoBufferType.RGBA);
    const out = frameToAgentRgba(frame, 8, 8);
    assert.deepEqual(out, data);
  });

  it('resizes RGBA frames to the agent size', () => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
    }
    const frame = new VideoFrame(data, 4, 4, VideoBufferType.RGBA);
    const out = frameToAgentRgba(frame, 16, 9);
    assert.equal(out.length, 16 * 9 * 4);
    assert.equal(out[0], 255);
    assert.equal(out[1], 0);
  });
});
