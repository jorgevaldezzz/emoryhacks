import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPARE_TIMEOUT_MS,
  createGrokPoseCoach,
  GROK_POSE_ENDPOINT,
  IMAGE_DETAIL,
  validateGrokPoseResult,
} from '../grok_pose_coach.mjs';

const point = (x, y) => ({ x, y, confidence: 0.95 });
const pose = (shift = 0) => ({ personVisible: true, landmarks: {
  nose: point(0.5, 0.1), left_shoulder: point(0.4, 0.25), right_shoulder: point(0.6, 0.25),
  left_elbow: point(0.3, 0.4), right_elbow: point(0.7, 0.4),
  left_wrist: point(0.2 + shift, 0.5), right_wrist: point(0.8, 0.5),
  left_hip: point(0.43, 0.55), right_hip: point(0.57, 0.55),
  left_knee: point(0.4, 0.75), right_knee: point(0.6, 0.75),
  left_ankle: point(0.38, 0.95), right_ankle: point(0.62, 0.95),
} });
const response = (payload, options = {}) => ({
  ok: options.ok ?? true,
  status: options.status ?? 200,
  statusText: options.statusText ?? 'failed',
  json: async () => payload,
});
const output = value => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

describe('Grok pose coaching', () => {
  it('sends only two labeled skeleton overlays with storage disabled and returns one detailed cue', async () => {
    let request;
    const coach = createGrokPoseCoach({
      apiKey: 'test-key', model: 'grok-4.7-test',
      fetchImpl: async (url, options) => { request = { url, ...options, body: JSON.parse(options.body) }; return response(output({ status: 'adjust', focus_joint: 'left_wrist', cue: 'Move your left wrist beside your left temple.' })); },
    });
    const result = await coach({ reference: pose(), current: pose(0.1) });
    assert.equal(request.url, GROK_POSE_ENDPOINT);
    assert.equal(request.body.store, false);
    assert.equal(request.body.model, 'grok-4.7-test');
    assert.deepEqual(request.body.reasoning, { effort: 'low' });
    const content = request.body.input[0].content;
    const images = content.filter(item => item.type === 'input_image');
    assert.equal(images.length, 2);
    assert.ok(images.every(item => item.image_url.startsWith('data:image/png;base64,')));
    assert.ok(images.every(item => item.detail === IMAGE_DETAIL));
    assert.equal(IMAGE_DETAIL, 'low');
    assert.ok(COMPARE_TIMEOUT_MS <= 20_000);
    assert.match(content.find(item => item.type === 'input_text').text, /skeleton overlays/i);
    assert.match(content.find(item => item.type === 'input_text').text, /own anatomical sides/i);
    assert.match(content.find(item => item.type === 'input_text').text, /never the side of the screen/i);
    assert.match(content.find(item => item.type === 'input_text').text, /overlapping visible joints/i);
    assert.match(content.find(item => item.type === 'input_text').text, /stance|feet|torso|hips/i);
    assert.doesNotMatch(content.find(item => item.type === 'input_text').text, /left wrist beside their head/);
    assert.equal(request.body.text.format.type, 'json_schema');
    assert.equal(result.status, 'adjust');
    assert.equal(result.focusJoint, 'left_wrist');
    assert.equal(result.feedback, 'Move your left wrist beside your left temple.');
  });

  it('asks Grok to skip already-spoken joints so coaching advances past the wrist', async () => {
    let request;
    const coach = createGrokPoseCoach({
      apiKey: 'test-key', model: 'grok-4.7-test',
      fetchImpl: async (url, options) => {
        request = { url, ...options, body: JSON.parse(options.body) };
        return response(output({
          status: 'adjust',
          focus_joint: 'left_ankle',
          cue: 'Step your left foot farther out to widen your stance.',
        }));
      },
    });
    const result = await coach({
      reference: pose(),
      current: pose(0.1),
      excludeJoints: ['right_wrist', 'right_elbow'],
    });
    const text = request.body.input[0].content.find(item => item.type === 'input_text').text;
    assert.match(text, /right_wrist/);
    assert.match(text, /right_elbow/);
    assert.match(text, /already coached|do not choose|exclude|skip/i);
    assert.equal(result.focusJoint, 'left_ankle');
  });

  it('accepts a matched result and never invents a cue', () => {
    assert.deepEqual(validateGrokPoseResult({ status: 'matched', focus_joint: 'none', cue: null }), {
      ok: true, status: 'matched', focusJoint: null, feedback: 'Your pose matches the reference. Hold still for the photo.',
    });
  });

  it('turns uncertainty into a no-cue result', () => {
    assert.deepEqual(validateGrokPoseResult({ status: 'uncertain', focus_joint: 'none', cue: null }), {
      ok: false, status: 'comparison_uncertain', focusJoint: null, feedback: null,
    });
  });

  it('rejects malformed or inconsistent results', () => {
    assert.throws(() => validateGrokPoseResult({ status: 'adjust', focus_joint: 'none', cue: 'Move your hand up.' }), /unusable/);
    assert.throws(() => validateGrokPoseResult({ status: 'matched', focus_joint: 'left_elbow', cue: null }), /inconsistent/);
  });

  it('surfaces malformed model text and API errors', async () => {
    const malformed = createGrokPoseCoach({ apiKey: 'test', fetchImpl: async () => response(output({ nope: true })) });
    await assert.rejects(malformed({ reference: pose(), current: pose() }), /invalid pose comparison/);
    const failed = createGrokPoseCoach({ apiKey: 'test', fetchImpl: async () => response({ error: { message: 'quota exhausted' } }, { ok: false, status: 429 }) });
    await assert.rejects(failed({ reference: pose(), current: pose() }), /429.*quota exhausted/);
  });

  it('reuses the reference overlay across compares so only the live frame is re-rendered', async () => {
    let renders = 0;
    const coach = createGrokPoseCoach({
      apiKey: 'test-key',
      renderOverlay: async (poseInput) => {
        renders += 1;
        return `data:image/png;base64,overlay-${renders}-${poseInput.landmarks.left_wrist.x}`;
      },
      fetchImpl: async () => response(output({
        status: 'adjust',
        focus_joint: 'left_ankle',
        cue: 'Step your left foot farther out to widen your stance.',
      })),
    });
    const reference = pose();
    await coach({ reference, current: pose(0.05) });
    await coach({ reference, current: pose(0.12) });
    // 1 reference + 2 live frames (not 2+2).
    assert.equal(renders, 3);
  });
});
