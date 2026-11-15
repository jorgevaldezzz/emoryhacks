const CHAINS = [
  ['left_shoulder', 'left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee', 'left_ankle'],
  ['right_hip', 'right_knee', 'right_ankle'],
];
// FaceTime crops often cut ankles; MediaPipe extremity presence is also noisy around 0.3.
const MIN_JOINT_CONFIDENCE = 0.25;
const usable = (pose, key) => pose?.landmarks?.[key]?.confidence >= MIN_JOINT_CONFIDENCE ? pose.landmarks[key] : null;
const chainVisible = (pose, chain) => chain.every(key => usable(pose, key));

/**
 * Reject empty or low-confidence poses locally before sending skeletons for coaching.
 * Coverage is relative to limb chains that are complete on the reference, so a
 * waist-up FaceTime crop can still coach against a full-body reference when the
 * overlapping arms (or other shared limbs) are visible.
 */
export function checkPoseVisibility(reference, current, { minCoverage = 0.5 } = {}) {
  if (!reference?.personVisible || !current?.personVisible) {
    return { ok: false, status: 'person_not_visible', coverage: 0, feedback: 'I cannot see you yet. Step into the camera frame so I can see your full body.' };
  }
  const referenceChains = CHAINS.filter(chain => chainVisible(reference, chain));
  const basis = referenceChains.length > 0 ? referenceChains : CHAINS;
  const visibleChains = basis.filter(chain => chainVisible(current, chain)).length;
  const coverage = visibleChains / basis.length;
  if (coverage < minCoverage) {
    return { ok: false, status: 'insufficient_visibility', coverage, feedback: 'I cannot compare that pose reliably yet. Step into frame with your arms and legs visible.' };
  }
  return { ok: true, status: 'pose_visible', coverage, feedback: null };
}
