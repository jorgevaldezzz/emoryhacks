import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comparePoseGeometry, cueForDelta, MATCH_TOLERANCE } from '../src/geometry.mjs';

const point = (x, y, confidence = 0.95) => ({ x, y, confidence });
function pose(shiftWrist = 0) {
  return {
    personVisible: true,
    landmarks: {
      nose: point(0.5, 0.12),
      left_shoulder: point(0.4, 0.28), right_shoulder: point(0.6, 0.28),
      left_elbow: point(0.32, 0.42), right_elbow: point(0.68, 0.42),
      left_wrist: point(0.28, 0.55), right_wrist: point(0.72, 0.55 - shiftWrist),
      left_hip: point(0.43, 0.55), right_hip: point(0.57, 0.55),
      left_knee: point(0.42, 0.72), right_knee: point(0.58, 0.72),
      left_ankle: point(0.41, 0.92), right_ankle: point(0.59, 0.92),
    },
  };
}

describe('comparePoseGeometry', () => {
  it('uses a strict whole-pose threshold without ignoring an outlying joint', () => {
    assert.equal(MATCH_TOLERANCE, 0.16);
    const reference = pose();
    const current = pose();
    current.landmarks.right_ankle = point(0.8, 0.55);
    assert.equal(comparePoseGeometry({ reference, current }).status, 'adjust');
  });

  it('never tells a caller to lift a foot to fix image-space leg error', () => {
    const reference = pose();
    const current = pose();
    current.landmarks.left_ankle = point(0.35, 0.6);
    const result = comparePoseGeometry({ reference, current });
    assert.doesNotMatch(result.feedback, /lift|ceiling|sky/i);
    assert.match(cueForDelta('left_ankle', 0, 0.3, {
      left_hip: { x: 0, y: 0 }, left_knee: { x: 0, y: 0.5 }, left_ankle: { x: 0, y: 1 },
    }, {
      left_hip: { x: 0, y: 0 }, left_knee: { x: 0, y: 0.5 }, left_ankle: { x: 0, y: 1 },
    }), /foot on the floor/i);
  });
  it('returns matched when live joints already align with the reference', () => {
    const result = comparePoseGeometry({ reference: pose(), current: pose() });
    assert.equal(result.status, 'matched');
    assert.equal(result.focusJoint, null);
  });

  it('names the worst joint and says lift upward, not closer to the camera', () => {
    // Stance already matches; live right wrist is much lower than the reference.
    const result = comparePoseGeometry({ reference: pose(0.2), current: pose(0) });
    assert.equal(result.status, 'adjust');
    assert.equal(result.focusJoint, 'right_wrist');
    assert.match(result.feedback, /right wrist/i);
    assert.match(result.feedback, /lift|upward|ceiling/i);
    assert.match(result.feedback, /not closer to the camera/i);
    assert.doesNotMatch(result.feedback, /^Raise your .+ higher\.$/);
  });

  it('prefers a stance gap over an arm gap until the lower body is close', () => {
    const reference = pose(0.25);
    const current = pose(0);
    current.landmarks.left_ankle = point(0.2, 0.99);
    current.landmarks.right_ankle = point(0.8, 0.99);
    const result = comparePoseGeometry({ reference, current });
    assert.equal(result.status, 'adjust');
    assert.match(result.focusJoint ?? '', /ankle|hip|knee/);
  });

  it('moves on to arms once the lower body is close enough', () => {
    const reference = pose(0.2);
    const current = pose(0);
    // Feet nearly match; wrist still wrong — after stance phase, coach the arm.
    const result = comparePoseGeometry({ reference, current });
    assert.equal(result.status, 'adjust');
    assert.equal(result.focusJoint, 'right_wrist');
  });

  it('skips already-coached joints so the next tip can advance', () => {
    const reference = pose(0.2);
    const current = pose(0);
    current.landmarks.left_elbow = point(0.15, 0.5);
    const result = comparePoseGeometry({
      reference,
      current,
      excludeJoints: ['right_wrist'],
    });
    assert.equal(result.status, 'adjust');
    assert.notEqual(result.focusJoint, 'right_wrist');
    assert.equal(result.focusJoint, 'left_elbow');
  });
});
