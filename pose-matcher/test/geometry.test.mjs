import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTO_SNAP_ACCURACY_PERCENT, comparePoseGeometry, cueForDelta, MATCH_TOLERANCE } from '../src/geometry.mjs';

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
    // One joint a full shoulder-width off, diluted across the other 12 — not 100%,
    // since that would contradict being told to fix something.
    assert.match(result.feedback, /\d+% accuracy/);
    assert.ok(result.accuracyPercent < 100, 'adjust must never report 100% accuracy');
  });

  it('moves an arm that needs to reach farther out or pull in, not just up/down', () => {
    const reference = pose();
    const current = pose();
    // Reference wrist reaches out diagonally from the shoulder; live wrist sits on
    // the same diagonal but tucked in close — dx and dy are equal, so the plain
    // up/down-vs-left/right pick is a coin flip; reach is the real, unambiguous gap.
    reference.landmarks.right_wrist = point(0.9, 0.58);
    current.landmarks.right_wrist = point(0.72, 0.4);
    const result = comparePoseGeometry({ reference, current });
    assert.equal(result.focusJoint, 'right_wrist');
    assert.match(result.feedback, /farther away from your body/i);
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

  it('snaps without asking once accuracy reaches the auto-snap threshold, even off a perfect match', () => {
    assert.equal(AUTO_SNAP_ACCURACY_PERCENT, 55);
    const reference = pose();
    const current = pose();
    // Nudge every joint but the shoulders (which set origin/scale) by the same
    // small amount — not a perfect match, but well above the 55% bar.
    for (const [key, landmark] of Object.entries(current.landmarks)) {
      if (key === 'left_shoulder' || key === 'right_shoulder') continue;
      landmark.x += 0.05;
    }
    const result = comparePoseGeometry({ reference, current });
    assert.equal(result.status, 'matched');
    assert.ok(result.accuracyPercent >= AUTO_SNAP_ACCURACY_PERCENT);
    assert.equal(result.focusJoint, null);
    assert.match(result.feedback, /good enough/i);
    assert.doesNotMatch(result.feedback, /want me to|\?/); // no question asked — just snaps
  });

  it('keeps coaching instead of snapping while accuracy is still below the auto-snap threshold', () => {
    const reference = pose();
    const current = pose();
    // Same shape of nudge as above, just larger — now below the 55% bar.
    for (const [key, landmark] of Object.entries(current.landmarks)) {
      if (key === 'left_shoulder' || key === 'right_shoulder') continue;
      landmark.x += 0.12;
    }
    const result = comparePoseGeometry({ reference, current });
    assert.equal(result.status, 'adjust');
    assert.ok(result.accuracyPercent < AUTO_SNAP_ACCURACY_PERCENT);
  });
});

describe('comparePoseGeometry across differing aspect ratios', () => {
  // A portrait reference photo vs. a landscape-cropped live FaceTime frame used to
  // get compared as if x/y fractions were directly interchangeable, which inflated
  // leg/arm error by roughly the ratio of the two aspect ratios — chert kept coaching
  // leg corrections that didn't exist. Re-express the identical real pixel stance on
  // a wider canvas: y fractions (same imageHeight) stay put, x fractions halve
  // (double the imageWidth) — the same absolute pose, just a different aspect ratio.
  const reshapeToWiderCanvas = sourcePose => {
    const reshaped = structuredClone(sourcePose);
    for (const landmark of Object.values(reshaped.landmarks)) landmark.x /= 2;
    return reshaped;
  };

  it('recognizes the same stance as matched once imageWidth/imageHeight correct for aspect ratio', () => {
    const reference = { ...pose(), imageWidth: 1000, imageHeight: 1000 };
    const current = { ...reshapeToWiderCanvas(pose()), imageWidth: 2000, imageHeight: 1000 };
    const result = comparePoseGeometry({ reference, current });
    assert.equal(result.status, 'matched');
  });

  it('documents the bug this guards: without imageWidth/imageHeight the identical stance looks mismatched', () => {
    const reference = pose();
    const current = reshapeToWiderCanvas(pose());
    const result = comparePoseGeometry({ reference, current });
    assert.notEqual(result.status, 'matched');
  });
});
