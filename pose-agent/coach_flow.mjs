// Chert call: coach to the reference skeleton → match → countdown → snap.
// The caller does not pick the correction or decide when the pose matches.

/**
 * Drop lines that hand the next step back to the caller.
 * @param {unknown} text
 * @returns {string}
 */
function stripHandoff(text) {
  return String(text ?? '')
    .replace(/you look ready\s*[—-]\s*say cheese when you want the shot\.?/gi, '')
    .replace(/say cheese when you want the shot\.?/gi, '')
    .replace(/then ask me to check again\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[—\-,\s]+|[—\-,\s]+$/g, '');
}

const FRAMING = /\b(in frame|into frame|framing|step back|step into|arms and legs|feet and arms|arms and feet)\b/i;

/**
 * A joint correction worth saying. Framing nags are dropped: a fully visible
 * caller was being told to keep their arms and feet in frame.
 * @param {unknown} text
 * @returns {string | null}
 */
export function spokenCorrection(text) {
  const say = stripHandoff(text);
  if (!say || FRAMING.test(say)) return null;
  return say;
}

/**
 * Tool result when the caller should hear nothing.
 * Keep this a token the model must not vocalize — "produce no audio" was being read aloud.
 */
export const noSpeech = 'TOOL_SILENT';

/**
 * Empty coaching memory for a new call or after a successful match/snap.
 * @returns {{ lastFocusJoint: null, lastCue: string, spokenJoints: Set<string> }}
 */
export function emptyCoachMemory() {
  return { lastFocusJoint: null, lastCue: '', spokenJoints: new Set() };
}

/**
 * Joints already coached this pose attempt — Grok should pick a different gap next.
 * @param {Iterable<string> | null | undefined} spokenJoints
 * @returns {string[]}
 */
export function excludeJointsForCompare(spokenJoints) {
  return [...(spokenJoints ?? [])].filter(Boolean);
}

/**
 * Suppress the same focus joint until coaching moves on (or memory is cleared on match).
 * @param {{ focusJoint?: string | null } | null | undefined} result
 * @param {string | null | undefined} lastFocusJoint
 * @param {Set<string> | null | undefined} [spokenJoints]
 */
export function shouldSpeakPoseCue(result, lastFocusJoint, spokenJoints = null) {
  const joint = result?.focusJoint;
  if (!joint) return true;
  if (spokenJoints?.has(joint)) return false;
  return joint !== lastFocusJoint;
}

/**
 * Update cue memory after a look. Visibility misses keep memory so a flicker does
 * not re-nag the same wrist tip; a match clears it for the next pose attempt.
 * @param {{ lastFocusJoint: string | null, lastCue: string, spokenJoints: Set<string> }} memory
 * @param {{ status?: string, focusJoint?: string | null, ready?: boolean } | null | undefined} judged
 * @param {string | null | undefined} spokenCue
 */
export function afterCoachObservation(memory, judged, spokenCue) {
  const status = judged?.status;
  if (status === 'person_not_visible' || status === 'insufficient_visibility') {
    return memory;
  }
  if (status === 'matched' || judged?.ready === true) {
    return emptyCoachMemory();
  }
  if (spokenCue && judged?.focusJoint) {
    const spokenJoints = new Set(memory.spokenJoints);
    // After covering several regions, allow revisiting so a half-fixed wrist can be refined.
    if (spokenJoints.size >= 5) spokenJoints.clear();
    spokenJoints.add(judged.focusJoint);
    return {
      lastFocusJoint: judged.focusJoint,
      lastCue: spokenCue,
      spokenJoints,
    };
  }
  return memory;
}

/**
 * Decide the next step from a live-frame comparison against the reference skeleton.
 * A match snaps once. The next mismatch arms another snap. The caller is not asked
 * to confirm the match or to request the next check.
 * @param {{ status?: string, feedback?: string | null, cue?: string | null, ready?: boolean } | null | undefined} result
 * @param {{ autoSnapArmed?: boolean }} [state]
 * @returns {{ action: 'snap' | 'coach' | 'wait', say: string | null, autoSnapArmed: boolean }}
 */
export function nextCoachStep(result, state = {}) {
  const armed = state.autoSnapArmed !== false;
  const status = result?.status;

  if (status === 'check_in_progress' || status === 'reference_missing' || status === 'unreadable') {
    return { action: 'wait', say: null, autoSnapArmed: armed };
  }

  const blocked = status === 'person_not_visible' || status === 'insufficient_visibility';
  if (blocked) return { action: 'wait', say: null, autoSnapArmed: true };
  if (status === 'matched' || result?.ready === true) {
    if (!armed) return { action: 'wait', say: null, autoSnapArmed: false };
    return { action: 'snap', say: 'Hold still.', autoSnapArmed: false };
  }

  const raw = typeof result?.feedback === 'string' && result.feedback.trim()
    ? result.feedback
    : result?.cue;
  const say = spokenCorrection(raw);
  if (say) return { action: 'coach', say, autoSnapArmed: true };
  if (status === 'adjust') return { action: 'wait', say: null, autoSnapArmed: true };
  return { action: 'wait', say: null, autoSnapArmed: armed };
}

/**
 * Spoken instructions for one skeleton correction. The model adds nothing.
 * @param {string} cue
 * @returns {string}
 */
export function coachSpeech(cue) {
  return `Speak English only. Say "Okay," then only this specific body correction in one short sentence, then stop. Include its direction and relative target. Do not add another correction or a framing instruction. Never say you looked at an image or photo: ${cue}`;
}

/**
 * Spoken instructions after the countdown photo has already been taken.
 * @returns {string}
 */
export function photoAckSpeech() {
  return 'Speak English only. You already took the photo — it flashed and is on FaceTime. Acknowledge in one short sentence, then stop. Do not call take_photo again. Do not give a new pose correction.';
}
