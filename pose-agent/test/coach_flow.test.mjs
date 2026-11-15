import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  afterCoachObservation,
  excludeJointsForCompare,
  nextCoachStep,
  shouldSpeakPoseCue,
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
