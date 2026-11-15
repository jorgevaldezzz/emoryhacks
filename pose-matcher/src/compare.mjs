const CHAINS = [
  ['left_shoulder', 'left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee', 'left_ankle'],
  ['right_hip', 'right_knee', 'right_ankle'],
];
const usable = (pose, key) => pose?.landmarks?.[key]?.confidence >= 0.35 ? pose.landmarks[key] : null;

/** Reject empty or low-confidence poses locally before sending skeletons for coaching. */
export function checkPoseVisibility(reference, current, { minCoverage = 0.55 } = {}) {
  if (!reference?.personVisible || !current?.personVisible) {
    return { ok: false, status: 'person_not_visible', coverage: 0, feedback: 'I cannot see you yet. Step into the camera frame so I can see your full body.' };
  }
  const visibleChains = CHAINS.filter(chain => chain.every(key => usable(reference, key) && usable(current, key))).length;
  const coverage = visibleChains / CHAINS.length;
  if (coverage < minCoverage) {
    return { ok: false, status: 'insufficient_visibility', coverage, feedback: 'I cannot compare that pose reliably yet. Step into frame with your arms and legs visible.' };
  }
  return { ok: true, status: 'pose_visible', coverage, feedback: null };
}
