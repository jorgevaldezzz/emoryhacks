import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPoseMatcher } from '../src/session.mjs';

const point = (x, y, confidence = 0.9) => ({ x, y, confidence });
const clearPose = { personVisible: true, landmarks: {
  left_shoulder: point(0.3, 0.3), left_elbow: point(0.25, 0.45), left_wrist: point(0.22, 0.6),
  right_shoulder: point(0.7, 0.3), right_elbow: point(0.75, 0.45), right_wrist: point(0.78, 0.6),
  left_hip: point(0.4, 0.55), left_knee: point(0.4, 0.72), left_ankle: point(0.4, 0.9),
  right_hip: point(0.6, 0.55), right_knee: point(0.6, 0.72), right_ankle: point(0.6, 0.9),
} };

describe('createPoseMatcher', () => {
  it('rejects reference images with no detected person', async () => {
    const matcher = createPoseMatcher({ extractPose: async () => ({ personVisible: false, landmarks: {} }), comparePose: async () => ({ status: 'matched' }) });
    await assert.rejects(matcher.setReference('blank'), /MediaPipe could not detect a clear pose/);
  });

  it('rejects reference poses with too few confident limb joints', async () => {
    const pose = structuredClone(clearPose);
    for (const name of ['left_elbow', 'right_elbow', 'left_knee', 'right_knee']) pose.landmarks[name].confidence = 0.1;
    const matcher = createPoseMatcher({ extractPose: async () => pose, comparePose: async () => ({ status: 'matched' }) });
    await assert.rejects(matcher.setReference('occluded'), /too few reference joints are visible/);
  });

  it('skips Grok when the live person is missing and compares visible pose pairs', async () => {
    let current = { personVisible: false, landmarks: {} };
    let comparisons = 0;
    const matcher = createPoseMatcher({
      extractPose: async image => image === 'reference' ? clearPose : current,
      comparePose: async () => { comparisons += 1; return { ok: true, status: 'adjust', focusJoint: 'left_wrist', feedback: 'Move your left wrist beside your temple.' }; },
    });
    await matcher.setReference('reference');
    const hidden = await matcher.check('current');
    assert.equal(hidden.status, 'person_not_visible');
    assert.equal(comparisons, 0);
    current = clearPose;
    const visible = await matcher.check('current');
    assert.equal(visible.status, 'adjust');
    assert.equal(visible.focusJoint, 'left_wrist');
    assert.equal(comparisons, 1);
  });

  it('lets overlapping checks await the same in-flight comparison instead of check_in_progress', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let comparisons = 0;
    const matcher = createPoseMatcher({
      extractPose: async image => image === 'reference' ? clearPose : clearPose,
      comparePose: async () => {
        comparisons += 1;
        await gate;
        return { ok: true, status: 'adjust', focusJoint: 'right_elbow', feedback: 'Raise your right elbow out to the side.' };
      },
    });
    await matcher.setReference('reference');
    const first = matcher.check('live-a');
    const second = matcher.check('live-b');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(comparisons, 1);
    assert.equal(a.status, 'adjust');
    assert.equal(b.status, 'adjust');
    assert.equal(a.focusJoint, 'right_elbow');
    assert.equal(b.focusJoint, 'right_elbow');
    assert.notEqual(a.status, 'check_in_progress');
  });
});
