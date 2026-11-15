import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  afterCoachObservation,
  confirmGoodLimb,
  emptyCoachMemory,
  excludeJointsAfterRepeats,
  excludeJointsForCompare,
  nextCoachStep,
  shouldSpeakPoseCue,
  trackStuckJoint,
} from '../coach_flow.mjs';

describe('nextCoachStep', () => {
  it('suppresses a repeated focus joint until attention moves to another joint', () => {
    assert.equal(shouldSpeakPoseCue({ focusJoint: 'left_wrist' }, 'left_wrist'), false);
    assert.equal(shouldSpeakPoseCue({ focusJoint: 'left_elbow' }, 'left_wrist'), true);
    assert.equal(shouldSpeakPoseCue({ focusJoint: 'left_wrist' }, 'left_wrist'), false);
    assert.equal(
      shouldSpeakPoseCue({ focusJoint: 'right_wrist' }, null, new Set(['right_wrist'])),
      false,
    );
  });

  it('keeps cue memory across a visibility miss so the same wrist tip is not re-spoken', () => {
    const cue = 'Raise your right wrist up beside your head.';
    let memory = { lastFocusJoint: null, lastCue: '', spokenJoints: new Set() };
    memory = afterCoachObservation(memory, {
      status: 'adjust',
      focusJoint: 'right_wrist',
      feedback: cue,
    }, cue);
    assert.equal(memory.lastFocusJoint, 'right_wrist');
    assert.ok(memory.spokenJoints.has('right_wrist'));

    memory = afterCoachObservation(memory, { status: 'insufficient_visibility' }, null);
    assert.equal(memory.lastFocusJoint, 'right_wrist');
    assert.equal(memory.lastCue, cue);
    assert.ok(memory.spokenJoints.has('right_wrist'));
    assert.equal(
      shouldSpeakPoseCue({ focusJoint: 'right_wrist' }, memory.lastFocusJoint, memory.spokenJoints),
      false,
    );
    assert.deepEqual([...excludeJointsForCompare(memory.spokenJoints)], ['right_wrist']);
  });

  it('clears spoken joints after a match so a later pose can be coached again', () => {
    let memory = afterCoachObservation(
      { lastFocusJoint: null, lastCue: '', spokenJoints: new Set() },
      { status: 'adjust', focusJoint: 'right_wrist' },
      'Raise your right wrist up beside your head.',
    );
    memory = afterCoachObservation(memory, { status: 'matched', ready: true }, null);
    assert.equal(memory.lastFocusJoint, null);
    assert.equal(memory.lastCue, '');
    assert.equal(memory.spokenJoints.size, 0);
  });
  it('snaps on the first skeleton match and does not snap again until they leave it', () => {
    const matched = {
      status: 'matched',
      feedback: 'Your pose is close to the reference. Hold still for the photo.',
    };
    const first = nextCoachStep(matched, { autoSnapArmed: true });
    assert.equal(first.action, 'snap');
    assert.equal(first.say, 'Hold still.');
    assert.equal(first.autoSnapArmed, false);

    const held = nextCoachStep(matched, { autoSnapArmed: first.autoSnapArmed });
    assert.equal(held.action, 'wait');
    assert.equal(held.autoSnapArmed, false);

    const moved = nextCoachStep(
      { status: 'adjust', feedback: 'Bend your left elbow more. Then ask me to check again.' },
      { autoSnapArmed: held.autoSnapArmed },
    );
    assert.equal(moved.action, 'coach');
    assert.equal(moved.say, 'Bend your left elbow more.');
    assert.equal(moved.autoSnapArmed, true);
    assert.doesNotMatch(moved.say, /cheese|ask me to check/i);

    const again = nextCoachStep(matched, { autoSnapArmed: moved.autoSnapArmed });
    assert.equal(again.action, 'snap');
  });

  it('does not speak a framing nag when the caller is already visible', () => {
    const step = nextCoachStep({
      status: 'insufficient_visibility',
      ready: true,
      feedback: 'I cannot compare that pose reliably yet. Step into frame with your arms and legs visible.',
    }, { autoSnapArmed: true });
    assert.equal(step.action, 'wait');
    assert.equal(step.say, null);
    assert.equal(step.autoSnapArmed, true);

    const paraphrased = nextCoachStep({
      status: 'adjust',
      feedback: 'Keep the feet and arms in frame.',
    }, { autoSnapArmed: true });
    assert.equal(paraphrased.action, 'wait');
    assert.equal(paraphrased.say, null);
  });

  it('uses comparison results to coach or snap only on a match', () => {
    const coaching = nextCoachStep(
      { ready: false, cue: 'Raise your left elbow higher.' },
      { autoSnapArmed: true },
    );
    assert.equal(coaching.action, 'coach');
    assert.equal(coaching.say, 'Raise your left elbow higher.');

    const ready = nextCoachStep(
      { ready: true, cue: 'You look ready — say cheese when you want the shot.' },
      { autoSnapArmed: true },
    );
    assert.equal(ready.action, 'snap');
    assert.equal(ready.say, 'Hold still.');
  });

  it('leaves the armed flag alone while a comparison is already running', () => {
    const step = nextCoachStep(
      { status: 'check_in_progress', feedback: 'I am checking the last photo. Please wait a moment.' },
      { autoSnapArmed: false },
    );
    assert.equal(step.action, 'wait');
    assert.equal(step.autoSnapArmed, false);
  });

  it('asks instead of auto-snapping when the pose is merely close, and does not repeat the ask', () => {
    const close = {
      status: 'close',
      focusJoint: null,
      feedback: "You're pretty close to the reference pose — want me to go ahead and take the picture?",
    };
    const step = nextCoachStep(close, { autoSnapArmed: true });
    assert.equal(step.action, 'coach');
    assert.equal(step.say, close.feedback);
    assert.equal(step.autoSnapArmed, true);

    // No focusJoint means shouldSpeakPoseCue alone would never suppress a repeat —
    // afterCoachObservation must still remember the cue text itself.
    let memory = afterCoachObservation(
      { lastFocusJoint: null, lastCue: '', spokenJoints: new Set() },
      close,
      step.say,
    );
    assert.equal(memory.lastCue, close.feedback);
    assert.equal(memory.lastFocusJoint, null);
  });

  it('forces a different body part once two joints keep ping-ponging back and forth', () => {
    // shouldSpeakPoseCue only ever blocks the joint that was JUST spoken, so an
    // A→B→A→B pattern never trips it — that's exactly the case this guards.
    let memory = emptyCoachMemory();
    const speak = (focusJoint, cue) => {
      memory = afterCoachObservation(memory, { status: 'adjust', focusJoint }, cue);
    };
    speak('left_wrist', 'Lift your left wrist.'); // fresh: repeatStreak 0
    assert.equal(memory.repeatStreak, 0);
    speak('right_wrist', 'Lower your right wrist.'); // fresh: repeatStreak 0
    assert.equal(memory.repeatStreak, 0);
    speak('left_wrist', 'Lift your left wrist.'); // back to a covered joint: 1
    assert.equal(memory.repeatStreak, 1);
    assert.deepEqual(excludeJointsAfterRepeats(memory), []); // not yet — give it one more try
    speak('right_wrist', 'Lower your right wrist.'); // covered again: 2 — switch now
    assert.equal(memory.repeatStreak, 2);
    const excluded = excludeJointsAfterRepeats(memory);
    assert.ok(excluded.includes('left_wrist'));
    assert.ok(excluded.includes('right_wrist'));
  });

  it('forces a switch off a joint stuck as the worst one for several looks, even though it never got re-spoken', () => {
    // The actual bug this guards: shouldSpeakPoseCue silences every look after the
    // first once the SAME joint keeps coming back (no ping-pong needed) — so
    // repeatStreak (spoken-cue-only) never moves, and coaching could go mute for
    // the rest of the call. trackStuckJoint runs on every look regardless.
    let memory = emptyCoachMemory();
    memory = { ...memory, ...trackStuckJoint(memory, 'left_wrist') }; // look 1: spoken
    memory = afterCoachObservation(memory, { status: 'adjust', focusJoint: 'left_wrist' }, 'Lift your left wrist.');
    assert.equal(memory.repeatStreak, 0); // spoken-cue counter never saw a repeat

    memory = { ...memory, ...trackStuckJoint(memory, 'left_wrist') }; // look 2: shouldSpeakPoseCue would silence this
    assert.equal(memory.stuckCount, 2);
    assert.deepEqual(excludeJointsAfterRepeats(memory), ['left_wrist']); // switch now, despite repeatStreak still 0
  });

  it('does not exclude anything while a joint is freshly covered, or once the pose matches', () => {
    assert.deepEqual(excludeJointsAfterRepeats(emptyCoachMemory()), []);
    let memory = afterCoachObservation(emptyCoachMemory(), { status: 'adjust', focusJoint: 'left_hip' }, 'Shift your hips.');
    assert.deepEqual(excludeJointsAfterRepeats(memory), []);
    memory = afterCoachObservation(memory, { status: 'matched', ready: true }, null);
    assert.deepEqual(excludeJointsAfterRepeats(memory), []);
  });

  it('only confirms a good limb once coaching is already about to force a switch, not on every look', () => {
    const judged = { goodJoints: ['right_shoulder', 'left_hip'] };
    // repeatStreak alone means nothing without joints it actually ties to —
    // matches the shape afterCoachObservation really produces.
    const stuck = (repeatStreak, confirmedGoodJoints = new Set()) =>
      ({ repeatStreak, spokenJoints: new Set(['left_wrist']), confirmedGoodJoints });
    assert.equal(confirmGoodLimb(judged, stuck(0)), null);
    assert.equal(confirmGoodLimb(judged, stuck(1)), null);
    const confirmation = confirmGoodLimb(judged, stuck(2));
    assert.equal(confirmation.focusJoint, 'right_shoulder');
    assert.match(confirmation.feedback, /right shoulder/);
    assert.match(confirmation.feedback, /good/i);
    // Already confirmed — move to the next unconfirmed good joint instead.
    const next = confirmGoodLimb(judged, stuck(2, new Set(['right_shoulder'])));
    assert.equal(next.focusJoint, 'left_hip');
    // Nothing left to confirm once every good joint already has been.
    assert.equal(confirmGoodLimb(judged, stuck(2, new Set(['right_shoulder', 'left_hip']))), null);
  });

  it('tracks a confirmed-good joint separately from corrections, and forgets it once it drifts back out', () => {
    let memory = emptyCoachMemory();
    memory = afterCoachObservation(
      memory,
      { status: 'confirm_good', focusJoint: 'right_shoulder', goodJoints: ['right_shoulder'] },
      "Your right shoulder is good — don't move it, keep it right where it is.",
    );
    assert.ok(memory.confirmedGoodJoints.has('right_shoulder'));
    assert.equal(memory.repeatStreak, 0); // confirmations never count toward the repeat-switch streak
    assert.equal(memory.spokenJoints.size, 0); // and never occupy a correction slot either

    // It drifted back out of tolerance — goodJoints no longer lists it — so the
    // next correction prunes the stale confirmation.
    memory = afterCoachObservation(
      memory,
      { status: 'adjust', focusJoint: 'left_wrist', goodJoints: [] },
      'Lift your left wrist.',
    );
    assert.equal(memory.confirmedGoodJoints.has('right_shoulder'), false);
  });
});

