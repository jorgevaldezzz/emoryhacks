import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { encodeFramePng, saveFrameCapture, takePhotoFromFrame, watchCallerCamera } from './caller_vision.mjs';
import { coachSpeech, nextCoachStep, noSpeech, photoAckSpeech, spokenCorrection } from './coach_flow.mjs';
import { saveDebugSkeleton } from './debug_skeleton.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { cropFacetimeFrame, frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { loadReferenceImage } from './reference_pose.mjs';
import { createPoseMatcher, extractPoseFromImage } from '../pose-matcher/src/index.mjs';

const LOOK_EVERY_MS = 4_000;
const READY_TTL_MS = 2_500;
const DIGIT_MS = 850;
const SNAP_FRAMES = Math.round(FPS * 0.9);
const REPLAY_FRAMES = Math.round(FPS * 4);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Call pipeline: coach to the reference skeleton → match → countdown → snap.
// Live frames are compared to that skeleton. The caller does not pick the correction or decide when they match.
const instructions = `You are a pose coach on a FaceTime video call. The caller sees your AI face.
Always speak English only. Never switch languages.
You run this call. The caller is matching their body to the reference pose. Do not wait for them to ask for help, choose a correction, or decide that they are lined up.
Each live frame is compared to the reference skeleton. The pipeline is coach, then match, then countdown, then snap.
When you get a pose cue, say "Okay" then only that one body correction in one short sentence, then stop. Never add a correction that was not in the cue. Never say you are looking at, checking, reviewing, or going back to an image, photo, snapshot, or camera frame.
When the live pose matches, the countdown and photo start on their own. Do not speak during that countdown. Do not tell them to say cheese first. Do not ask if they want the photo.
Only speak a new cue that names one joint, such as an elbow or a knee. If there is no new joint cue, produce no audio. Never tell them where to put their arms, legs, or feet.
If they say cheese anyway, call take_photo immediately with no spoken preamble before the tool.
After a real photo, acknowledge in one short sentence that you took it. If they want another, coach toward the reference pose again.
If they ask for guidance, call guide_pose and say "Okay" then only that cue.
If they ask for a score, call match_reference_pose when available and say only its feedback.
Never mention files, messaging, or skeletons.
Be clear that you are an AI.`;
const greeting = 'Greet in one short English sentence: say you will coach their body into the reference pose, and when it matches you will count down and take the photo.';

