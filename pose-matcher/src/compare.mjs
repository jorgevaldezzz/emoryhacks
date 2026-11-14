import { JOINTS } from './extract.mjs';

const CHAINS = [
  ['left_shoulder', 'left_elbow', 'left_wrist', 'left arm'],
  ['right_shoulder', 'right_elbow', 'right_wrist', 'right arm'],
  ['left_hip', 'left_knee', 'left_ankle', 'left leg'],
  ['right_hip', 'right_knee', 'right_ankle', 'right leg'],
];
const angle = (a, b, c) => {
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return denom < 1e-6 ? null : Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denom))) * 180 / Math.PI;
};
const usable = (p, key) => p?.landmarks?.[key]?.confidence >= 0.35 ? p.landmarks[key] : null;

/** Compare joint angles, which are less sensitive to camera distance and framing. */
export function comparePoses(reference, current, { threshold = 18, minCoverage = 0.55 } = {}) {
  if (!reference?.personVisible || !current?.personVisible) return { ok: false, status: 'person_not_visible', score: null, issues: [], coverage: 0, feedback: 'I cannot see enough of you to check the pose. Step back so your body is in frame.' };
  const errors = [];
  for (const [a, b, c, label] of CHAINS) {
    const points = [usable(reference, a), usable(reference, b), usable(reference, c)];
    const live = [usable(current, a), usable(current, b), usable(current, c)];
    if (points.every(Boolean) && live.every(Boolean)) errors.push({ label, degrees: Math.abs(angle(...points) - angle(...live)) });
  }
  const coverage = errors.length / CHAINS.length;
  if (coverage < minCoverage) return { ok: false, status: 'insufficient_visibility', score: null, issues: [], coverage, feedback: 'I cannot compare that pose reliably yet. Make sure your arms and legs are visible in the camera.' };
  errors.sort((a, b) => b.degrees - a.degrees);
  const score = Math.round(Math.max(0, 100 - errors.reduce((sum, item) => sum + item.degrees, 0) / errors.length * 1.5));
  const issues = errors.filter(item => item.degrees > threshold).slice(0, 2);
  if (!issues.length) return { ok: true, status: 'matched', score, issues: [], coverage, feedback: 'Your pose is close to the reference. Hold still for the photo.' };
  const directions = issues.map(item => `${item.label} differs from the reference`).join(' and ');
  return { ok: true, status: 'adjust', score, issues, coverage, feedback: `Adjust your ${directions}, then ask me to check again.` };
}

/** Keep only the supported landmark keys in a payload sent to a voice agent. */
export function poseSummary(pose) {
  return Object.fromEntries(JOINTS.filter(key => pose?.landmarks?.[key]).map(key => [key, pose.landmarks[key]]));
}
