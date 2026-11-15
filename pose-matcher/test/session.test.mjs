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
    const matcher = createPoseMatcher({ extractPose: async () => ({ personVisible: false, landmarks: {} }) });
    await assert.rejects(matcher.setReference('blank'), /MediaPipe could not detect a clear pose/);
  });

  it('rejects reference poses with too few confident limb joints', async () => {
    const pose = structuredClone(clearPose);
    for (const name of ['left_elbow', 'right_elbow', 'left_knee', 'right_knee']) pose.landmarks[name].confidence = 0.1;
    const matcher = createPoseMatcher({ extractPose: async () => pose });
    await assert.rejects(matcher.setReference('occluded'), /too few reference joints are visible/);
  });
});
