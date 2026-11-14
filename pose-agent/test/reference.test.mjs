import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { SAMPLE_SKELETON } from '../skeleton.mjs';
import {
  createLoadedPoseMatcher,
  DEFAULT_REFERENCE_IMAGE,
  DEFAULT_REFERENCE_LANDMARKS,
  landmarksFromSampleSkeleton,
  mimeForImagePath,
  resolveReferenceImagePath,
} from '../reference.mjs';

describe('reference helpers', () => {
  it('defaults to the sample reference image', () => {
    assert.equal(resolveReferenceImagePath({}), DEFAULT_REFERENCE_IMAGE);
    assert.equal(mimeForImagePath(DEFAULT_REFERENCE_IMAGE), 'image/png');
  });

  it('ships a sample reference photo and landmarks', async () => {
    await access(DEFAULT_REFERENCE_IMAGE);
    await access(DEFAULT_REFERENCE_LANDMARKS);
  });

  it('maps the old sample skeleton into matcher landmarks', () => {
    const pose = landmarksFromSampleSkeleton(SAMPLE_SKELETON);
    assert.equal(pose.personVisible, true);
    assert.ok(pose.landmarks.left_elbow);
    assert.equal(pose.landmarks.nose.x, 0.5);
  });

  it('loads the sample landmarks into a matcher without calling vision', async () => {
    const loaded = await createLoadedPoseMatcher({
      extractPose: async () => {
        throw new Error('live extract should not run during load');
      },
    });
    assert.equal(loaded.source, 'landmarks');
    assert.equal(loaded.matcher.hasReference, true);
  });
});
