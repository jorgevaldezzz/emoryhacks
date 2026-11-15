import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPoseVisibility } from '../src/compare.mjs';

const point = (x, y, confidence = 0.9) => ({ x, y, confidence });
function pose(overrides = {}) {
  return { personVisible: true, landmarks: {
    left_shoulder: point(0.3, 0.3), left_elbow: point(0.25, 0.45), left_wrist: point(0.22, 0.6),
    right_shoulder: point(0.7, 0.3), right_elbow: point(0.75, 0.45), right_wrist: point(0.78, 0.6),
    left_hip: point(0.4, 0.55), left_knee: point(0.4, 0.72), left_ankle: point(0.4, 0.9),
    right_hip: point(0.6, 0.55), right_knee: point(0.6, 0.72), right_ankle: point(0.6, 0.9),
    ...overrides,
  } };
}

describe('checkPoseVisibility', () => {
  it('allows visible reference and caller poses through to Grok', () => {
    assert.deepEqual(checkPoseVisibility(pose(), pose()), {
      ok: true, status: 'pose_visible', coverage: 1, feedback: null,
    });
  });

  it('asks for framing when no person is detected', () => {
    const result = checkPoseVisibility(pose(), { personVisible: false, landmarks: {} });
    assert.equal(result.status, 'person_not_visible');
    assert.match(result.feedback, /step into the camera frame/i);
  });

  it('blocks low-confidence or occluded limbs before comparison', () => {
    const occluded = pose({
      left_elbow: point(0.25, 0.45, 0.1), right_elbow: point(0.75, 0.45, 0.1),
      left_knee: point(0.4, 0.72, 0.1), right_knee: point(0.6, 0.72, 0.1),
    });
    const result = checkPoseVisibility(pose(), occluded);
    assert.equal(result.status, 'insufficient_visibility');
    assert.match(result.feedback, /step into frame/i);
  });

  it('allows a waist-up FaceTime crop when both arms match a full-body reference', () => {
    const waistUp = pose({
      left_ankle: point(0.4, 1.2, 0), right_ankle: point(0.6, 1.2, 0),
      left_knee: point(0.4, 0.95, 0.2), right_knee: point(0.6, 0.95, 0.2),
    });
    const result = checkPoseVisibility(pose(), waistUp);
    assert.equal(result.status, 'pose_visible');
    assert.equal(result.coverage, 0.5);
  });
});
