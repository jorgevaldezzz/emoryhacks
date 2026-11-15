const CHAINS = [
  ['left_shoulder', 'left_elbow', 'left_wrist', 'left elbow', 'Bend your left elbow more.', 'Straighten your left arm a bit.'],
  ['right_shoulder', 'right_elbow', 'right_wrist', 'right elbow', 'Bend your right elbow more.', 'Straighten your right arm a bit.'],
  ['left_hip', 'left_knee', 'left_ankle', 'left knee', 'Bend your left knee more.', 'Straighten your left leg a bit.'],
  ['right_hip', 'right_knee', 'right_ankle', 'right knee', 'Bend your right knee more.', 'Straighten your right leg a bit.'],
];
const angle = (a, b, c) => {
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return denom < 1e-6 ? null : Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denom))) * 180 / Math.PI;
};
const usable = (p, key) => p?.landmarks?.[key]?.confidence >= 0.35 ? p.landmarks[key] : null;

/**
 * @param {number} referenceDegrees
 * @param {number} currentDegrees
 * @param {string} bendCue
 * @param {string} straightenCue
 */
function cueForAngle(referenceDegrees, currentDegrees, bendCue, straightenCue) {
  // Larger interior angle => straighter limb. Smaller => more bent.
  return currentDegrees > referenceDegrees ? bendCue : straightenCue;
}

/** Compare joint angles, which are less sensitive to camera distance and framing. */
export function comparePoses(reference, current, { threshold = 18, minCoverage = 0.55 } = {}) {
  if (!reference?.personVisible || !current?.personVisible) return { ok: false, status: 'person_not_visible', score: null, issues: [], coverage: 0, feedback: 'I cannot see you yet. Step into the camera frame so I can see your full body.' };
  const errors = [];
  for (const [a, b, c, label, bendCue, straightenCue] of CHAINS) {
    const points = [usable(reference, a), usable(reference, b), usable(reference, c)];
    const live = [usable(current, a), usable(current, b), usable(current, c)];
    if (!points.every(Boolean) || !live.every(Boolean)) continue;
    const referenceDegrees = angle(...points);
    const currentDegrees = angle(...live);
    if (referenceDegrees === null || currentDegrees === null) continue;
    errors.push({
      label,
      degrees: Math.abs(referenceDegrees - currentDegrees),
      cue: cueForAngle(referenceDegrees, currentDegrees, bendCue, straightenCue),
    });
  }
  const coverage = errors.length / CHAINS.length;
  if (coverage < minCoverage) return { ok: false, status: 'insufficient_visibility', score: null, issues: [], coverage, feedback: 'I cannot compare that pose reliably yet. Step into frame with your arms and legs visible.' };
  errors.sort((a, b) => b.degrees - a.degrees);
  const score = Math.round(Math.max(0, 100 - errors.reduce((sum, item) => sum + item.degrees, 0) / errors.length * 1.5));
  const issues = errors.filter(item => item.degrees > threshold).slice(0, 2);
  if (!issues.length) return { ok: true, status: 'matched', score, issues: [], coverage, feedback: 'Your pose is close to the reference. Hold still for the photo.' };
  const directions = issues.map(item => item.cue).join(' ');
  return { ok: true, status: 'adjust', score, issues, coverage, feedback: directions };
}