export default defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    const caller = await ctx.waitForParticipant();
    let camera = { latest: () => null, stop() {} };
    try {
      camera = watchCallerCamera(ctx.room, caller);
    } catch (error) {
      console.warn('[caller-vision] camera watch failed', error instanceof Error ? error.message : error);
    }

    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let tick = 0, speaking = false, busy = false, looking = false, lastCue = '', announcedWait = false, autoSnapArmed = true;
    let snapUntil = 0, replayUntil = 0, countdownDigit = 0, lookTimer;
    /** @type {{ at: number, seen: boolean, ready: boolean, cue: string | null } | null} */
    let lastReady = null;
    /** @type {Uint8Array | null} */
    let replayPixels = null;

    const frame = () => {
      const snapping = tick < snapUntil;
      const pixels = (!snapping && tick < replayUntil && replayPixels)
        ? replayPixels
        : drawFace(tick, speaking, snapping, countdownDigit);
      source.captureFrame(new VideoFrame(pixels, WIDTH, HEIGHT, VideoBufferType.RGBA));
      tick += 1;
    };
    frame();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(frame, 1000 / FPS);

    const flashShutter = () => { snapUntil = tick + SNAP_FRAMES; };
    const showCapture = (croppedFrame) => {
      try {
        replayPixels = frameToAgentRgba(croppedFrame, WIDTH, HEIGHT, { margins: { left: 0, right: 0, top: 0, bottom: 0 } });
        replayUntil = tick + SNAP_FRAMES + REPLAY_FRAMES;
      } catch (error) {
        console.warn('[caller-vision] could not preview capture', error instanceof Error ? error.message : error);
      }
    };

    const session = new voice.AgentSession({
      llm: new xai.realtime.RealtimeModel({ voice: 'leo' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });

    // Load the development reference from POSE_REFERENCE_IMAGE or reference-images/.
    // Coaching compares each live frame to that pose's skeleton, not the sample scaffold.
    // Do NOT await landmark extraction before session.start — xAI setReference takes ~20s and
    // the Mac ends the call if the agent is silent for 10s after bridge_ready.
    /** @type {string | null} */
    let referenceImage = null;
    /** @type {ReturnType<typeof createPoseMatcher> | undefined} */
    let poseMatcher;
    /** @type {Promise<void>} */
    const referenceReady = (async () => {
      try {
        const loaded = await loadReferenceImage();
        if (!loaded) {
          console.warn('[pose-matcher] no reference image in POSE_REFERENCE_IMAGE or reference-images/');
          return;
        }
        referenceImage = loaded.dataUrl;
        const matcher = createPoseMatcher({ extractPose: image => extractPoseFromImage(image) });
        await matcher.setReference(loaded.dataUrl);
        poseMatcher = matcher;
        console.log(`[pose-matcher] reference pose ready from ${loaded.path}`);
      } catch (error) {
        console.warn('[pose-matcher] reference pose unavailable', error instanceof Error ? error.message : error);
      }
    })();

    const latestCropped = () => {
      const photo = camera.latest();
      if (!photo) return null;
      return cropFacetimeFrame(photo);
    };

    /** Analyze the caller against the loaded reference pose (never the arms-out scaffold). */
    const analyzePose = (cropped) => takePhotoFromFrame(cropped, { save: false, referenceImage });

    /**
     * Compare the live frame to the reference skeleton. Vision is only the fallback
     * when landmark extraction is unavailable.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const judgeFrame = async (cropped) => {
      if (poseMatcher) {
        const encoded = await encodeFramePng(cropped);
        if (!encoded) return { status: 'unreadable', feedback: null, seen: false, ready: false, cue: null };
        const result = await poseMatcher.check(`data:image/png;base64,${encoded.base64Data}`);
        const seen = result.status !== 'person_not_visible' && result.status !== 'reference_missing';
        const ready = result.status === 'matched';
        if (result.status !== 'check_in_progress') {
          lastReady = { at: Date.now(), seen, ready, cue: result.feedback ?? null };
        }
        console.log(`[pose-matcher] coach status=${result.status}${result.score == null ? '' : ` score=${result.score}`}`);
        return {
          status: result.status,
          feedback: result.feedback ?? null,
          seen,
          ready,
          cue: result.feedback ?? null,
          landmarks: result.landmarks ?? null,
        };
      }
      if (!referenceImage) return { status: 'reference_missing', feedback: null, seen: false, ready: false, cue: null };
      const result = await analyzePose(cropped);
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      const status = result.ready ? 'matched' : (result.seen ? 'adjust' : 'person_not_visible');
      return { status, feedback: result.cue, seen: result.seen, ready: result.ready, cue: result.cue, landmarks: null };
    };

    /**
     * Flash, FaceTime still, and disk save. A skeleton tip is optional and never
     * runs on the auto-match path, so the countdown is not waiting on a second opinion.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     * @param {{ analyze?: boolean }} [options]
     */
    const commitPhoto = async (cropped, { analyze = true } = {}) => {
      flashShutter();
      showCapture(cropped);
      const saved = await saveFrameCapture(cropped);
      console.log(`[caller-vision] snap saved=${saved.savedPath ?? 'no'} ok=${saved.ok}`);

      /** @type {{ seen: boolean, ready: boolean, cue: string | null }} */
      let analysis = { seen: true, ready: true, cue: null };
      if (analyze) {
        try {
          if (poseMatcher) {
            const encoded = await encodeFramePng(cropped);
            if (encoded) {
              const compared = await poseMatcher.check(`data:image/png;base64,${encoded.base64Data}`);
              if (compared.status !== 'check_in_progress' && compared.status !== 'reference_missing') {
                analysis = {
                  seen: compared.status !== 'person_not_visible',
                  ready: compared.status === 'matched',
                  cue: compared.status === 'matched' ? null : (compared.feedback ?? null),
                };
                lastReady = { at: Date.now(), ...analysis };
              }
            }
          } else {
            const result = await analyzePose(cropped);
            analysis = { seen: result.seen, ready: result.ready, cue: result.ready ? null : result.cue };
            lastReady = { at: Date.now(), ...analysis };
          }
        } catch (error) {
          console.warn('[caller-vision] post-snap comparison failed', error instanceof Error ? error.message : error);
        }
      }
      return {
        ok: saved.ok,
        snapped: true,
        savedPath: saved.savedPath,
        ...analysis,
        message: analysis.cue ?? 'Photo taken.',
      };
    };

    /**
     * 3-2-1, then shutter. Do not await say() playout (tool deadlock risk).
     * @param {{ holdStill?: boolean, analyze?: boolean }} [options]
     */
    const countdownAndSave = async ({ holdStill = false, analyze = true } = {}) => {
      const cropped = latestCropped();
      if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
      // Refuse only when a fresh check already said the frame is empty — never wait on vision here.
      if (lastReady && Date.now() - lastReady.at < READY_TTL_MS && !lastReady.seen) {
        return {
          ok: false,
          message: 'Speak English only. Do not take a photo. Nobody is in frame. Ask them to step into the camera, then say cheese again.',
        };
      }

      busy = true;
      try {
        try {
          session.say(holdStill ? 'Hold still. Three. Two. One.' : 'Three. Two. One.', { allowInterruptions: false });
        } catch (error) {
          console.warn('[caller-vision] countdown say failed', error instanceof Error ? error.message : error);
        }
        for (const digit of [3, 2, 1]) {
          countdownDigit = digit;
          await sleep(DIGIT_MS);
        }
        countdownDigit = 0;

        const finalCrop = latestCropped();
        if (!finalCrop) return { ok: false, message: 'The camera dropped during countdown. Ask them to say cheese again.' };
        const result = await commitPhoto(finalCrop, { analyze });
        if (!result.savedPath) {
          return { ok: false, message: 'Speak English only. The shutter ran but the file did not save. Ask them to say cheese again.' };
        }
        const tip = result.ready ? null : spokenCorrection(result.cue);
        return {
          ok: true,
          message: tip
            ? `Speak English only. You already took the photo. Say Okay, then only this remaining difference, then stop: ${tip}`
            : photoAckSpeech(),
        };
      } catch (error) {
        countdownDigit = 0;
        console.warn('[caller-vision] take_photo failed', error instanceof Error ? error.message : error);
        return { ok: false, message: 'The photo flow failed. Ask them to say cheese again.' };
      } finally {
        countdownDigit = 0;
        busy = false;
      }
    };

    /**
     * Speak the skeleton difference, or count down and snap once the pose matches.
     * @param {Awaited<ReturnType<typeof judgeFrame>>} judged
     * @param {{ speak?: boolean, repeat?: boolean }} [options]
     */
    const followCoachStep = async (judged, { speak = false, repeat = false } = {}) => {
      // A spoken request may take another photo even while the auto loop is waiting out the last match.
      const step = nextCoachStep(judged, { autoSnapArmed: repeat || autoSnapArmed });
      if (step.action === 'snap') {
        if (busy || countdownDigit) return { ok: true, message: noSpeech };
        console.log('[caller-vision] reference matched — countdown and snap');
        const snap = await countdownAndSave({ holdStill: true, analyze: false });
        if (snap.ok) {
          autoSnapArmed = false;
          lastCue = '';
          if (speak) session.generateReply({ instructions: photoAckSpeech() });
        }
        return snap;
      }

      autoSnapArmed = step.autoSnapArmed;
      if (step.action !== 'coach' || !step.say) return { ok: true, message: noSpeech };
      if (!repeat && step.say === lastCue) return { ok: true, message: noSpeech };
      if (speak && (speaking || busy || countdownDigit)) return { ok: true, message: noSpeech };
      lastCue = step.say;
      const message = coachSpeech(step.say);
      if (speak) {
        console.log(`[caller-vision] coach cue: ${step.say}`);
        session.generateReply({ instructions: message });
      }
      return { ok: true, message };
    };

    /**
     * Silent auto look: compare the live frame to the reference skeleton.
     * A match counts down and snaps. A new joint gap is one spoken correction.
     * The still with the live skeleton is saved for testing and is not shown on the call.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const silentLook = async (cropped) => {
      if (!referenceImage && !poseMatcher) {
        console.log('[caller-vision] silent look skipped: no reference image');
        return { ok: false, message: 'No reference pose loaded.' };
      }
      const judged = await judgeFrame(cropped);
      try {
        const debugPath = await saveDebugSkeleton(cropped, judged.landmarks);
        if (debugPath) console.log(`[debug-skeleton] saved ${debugPath}`);
      } catch (error) {
        console.warn('[debug-skeleton] could not save test frame', error instanceof Error ? error.message : error);
      }
      if (judged.status === 'person_not_visible' || judged.status === 'insufficient_visibility') {
        console.log(`[caller-vision] silent look: ${judged.status} (not spoken)`);
      }
      return followCoachStep(judged, { speak: true, repeat: false });
    };

    ctx.addShutdownCallback(async () => {
      clearInterval(timer);
      clearTimeout(lookTimer);
      camera.stop();
      await session.close();
      await track.close();
      await source.close();
    });

    await session.start({
      room: ctx.room,
      agent: new voice.Agent({
        instructions,
        tools: {
          guide_pose: llm.tool({
            description: 'Compare the live frame to the reference skeleton and return the one correction that closes the gap. If they already match, the countdown and photo run inside this tool. Call when they ask for guidance. Do not wait for them to decide they are lined up.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already working. Wait a moment.' };
              await referenceReady;
              if (!referenceImage && !poseMatcher) {
                return { ok: false, message: 'Speak English only. Say you need a reference pose in reference-images before you can guide them.' };
              }
              const cropped = latestCropped();
              if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              let judged;
              busy = true;
              try {
                judged = await judgeFrame(cropped);
              } catch (error) {
                console.warn('[caller-vision] guide failed', error instanceof Error ? error.message : error);
                return { ok: false, message: 'Could not check the pose. Ask them to try again.' };
              } finally {
                busy = false;
              }
              return followCoachStep(judged, { speak: false, repeat: true });
            },
          }),
          take_photo: llm.tool({
            description: 'Count down and take the photo now. Call immediately when they say cheese. A reference-skeleton match already starts this countdown on its own, so do not call it just because they look close.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already taking a photo. Wait a moment.' };
              const snap = await countdownAndSave({ holdStill: false, analyze: true });
              if (snap.ok) autoSnapArmed = false;
              return snap;
            },
          }),
          match_reference_pose: llm.tool({
            description: 'Compare the live frame to the reference skeleton. Say only the returned difference. If they match, the countdown and photo run inside this tool.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already working. Wait a moment.' };
              await referenceReady;
              if (!poseMatcher && !referenceImage) {
                return { ok: false, message: 'Speak English only. Say you need a reference pose in reference-images before you can compare.' };
              }
              const cropped = latestCropped();
              if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              let judged;
              busy = true;
              try {
                judged = await judgeFrame(cropped);
              } catch (error) {
                console.warn('[pose-matcher] reference comparison failed', error instanceof Error ? error.message : error);
                return { ok: false, message: 'Could not compare with the reference pose. Ask them to try again.' };
              } finally { busy = false; }
              return followCoachStep(judged, { speak: false, repeat: true });
            },
          }),
        },
      }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false,
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });

    const stopGreeting = greetOnBridgeReady(ctx.room, () => session.generateReply({ instructions: greeting }));
    const runLook = async () => {
      if (busy || looking || countdownDigit) return null;
      const cropped = latestCropped();
      if (!cropped) {
        if (!announcedWait) {
          announcedWait = true;
          console.log('[caller-vision] no caller camera frame yet');
        }
        return null;
      }
      const started = Date.now();
      looking = true;
      try {
        await silentLook(cropped);
      } catch (error) {
        console.warn('[caller-vision] silent look failed', error instanceof Error ? error.message : error);
      } finally {
        looking = false;
      }
      return Math.max(0, LOOK_EVERY_MS - (Date.now() - started));
    };
    const armLook = (delay) => {
      clearTimeout(lookTimer);
      lookTimer = setTimeout(() => {
        runLook().then(wait => armLook(wait == null ? 1_500 : wait));
      }, delay);
    };
    // First comparison starts as soon as a frame is in, instead of waiting out the full interval.
    armLook(1_200);
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.AGENT_NAME || 'video-agent',
  numIdleProcesses: 1,
  initializeProcessTimeout: 120_000,
}));
