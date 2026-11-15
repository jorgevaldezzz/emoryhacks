/** Instant local pose coaching from MediaPipe landmarks — no vision API round-trip. */

const MIN_CONFIDENCE = 0.35;
/** Max normalized joint error still counted as a match. */
export const MATCH_TOLERANCE = 0.16;
/**
 * Loose enough to be worth asking "want the picture now?" instead of nagging over
 * a last small gap, but still well short of a real pose — twice MATCH_TOLERANCE.
 */
export const CLOSE_TOLERANCE = MATCH_TOLERANCE * 2;
/**
 * Stance can be "good enough" to start arm tips before feet are photo-perfect.
 */
export const LOWER_PHASE_DONE = 0.2;
/** @deprecated use LOWER_PHASE_DONE — kept for any old imports */
export const UPPER_PHASE_DONE = LOWER_PHASE_DONE;
const JOINTS = [
  'nose', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee',
  'right_knee', 'left_ankle', 'right_ankle',
];
/** Coach hips/legs first, then arms/head once the lower phase is close enough. */
const UPPER = new Set([
  'nose', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
]);
const LABELS = {
  nose: 'head',
  left_shoulder: 'left shoulder', right_shoulder: 'right shoulder',
  left_elbow: 'left elbow', right_elbow: 'right elbow',
  left_wrist: 'left wrist', right_wrist: 'right wrist',
  left_hip: 'left hip', right_hip: 'right hip',
  left_knee: 'left knee', right_knee: 'right knee',
  left_ankle: 'left foot', right_ankle: 'right foot',
};

