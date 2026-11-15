import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { nextCoachStep } from '../coach_flow.mjs';

describe('nextCoachStep', () => {
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

  it('coaches visibility gaps instead of treating them as a match', () => {
    const step = nextCoachStep({
      status: 'insufficient_visibility',
      ready: true,
      feedback: 'I cannot compare that pose reliably yet. Keep your arms and legs in frame.',
    }, { autoSnapArmed: true });
    assert.equal(step.action, 'coach');
    assert.match(step.say, /arms and legs in frame/);
    assert.equal(step.autoSnapArmed, true);
  });

  it('snaps a vision fallback only when that comparison says they match', () => {
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
  });
});