describe('agent instructions', () => {
  it('makes the call coach to the reference skeleton, then match, countdown, and snap', async () => {
    const source = await readFile(new URL('../agent.mjs', import.meta.url), 'utf8');
    const instructions = source.match(/const instructions = `([\s\S]*?)`;/)?.[1] ?? '';
    const greeting = source.match(/const greeting = '([^']+)';/)?.[1] ?? '';

    assert.match(instructions, /reference skeleton/);
    assert.match(instructions, /coach, then match, then countdown, then snap/);
    assert.match(instructions, /Do not wait for them to ask/);
    assert.match(instructions, /Do not tell them to say cheese first/);
    assert.doesNotMatch(instructions, /can say cheese/);
    assert.doesNotMatch(instructions, /ask if they want another/);
    assert.match(greeting, /count down and take the photo/);
    assert.doesNotMatch(greeting, /cheese/);
    assert.doesNotMatch(instructions, /Stay quiet|in frame/i);
    assert.match(instructions, /TOOL_SILENT/);
    assert.match(instructions, /Never invent a pose correction/i);
    assert.match(source, /LOOK_EVERY_MS = 4_000/);
    assert.match(source, /saveDebugSkeleton/);
    assert.match(source, /excludeJoints/);
    assert.match(source, /introDone/);
    assert.match(source, /introduction finished|introduction timeout/);
    assert.doesNotMatch(source, /lastFocusJoint = null;\s*\n\s*lastCue = '';\s*\n\s*const instruction/);
  });
});