function usable(pose, key) {
  const point = pose?.landmarks?.[key];
  if (!point || point.confidence < MIN_CONFIDENCE) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return point;
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * MediaPipe's x/y are each a fraction of that image's own width/height — not
 * interchangeable units unless the image is square. Real poses carry
 * imageWidth/imageHeight; synthetic/legacy poses may not, so fall back to {1, 1}
 * and behave exactly as before (fraction-space, both axes already comparable).
 */
function pixelScaleFor(pose) {
  const { imageWidth: w, imageHeight: h } = pose ?? {};
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { sx: w, sy: h };
  return { sx: 1, sy: 1 };
}

/**
 * Shoulder-centered unit frame so framing/distance differences cancel out.
 * Image x grows toward the caller's anatomical left (unmirrored facing camera).
 * Converts to a common pixel-like unit first — comparing a portrait reference
 * photo to a landscape-cropped live frame otherwise miscalibrates the y-axis
 * (legs, overhead arms) by roughly the ratio of the two images' aspect ratios.
 */
export function normalizePose(pose) {
  const leftShoulder = usable(pose, 'left_shoulder');
  const rightShoulder = usable(pose, 'right_shoulder');
  if (!leftShoulder || !rightShoulder) return null;
  const { sx, sy } = pixelScaleFor(pose);
  const origin = mid(leftShoulder, rightShoulder);
  const scale = Math.hypot((leftShoulder.x - rightShoulder.x) * sx, (leftShoulder.y - rightShoulder.y) * sy) || 0.2 * sx;
  /** @type {Record<string, { x: number, y: number }>} */
  const points = {};
  for (const key of JOINTS) {
    const point = usable(pose, key);
    if (!point) continue;
    points[key] = {
      x: ((point.x - origin.x) * sx) / scale,
      y: ((point.y - origin.y) * sy) / scale,
    };
  }
  return points;
}

/**
 * Vertical = lift in the air / toward the ceiling. Never "closer to the camera".
 * @param {string} joint
 * @param {number} dx
 * @param {number} dy
 * @param {Record<string, { x: number, y: number }>} ref
 * @param {Record<string, { x: number, y: number }>} cur
 */
export function cueForDelta(joint, dx, dy, ref = {}, cur = {}) {
  const label = LABELS[joint] ?? joint.replaceAll('_', ' ');

  // Stance width: both ankles visible and the gap is the main problem.
  if ((joint === 'left_ankle' || joint === 'right_ankle') && ref.left_ankle && ref.right_ankle && cur.left_ankle && cur.right_ankle) {
    const refWidth = Math.abs(ref.left_ankle.x - ref.right_ankle.x);
    const curWidth = Math.abs(cur.left_ankle.x - cur.right_ankle.x);
    if (Math.abs(refWidth - curWidth) >= Math.max(Math.abs(dx), Math.abs(dy)) * 0.8) {
      return curWidth < refWidth
        ? 'Widen your stance — step your feet farther apart on the floor.'
        : 'Narrow your stance — bring your feet closer together on the floor.';
    }
  }

  if (joint === 'left_hip' || joint === 'right_hip') {
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0
        ? 'Shift your hips toward your right to match the reference lean.'
        : 'Shift your hips toward your left to match the reference lean.';
    }
    return `Adjust your hip level to match the sideways lean in the reference.`;
  }

  // An arm that mainly needs to extend farther out or pull in toward the torso
  // reads as a confusing up/down or left/right cue otherwise (e.g. a reference
  // with the arm held out to the side vs. the caller's arm tucked in close —
  // the dominant delta can land on y even though "reach" is the real gap).
  if (joint.endsWith('_wrist') || joint.endsWith('_elbow')) {
    const side = joint.startsWith('left_') ? 'left' : 'right';
    const shoulder = ref[`${side}_shoulder`];
    const currentShoulder = cur[`${side}_shoulder`];
    const refJoint = ref[joint];
    const curJoint = cur[joint];
    if (shoulder && currentShoulder && refJoint && curJoint) {
      const refReach = Math.hypot(refJoint.x - shoulder.x, refJoint.y - shoulder.y);
      const curReach = Math.hypot(curJoint.x - currentShoulder.x, curJoint.y - currentShoulder.y);
      const reachGap = refReach - curReach;
      if (Math.abs(reachGap) >= Math.max(Math.abs(dx), Math.abs(dy)) * 0.8) {
        return reachGap > 0
          ? `Move your ${label} farther away from your body to match the reference.`
          : `Move your ${label} in closer toward your body to match the reference.`;
      }
    }
  }

  // A landmark moving upward in the image does not mean the caller should lift
  // that limb. For legs, coach the bend/stance relationship and keep feet planted.
  if (joint.endsWith('_knee') || joint.endsWith('_ankle')) {
    const side = joint.startsWith('left_') ? 'left' : 'right';
    const hip = ref[`${side}_hip`], knee = ref[`${side}_knee`], ankle = ref[`${side}_ankle`];
    const currentHip = cur[`${side}_hip`], currentKnee = cur[`${side}_knee`], currentAnkle = cur[`${side}_ankle`];
    if (hip && knee && ankle && currentHip && currentKnee && currentAnkle) {
      const angle = (a, vertex, b) => {
        const ax = a.x - vertex.x, ay = a.y - vertex.y;
        const bx = b.x - vertex.x, by = b.y - vertex.y;
        const denom = Math.hypot(ax, ay) * Math.hypot(bx, by) || 1;
        return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / denom)));
      };
      const referenceBend = angle(hip, knee, ankle);
      const currentBend = angle(currentHip, currentKnee, currentAnkle);
      if (Math.abs(referenceBend - currentBend) > 0.12) {
        return referenceBend < currentBend
          ? `Bend your ${side} knee more like the reference, keeping your foot on the floor.`
          : `Straighten your ${side} knee a little like the reference, keeping your foot on the floor.`;
      }
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0
        ? `Slide your ${side} foot outward on the floor to match the reference.`
        : `Slide your ${side} foot inward on the floor to match the reference.`;
    }
    return `Adjust your ${side} leg to match the bend and position in the reference, keeping your foot on the floor.`;
  }

  // Larger image-x ⇒ toward caller's left; larger y ⇒ lower in frame.
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) {
      const nearHead = ref.nose && ref[joint] && ref[joint].y <= ref.nose.y + 0.85;
      const target = nearHead ? 'toward your head' : 'toward the ceiling';
      return `Lift your ${label} upward ${target} — up in the air, not closer to the camera.`;
    }
    return `Lower your ${label} downward — down toward the floor, not farther from the camera.`;
  }
  return dx > 0
    ? `Move your ${label} to your right.`
    : `Move your ${label} to your left.`;
}

function worstIn(keys, ref, cur, excluded) {
  let worst = null;
  for (const key of keys) {
    if (excluded.has(key)) continue;
    const a = ref[key];
    const b = cur[key];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const error = Math.hypot(dx, dy);
    if (!worst || error > worst.error) worst = { key, dx, dy, error };
  }
  return worst;
}

function errorSummary(keys, ref, cur, excluded) {
  const errors = keys.filter(key => !excluded.has(key) && ref[key] && cur[key])
    .map(key => Math.hypot(cur[key].x - ref[key].x, cur[key].y - ref[key].y))
    .sort((a, b) => a - b);
  if (!errors.length) return { mean: 0, rawMean: 0, max: 0, count: 0 };
  // Ignore one noisy landmark (commonly a foot) while still requiring the rest
  // of the visible pose to line up. A large second miss still prevents a snap.
  const trimmed = errors.length >= 5 ? errors.slice(0, -1) : errors;
  return {
    mean: trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length,
    // Untrimmed — a user-facing accuracy score shouldn't ignore the one joint
    // still being corrected the way the lenient match/close gating above does.
    rawMean: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    max: errors.at(-1),
    count: errors.length,
  };
}

