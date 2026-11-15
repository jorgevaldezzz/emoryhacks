import { renderPoseOverlay } from './pose_overlays.mjs';

const ENDPOINT = 'https://api.x.ai/v1/responses';
const JOINTS = [
  'nose', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee',
  'right_knee', 'left_ankle', 'right_ankle', 'none',
];
const FORMAT = {
  type: 'json_schema',
  name: 'pose_coaching_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['adjust', 'matched', 'uncertain'] },
      focus_joint: { type: 'string', enum: JOINTS },
      cue: { type: ['string', 'null'] },
    },
    required: ['status', 'focus_joint', 'cue'],
  },
};

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  return (payload?.output ?? []).flatMap(item => item?.content ?? [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text).join('\n');
}

function validateResult(value) {
  if (!value || !['adjust', 'matched', 'uncertain'].includes(value.status) || !JOINTS.includes(value.focus_joint)) {
    throw new Error('Grok returned an invalid pose comparison.');
  }
  if (value.status === 'adjust') {
    if (value.focus_joint === 'none' || typeof value.cue !== 'string' || value.cue.trim().length < 12 || value.cue.length > 240) {
      throw new Error('Grok returned an unusable pose correction.');
    }
    return { ok: true, status: 'adjust', focusJoint: value.focus_joint, feedback: value.cue.trim() };
  }
  if (value.focus_joint !== 'none' || value.cue !== null) throw new Error('Grok returned an inconsistent pose status.');
  if (value.status === 'matched') return { ok: true, status: 'matched', focusJoint: null, feedback: 'Your pose matches the reference. Hold still for the photo.' };
  return { ok: false, status: 'comparison_uncertain', focusJoint: null, feedback: null };
}

function coachingPrompt(excludeJoints = []) {
  const excluded = excludeJoints.filter(joint => joint && joint !== 'none');
  const skip = excluded.length
    ? ` The caller was already coached on these joints this attempt — do not choose them again for focus_joint: ${excluded.join(', ')}. Pick the next most important remaining gap instead.`
    : '';
  return (
    'Compare these MediaPipe skeleton overlays. Image 1 is the target reference; image 2 is the live caller. '
    + 'Each numbered node maps to the joint name in the right-side legend; use that mapping for focus_joint and spoken directions. '
    + 'left_* and right_* mean the caller’s own anatomical sides, never the side of the screen; the live caller frame was unmirrored before landmark detection. '
    + 'The neutral canvas contains labeled skeletons only, not the original photos. '
    + 'Compare only the overlapping visible joints — a waist-up caller can still match the upper body of a full-body reference. '
    + 'If they differ, identify the single most important correction and tell the caller exactly which body part to move, in which direction, '
    + 'and where it should align relative to another visible joint. '
    + 'Prefer stance, feet, hips, and torso lean when those differ from the reference; only focus on a wrist or hand when the lower body and torso already look close. '
    + 'Never invent positions not supported by the drawings. Mark matched only when the visible pose geometry is close. If uncertain, do not guess. '
    + 'Reply with the required structured result; an adjustment must have focus_joint and one short, specific cue, while matched/uncertain must use focus_joint "none" and cue null.'
    + skip
  );
}

export function createGrokPoseCoach({ apiKey = process.env.XAI_API_KEY, model = process.env.XAI_POSE_COACH_MODEL || 'grok-4.7', fetchImpl = fetch } = {}) {
  return async function comparePose({ reference, current, excludeJoints = [] } = {}) {
    if (!apiKey) throw new Error('XAI_API_KEY is missing; Grok pose comparison is unavailable.');
    const [referenceOverlay, currentOverlay] = await Promise.all([
      renderPoseOverlay(reference),
      renderPoseOverlay(current),
    ]);
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        // Landmark overlays are a spatial glance, not a reasoning task. Low effort
        // answers in ~10s; the default often blows past the call's silent-look budget.
        reasoning: { effort: 'low' },
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: coachingPrompt(excludeJoints) },
            { type: 'input_image', image_url: referenceOverlay, detail: 'high' },
            { type: 'input_image', image_url: currentOverlay, detail: 'high' },
          ],
        }],
        text: { format: FORMAT },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : response.statusText;
      throw new Error(`Grok pose comparison failed (${response.status}): ${message}`);
    }
    let parsed;
    try { parsed = JSON.parse(responseText(payload)); }
    catch { throw new Error('Grok returned malformed pose comparison output.'); }
    return validateResult(parsed);
  };
}

export { ENDPOINT as GROK_POSE_ENDPOINT, FORMAT as GROK_POSE_RESPONSE_FORMAT, validateResult as validateGrokPoseResult };
