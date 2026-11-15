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
 * @returns {{ lastFocusJoint: null, lastCue: string, spokenJoints: Set<string>, repeatStreak: number, confirmedGoodJoints: Set<string>, stuckJoint: null, stuckCount: number }}
 */
export function emptyCoachMemory() {
  return {
    lastFocusJoint: null, lastCue: '', spokenJoints: new Set(),
    repeatStreak: 0, confirmedGoodJoints: new Set(),
    stuckJoint: null, stuckCount: 0,
  };
}

/**
 * Count consecutive LOOKS (not just spoken cues) naming the same worst joint.
 * A stuck joint goes silent after its first utterance — shouldSpeakPoseCue
 * suppresses any repeat of the immediately-previous joint — so counting only
 * spoken cues would never notice it's stayed the worst joint call after call
 * with nothing new ever said about it. Call this on every look, independent
 * of whether anything actually gets spoken.
 * @param {{ stuckJoint?: string | null, stuckCount?: number }} memory
 * @param {string | null | undefined} focusJoint
 * @returns {{ stuckJoint: string | null, stuckCount: number }}
 */
export function trackStuckJoint(memory, focusJoint) {
  if (!focusJoint) return { stuckJoint: null, stuckCount: 0 };
  const stuckCount = focusJoint === memory?.stuckJoint ? (memory?.stuckCount ?? 0) + 1 : 1;
  return { stuckJoint: focusJoint, stuckCount };
}

/**
 * Joints already coached this pose attempt — Grok should pick a different gap next.
 * @param {Iterable<string> | null | undefined} spokenJoints
 * @returns {string[]}
 */
export function excludeJointsForCompare(spokenJoints) {
  return [...(spokenJoints ?? [])].filter(Boolean);
}

/** After this many repeats (spoken or silent) of the same ground, force a switch. */
export const REPEAT_SWITCH_THRESHOLD = 2;

/**
 * Geometry coaching sticks on one joint by design (shouldSpeakPoseCue only
 * suppresses a change from the IMMEDIATELY previous joint), so a genuinely stuck
 * joint keeps getting named instead of going silent. Two failure shapes to catch:
 * the SAME joint staying the worst one look after look (goes fully silent after
 * the first utterance — caught by stuckJoint/stuckCount, which track every look),
 * and two joints ping-ponging back and forth, neither ever resolving (each flip
 * does get spoken, since it differs from the immediately-previous one — caught by
 * repeatStreak, which only tracks spoken cues). Once either has happened enough
 * times, force a different body part next.
 * @param {{ repeatStreak?: number, spokenJoints?: Set<string>, stuckJoint?: string | null, stuckCount?: number }} memory
 * @returns {string[]}
 */
export function excludeJointsAfterRepeats(memory) {
  const joints = new Set();
  if ((memory?.repeatStreak ?? 0) >= REPEAT_SWITCH_THRESHOLD) {
    for (const joint of excludeJointsForCompare(memory?.spokenJoints)) joints.add(joint);
  }
  if ((memory?.stuckCount ?? 0) >= REPEAT_SWITCH_THRESHOLD && memory?.stuckJoint) {
    joints.add(memory.stuckJoint);
  }
  return [...joints];
}

/**
 * At the same moment coaching is about to force a switch away from a
 * stuck/ping-ponging joint, confirm a limb that's already right instead of
 * immediately piling on a different correction — "your right arm is good,
 * don't move it" — before normal coaching resumes on the next look. Not
 * offered on every look: with most joints starting "good" by coincidence,
 * confirming all of them before any real correction would just stall coaching.
 * @param {{ goodJoints?: string[] }} judged
 * @param {object} memory
 * @returns {{ focusJoint: string, feedback: string } | null}
 */
export function confirmGoodLimb(judged, memory) {
  if (!excludeJointsAfterRepeats(memory).length) return null;
  const confirmed = memory?.confirmedGoodJoints ?? new Set();
  const toConfirm = (judged?.goodJoints ?? []).find(joint => !confirmed.has(joint));
  if (!toConfirm) return null;
  const label = toConfirm.replaceAll('_', ' ');
  return { focusJoint: toConfirm, feedback: `Your ${label} is good — don't move it, keep it right where it is.` };
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
  if (spokenCue) {
    // A no-joint cue (e.g. "you're close, want the picture?") still needs to land
    // in lastCue so followCoachStep's repeat check can quiet it on the next look —
    // shouldSpeakPoseCue never blocks a null-joint cue by joint, only this does.
    const spokenJoints = new Set(memory.spokenJoints);
    let lastFocusJoint = memory.lastFocusJoint;
    let repeatStreak = memory.repeatStreak ?? 0;
    // A joint confirmed good can drift back out of tolerance later and get fixed
    // again — only keep confirmations for joints this look still reports good.
    const stillGood = new Set(judged?.goodJoints ?? []);
    const confirmedGoodJoints = new Set(
      [...(memory.confirmedGoodJoints ?? [])].filter(joint => stillGood.has(joint)),
    );
    if (judged?.focusJoint) {
      lastFocusJoint = judged.focusJoint;
      if (judged.status === 'confirm_good') {
        confirmedGoodJoints.add(judged.focusJoint);
      } else {
        // Landing back on a joint we've already nagged about (shouldSpeakPoseCue
        // only ever suppresses it changing from the IMMEDIATELY previous one, so
        // two joints can still ping-pong forever) counts as a repeat; a fresh
        // joint resets it.
        repeatStreak = spokenJoints.has(judged.focusJoint) ? repeatStreak + 1 : 0;
        // After covering several regions, allow revisiting so a half-fixed wrist can be refined.
        if (spokenJoints.size >= 5) spokenJoints.clear();
        spokenJoints.add(judged.focusJoint);
      }
    }
    return {
      lastFocusJoint,
      lastCue: spokenCue,
      spokenJoints,
      repeatStreak,
      confirmedGoodJoints,
      // trackStuckJoint owns these — called separately, on every look, not just
      // spoken ones. Carry them through untouched so this reassignment doesn't
      // wipe them back to nothing the moment anything gets spoken.
      stuckJoint: memory.stuckJoint ?? null,
      stuckCount: memory.stuckCount ?? 0,
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
