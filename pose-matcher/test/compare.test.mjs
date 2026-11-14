import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comparePoses, tipForDelta } from '../src/compare.mjs';
import { normalizePoseResult } from '../src/extract.mjs';
import { createPoseMatcher } from '../src/session.mjs';

const standing = normalizePoseResult({
  person_visible: true,
  landmarks: {
    nose: { x: 0.5, y: 0.16, confidence: 0.9 },
    left_shoulder: { x: 0.38, y: 0.3, confidence: 0.9 },
    right_shoulder: { x: 0.62, y: 0.3, confidence: 0.9 },
    left_elbow: { x: 0.28, y: 0.44, confidence: 0.9 },
    right_elbow: { x: 0.72, y: 0.44, confidence: 0.9 },
    left_wrist: { x: 0.24, y: 0.58, confidence: 0.9 },
    right_wrist: { x: 0.76, y: 0.58, confidence: 0.9 },
    left_hip: { x: 0.44, y: 0.52, confidence: 0.9 },
    right_hip: { x: 0.56, y: 0.52, confidence: 0.9 },
    left_knee: { x: 0.43, y: 0.7, confidence: 0.9 },
    right_knee: { x: 0.57, y: 0.7, confidence: 0.9 },
    left_ankle: { x: 0.42, y: 0.88, confidence: 0.9 },
    right_ankle: { x: 0.58, y: 0.88, confidence: 0.9 },
  },
});

describe('tipForDelta', () => {
  it('asks to bend when the live limb is straighter', () => {
    assert.equal(tipForDelta('left arm', 20), 'bend your left arm a little');
  });

  it('asks to straighten when the live limb is more bent', () => {
    assert.equal(tipForDelta('right leg', -20), 'straighten your right leg a little');
  });
});

describe('comparePoses', () => {
  it('marks a matching pose as ready', () => {
    const result = comparePoses(standing, standing);
    assert.equal(result.status, 'matched');
    assert.equal(result.ready, true);
    assert.match(result.feedback, /ready/i);
  });

  it('returns a body tip when an arm differs', () => {
    const bent = structuredClone(standing);
    bent.landmarks.left_wrist = { x: 0.2, y: 0.4, confidence: 0.9 };
    const result = comparePoses(standing, bent, { threshold: 10 });
    assert.equal(result.status, 'adjust');
    assert.equal(result.ready, false);
    assert.match(result.feedback, /arm/i);
  });
});

describe('createPoseMatcher', () => {
  it('loads a reference pose without an image extract', () => {
    const matcher = createPoseMatcher({
      extractPose: async () => {
        throw new Error('should not extract during setReferencePose');
      },
    });
    matcher.setReferencePose(standing);
    assert.equal(matcher.hasReference, true);
  });

  it('compares a live extract against the reference', async () => {
    const matcher = createPoseMatcher({
      extractPose: async () => standing,
    });
    await matcher.setReference('data:image/png;base64,AAA');
    const result = await matcher.check('data:image/png;base64,BBB');
    assert.equal(result.status, 'matched');
    assert.equal(result.ready, true);
  });
});
