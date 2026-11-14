import { JOINTS } from './extract.mjs';

const CHAINS = [
  ['left_shoulder', 'left_elbow', 'left_wrist', 'left arm'],
  ['right_shoulder', 'right_elbow', 'right_wrist', 'right arm'],
  ['left_hip', 'left_knee', 'left_ankle', 'left leg'],
  ['right_hip', 'right_knee', 'right_ankle', 'right leg'],
];

const angle = (a, b, c) => {
  const ux = a.x - b.x;
  const uy = a.y - b.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return denom < 1e-6 ? null : Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denom))) * 180 / Math.PI;
};

const usable = (pose, key) => (
  pose?.landmarks?.[key]?.confidence >= 0.35 ? pose.landmarks[key] : null
);

/**
 * Turn an angle delta into a short coaching tip.
 * Larger joint angle ≈ straighter limb.
 * @param {string} label
 * @param {number} deltaLiveMinusRef
 */
export function tipForDelta(label, deltaLiveMinusRef) {
  if (deltaLiveMinusRef > 0) return `bend your ${label} a little`;
  return `straighten your ${label} a little`;
}

/** Compare joint angles, which are less sensitive to camera distance and framing. */
export function comparePoses(reference, current, { threshold = 18, minCoverage = 0.55 } = {}) {
  if (!reference?.personVisible || !current?.personVisible) {
    return {
      ok: false,
      status: 'person_not_visible',
      score: null,
      issues: [],
      coverage: 0,
      ready: false,
      feedback: 'Step back so more of your body is in the camera.',
    };
  }

  const errors = [];
  for (const [a, b, c, label] of CHAINS) {
    const points = [usable(reference, a), usable(reference, b), usable(reference, c)];
    const live = [usable(current, a), usable(current, b), usable(current, c)];
    if (!points.every(Boolean) || !live.every(Boolean)) continue;
    const refAngle = angle(...points);
    const liveAngle = angle(...live);
    if (refAngle === null || liveAngle === null) continue;
    const degrees = Math.abs(liveAngle - refAngle);
    errors.push({
      label,
      degrees,
      delta: liveAngle - refAngle,
      tip: tipForDelta(label, liveAngle - refAngle),
    });
  }

  const coverage = errors.length / CHAINS.length;
  if (coverage < minCoverage) {
    return {
      ok: false,
      status: 'insufficient_visibility',
      score: null,
      issues: [],
      coverage,
      ready: false,
      feedback: 'Make sure your arms and legs are visible in the camera.',
    };
  }

  errors.sort((a, b) => b.degrees - a.degrees);
  const score = Math.round(Math.max(0, 100 - errors.reduce((sum, item) => sum + item.degrees, 0) / errors.length * 1.5));
  const issues = errors.filter(item => item.degrees > threshold).slice(0, 2);

  if (!issues.length) {
    return {
      ok: true,
      status: 'matched',
      score,
      issues: [],
      coverage,
      ready: true,
      feedback: 'You look ready — say cheese when you want the shot.',
    };
  }

  const feedback = issues.map(item => item.tip).join(', then ');
  return {
    ok: true,
    status: 'adjust',
    score,
    issues,
    coverage,
    ready: false,
    feedback: `${feedback.charAt(0).toUpperCase()}${feedback.slice(1)}.`,
  };
}

/** Keep only the supported landmark keys in a payload sent to a voice agent. */
export function poseSummary(pose) {
  return Object.fromEntries(
    JOINTS.filter(key => pose?.landmarks?.[key]).map(key => [key, pose.landmarks[key]]),
  );
}
