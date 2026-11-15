import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comparePoses } from '../src/compare.mjs';

const point = (x, y, confidence = 0.9) => ({ x, y, confidence });

function pose(overrides = {}) {
  return {
    personVisible: true,
    landmarks: {
      left_shoulder: point(0.3, 0.3),
      left_elbow: point(0.25, 0.45),
      left_wrist: point(0.22, 0.6),
      right_shoulder: point(0.7, 0.3),
      right_elbow: point(0.75, 0.45),
      right_wrist: point(0.78, 0.6),
      left_hip: point(0.4, 0.55),
      left_knee: point(0.4, 0.72),
      left_ankle: point(0.4, 0.9),
      right_hip: point(0.6, 0.55),
      right_knee: point(0.6, 0.72),
      right_ankle: point(0.6, 0.9),
      ...overrides,
    },
  };
}

describe('comparePoses', () => {
  it('reports a match when angles are close', () => {
    const result = comparePoses(pose(), pose());
    assert.equal(result.status, 'matched');
    assert.match(result.feedback, /close to the reference/i);
  });

  it('gives a directional cue when an arm is too straight', () => {
    const reference = pose({
      // Bent reference arm (~acute/right-ish elbow).
      left_shoulder: point(0.35, 0.30),
      left_elbow: point(0.20, 0.40),
      left_wrist: point(0.35, 0.50),
    });
    const current = pose({
      // Nearly straight arm down from the same shoulder/elbow.
      left_shoulder: point(0.35, 0.30),
      left_elbow: point(0.35, 0.50),
      left_wrist: point(0.35, 0.70),
    });
    const result = comparePoses(reference, current, { threshold: 5 });
    assert.equal(result.status, 'adjust');
    assert.match(result.feedback, /Bend your left elbow more/i);
    assert.doesNotMatch(result.feedback, /differs from the reference/);
    assert.doesNotMatch(result.feedback, /ask me to check/i);
  });
});
