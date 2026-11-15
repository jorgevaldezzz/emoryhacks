import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, renderPoseOverlay } from '../pose_overlays.mjs';

const point = (x, y) => ({ x, y, confidence: 0.95 });
const pose = {
  personVisible: true,
  landmarks: {
    nose: point(0.5, 0.1), left_shoulder: point(0.4, 0.25), right_shoulder: point(0.6, 0.25),
    left_elbow: point(0.3, 0.4), right_elbow: point(0.7, 0.4),
    left_wrist: point(0.2, 0.5), right_wrist: point(0.8, 0.5),
    left_hip: point(0.43, 0.55), right_hip: point(0.57, 0.55),
    left_knee: point(0.4, 0.75), right_knee: point(0.6, 0.75),
    left_ankle: point(0.38, 0.95), right_ankle: point(0.62, 0.95),
  },
};

describe('pose overlays', () => {
  it('keeps stick-figure canvases small so Grok vision stays fast', async () => {
    assert.ok(OVERLAY_WIDTH <= 480);
    assert.ok(OVERLAY_HEIGHT <= 360);
    const dataUrl = await renderPoseOverlay(pose);
    assert.match(dataUrl, /^data:image\/png;base64,/);
    // Half of the old 900×640 PNGs — payloads stay well under ~80 KiB of base64.
    assert.ok(dataUrl.length < 80_000, `overlay payload too large: ${dataUrl.length}`);
  });
});
