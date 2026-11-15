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
  if (!blocked && (status === 'matched' || result?.ready === true)) {
    if (!armed) return { action: 'wait', say: null, autoSnapArmed: false };
    return { action: 'snap', say: 'Hold still.', autoSnapArmed: false };
  }

  const raw = typeof result?.feedback === 'string' && result.feedback.trim()
    ? result.feedback
    : result?.cue;
  const say = stripHandoff(raw);
  if (say) return { action: 'coach', say, autoSnapArmed: true };
  if (status === 'adjust' || blocked) return { action: 'wait', say: null, autoSnapArmed: true };
  return { action: 'wait', say: null, autoSnapArmed: armed };
}

/**
 * Spoken instructions for one skeleton correction. The model adds nothing.
 * @param {string} cue
 * @returns {string}
 */
export function coachSpeech(cue) {
  return `Speak English only. Say "Okay," then only this pose correction in one short sentence, then stop. Do not ask them to say cheese, ask for another check, or decide if they match. Never say you looked at an image or photo: ${cue}`;
}

/**
 * Spoken instructions after the countdown photo has already been taken.
 * @returns {string}
 */
export function photoAckSpeech() {
  return 'Speak English only. You already took the photo — it flashed and is on FaceTime. Acknowledge in one short sentence, then stop. Do not call take_photo again. Do not give a new pose correction.';
}