/**
 * Every joint both poses agree is visible, within MATCH_TOLERANCE of the reference.
 */
function goodJointsIn(keys, ref, cur) {
  return keys.filter(key => ref[key] && cur[key] && Math.hypot(cur[key].x - ref[key].x, cur[key].y - ref[key].y) <= MATCH_TOLERANCE);
}

/**
 * Compare two MediaPipe poses locally and return the same adjust/matched shape as Grok coaching.
 * @param {{ reference: object, current: object, excludeJoints?: string[] }} args
 */
export function comparePoseGeometry({ reference, current, excludeJoints = [] } = {}) {
  const ref = normalizePose(reference);
  const cur = normalizePose(current);
  if (!ref || !cur) {
    return {
      ok: false,
      status: 'comparison_uncertain',
      focusJoint: null,
      feedback: null,
      score: null,
      accuracyPercent: null,
      goodJoints: [],
    };
  }

  const excluded = new Set((excludeJoints ?? []).filter(Boolean));
  const upperKeys = JOINTS.filter(key => UPPER.has(key));
  const lowerKeys = JOINTS.filter(key => !UPPER.has(key));
  const upper = worstIn(upperKeys, ref, cur, excluded);
  const lower = worstIn(lowerKeys, ref, cur, excluded);
  // Independent of excludeJoints — a joint can be "don't re-nag, we're stuck on
  // something else" and still genuinely good enough to confirm as good.
  const goodJoints = goodJointsIn(JOINTS, ref, cur);

  const summary = errorSummary(JOINTS, ref, cur, excluded);
  const upperOk = !upper || upper.error <= MATCH_TOLERANCE;
  const lowerOk = !lower || lower.error <= MATCH_TOLERANCE;
  const matched = summary.mean <= MATCH_TOLERANCE && (summary.max <= 0.35 || summary.count < 5);
  if (matched) {
    return {
      ok: true,
      status: 'matched',
      focusJoint: null,
      feedback: 'Your pose matches the reference. Hold still for the photo.',
      score: 1,
      accuracyPercent: 100,
      goodJoints,
    };
  }

  // 1.0 (a full shoulder-width off) reads as 0% accuracy; 0 reads as 100%. Only
  // reached once "matched" has already failed, so this never shows 100 itself.
  // The same number drives both the spoken accuracy and the logged score, so the
  // two never read as two different, conflicting measurements of the same look.
  const accuracyPercent = Math.round(Math.max(0, Math.min(100, 100 * (1 - summary.rawMean))));
  const score = accuracyPercent / 100;

  // Close enough overall to be worth offering the picture — the trim above
  // already forgives exactly one still-imperfect joint (within the max cap), so
  // this also covers "every limb but one is already within MATCH_TOLERANCE."
  const close = summary.mean <= CLOSE_TOLERANCE && (summary.max <= 0.5 || summary.count < 5);
  if (close) {
    return {
      ok: true,
      status: 'close',
      focusJoint: null,
      feedback: `You're pretty close to the reference pose, about ${accuracyPercent}% accuracy — want me to go ahead and take the picture?`,
      score,
      accuracyPercent,
      goodJoints,
    };
  }

  // Phase 1: hips/legs. Phase 2: arms/head once stance is close enough (not perfect).
  const lowerSummary = errorSummary(lowerKeys, ref, cur, excluded);
  const lowerPhaseDone = !lower || lower.error <= LOWER_PHASE_DONE || lowerSummary.mean <= LOWER_PHASE_DONE;
  /** @type {{ key: string, dx: number, dy: number, error: number } | null} */
  let worst = null;
  if (!lowerPhaseDone) worst = lower;
  else if (upper && !upperOk) worst = upper;
  else if (lower && !lowerOk) worst = lower;
  else worst = upper ?? lower;

  if (!worst) {
    return {
      ok: false,
      status: 'comparison_uncertain',
      focusJoint: null,
      feedback: null,
      score: null,
      accuracyPercent: null,
      goodJoints,
    };
  }

  return {
    ok: true,
    status: 'adjust',
    focusJoint: worst.key,
    feedback: `${cueForDelta(worst.key, worst.dx, worst.dy, ref, cur)} You're at about ${accuracyPercent}% accuracy.`,
    score,
    accuracyPercent,
    goodJoints,
  };
}
