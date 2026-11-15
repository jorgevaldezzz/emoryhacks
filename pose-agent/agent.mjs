import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { encodeFramePng, mirrorFrameHorizontally, saveFrameCapture, watchCallerCamera } from './caller_camera.mjs';
import {
  afterCoachObservation,
  coachSpeech,
  confirmGoodLimb,
  emptyCoachMemory,
  excludeJointsAfterRepeats,
  excludeJointsForCompare,
  nextCoachStep,
  noSpeech,
  photoAckSpeech,
  shouldSpeakPoseCue,
  spokenCorrection,
  trackStuckJoint,
} from './coach_flow.mjs';
import { saveDebugSkeleton } from './debug_skeleton.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { cropFacetimeFrame, frameToAgentRgba } from './frame_display.mjs';
import { uploadCaptureToGallery } from './gallery_upload.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { createGrokPoseCoach } from './grok_pose_coach.mjs';
import { loadReferenceImage } from './reference_pose.mjs';
import { comparePoseGeometry, createPoseMatcher, MediaPipePoseWorker } from '../pose-matcher/src/index.mjs';

const LOOK_EVERY_MS = 4_000;
const READY_TTL_MS = 2_500;
const DIGIT_MS = 850;
const SNAP_FRAMES = Math.round(FPS * 0.9);
const REPLAY_FRAMES = Math.round(FPS * 4);
const REFERENCE_PREVIEW_FRAMES = Math.round(FPS * 5);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Call pipeline: coach to the reference skeleton → match → countdown → snap.
// Live frames are compared to that skeleton. The caller does not pick the correction or decide when they match.
const instructions = `You are a pose coach on a FaceTime video call. The caller sees your AI face.
Always speak English only. Never switch languages.
Left and right always mean the caller's own anatomical sides. Never substitute the side where a limb appears on the screen.
You run this call. The caller is matching their body to the reference pose. Do not wait for them to ask for help, choose a correction, or decide that they are lined up.
Each live frame is compared to the reference skeleton. The pipeline is coach, then match, then countdown, then snap.
Pose corrections are spoken by the tools already. Never invent body corrections, never contradict a prior cue, and never tell them to put a hand down or up unless that exact line came from the tool.
A cue may instead say a limb is already good and to leave it where it is. Say exactly that, do not add a correction to it, and do not suggest moving that limb again until a later cue says otherwise.
When a tool result is exactly TOOL_SILENT, say nothing at all — do not narrate silence, do not say "no audio", do not apologize.
When you get a pose cue from a tool message, say "Okay" then give exactly the body correction and, if the cue includes one, the accuracy percentage — in one or two short sentences, then stop. Include the direction and relative target from the cue. Never add a correction that was not in the cue. Never say you are looking at, checking, reviewing, or going back to an image, photo, snapshot, or camera frame.
When the live pose fully matches, the countdown and photo start on their own. Do not speak during that countdown. Do not tell them to say cheese first. Do not ask if they want the photo in that case.
If a cue instead asks whether they want the picture now because the pose is merely close (not a full match), ask exactly that question and wait for their answer. If they say yes, call take_photo. If they want to keep adjusting, coach on the next cue as usual.
Only speak one detailed correction at a time. It may name the focus joint and a nearby target joint to make the placement clear. If there is no new joint cue, stay silent (TOOL_SILENT).
If they say cheese anyway, call take_photo immediately with no spoken preamble before the tool.
If they say they are happy with the current accuracy, content with it, or want the photo now even though a correction is still pending, call take_photo right away — do not talk them out of it or insist on a better match first.
After a real photo, acknowledge in one short sentence that you took it. If they want another, coach toward the reference pose again.
If they ask for guidance, call guide_pose. The tool speaks the cue; do not invent a joint correction. If the tool says the person or pose is not visible, give its brief step-into-frame instruction instead of inventing a joint correction.
If they ask for a score or how close they are, call match_reference_pose when available and say only its feedback, including the accuracy percentage it gives.
Never invent a pose correction.
Never mention files, messaging, or skeletons.
Be clear that you are an AI.`;
const greeting = 'Greet in one short English sentence: point out the reference pose now shown on screen, say you will coach their body to match it, and when it matches you will count down and take the photo.';

export default defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    const caller = await ctx.waitForParticipant();
    let camera = { latest: () => null, stop() {} };
    try {
      camera = watchCallerCamera(ctx.room, caller);
    } catch (error) {
      console.warn('[caller-camera] camera watch failed', error instanceof Error ? error.message : error);
    }

    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let tick = 0, speaking = false, busy = false, looking = false, announcedWait = false, autoSnapArmed = true;
    /** Block coach cues and auto-snaps until the bridge greeting has finished playing. */
    let introStarted = false;
    let introSpoken = false;
    let introDone = false;
    let coachMemory = emptyCoachMemory();
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
        console.warn('[caller-camera] could not preview capture', error instanceof Error ? error.message : error);
      }
    };

    const session = new voice.AgentSession({
      // Realtime voice for conversation; separate TTS so session.say() can play
      // coach cues without relying on generateReply (server VAD cancels those).
      llm: new xai.realtime.RealtimeModel({
        voice: 'leo',
        turnDetection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          create_response: true,
          interrupt_response: false,
        },
      }),
      tts: new xai.TTS({ voice: 'leo' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => {
      speaking = event.newState === 'speaking';
      if (introStarted && speaking) introSpoken = true;
      // Greeting finished: leave speaking after the intro turn started.
      if (introStarted && introSpoken && !introDone && event.oldState === 'speaking' && event.newState !== 'speaking') {
        introDone = true;
        console.log('[caller-camera] introduction finished — coaching unlocked');
      }
    });
    // Fallback: chert_bridge_ready has been observed missing on a room even while the
    // caller's mic was clearly live (real speech, real tool calls) — without this, a
    // missed signal silences every guide_pose cue for the whole call. The caller actually
    // talking to us is hard evidence the call is live, so unlock coaching on it too.
    session.on(voice.AgentSessionEventTypes.UserStateChanged, event => {
      if (!introDone && event.newState === 'speaking') {
        introStarted = true;
        introDone = true;
        console.log('[caller-camera] caller audio detected — coaching unlocked (bridge_ready fallback)');
      }
    });

    // Load the development reference from POSE_REFERENCE_IMAGE or reference-images/.
    // MediaPipe extracts this reference pose; live frames use the same model and comparator.
    // Do NOT await model initialization before session.start — callers need an immediate greeting.
    // the Mac ends the call if the agent is silent for 10s after bridge_ready.
    let referenceState = 'loading';
    let coachMode = 'geometry';
    let referenceUnavailableMessage = 'Speak English only. Say that a reference pose image must be loaded before you can guide them.';
    /** @type {ReturnType<typeof createPoseMatcher> | undefined} */
    let poseMatcher;
    const poseWorker = new MediaPipePoseWorker();
    /** @type {Promise<void>} */
    const referenceReady = (async () => {
      try {
        const loaded = await loadReferenceImage();
        if (!loaded) {
          referenceState = 'missing';
          referenceUnavailableMessage = 'Speak English only. Say that a reference pose image must be loaded before you can guide them.';
          console.warn('[pose-matcher] no reference image in POSE_REFERENCE_IMAGE or reference-images/');
          return;
        }
        // Show the target pose on the agent's video track at call start so the
        // caller can see which pose the automatic coach is matching.
        try {
          const imageBytes = Buffer.from(loaded.dataUrl.split(',')[1], 'base64');
          replayPixels = new Uint8Array(await sharp(imageBytes)
            .resize(WIDTH, HEIGHT, { fit: 'contain', background: '#102834' })
            .ensureAlpha().raw().toBuffer());
          replayUntil = tick + REFERENCE_PREVIEW_FRAMES;
        } catch (error) {
          console.warn('[pose-matcher] could not render reference preview', error instanceof Error ? error.message : error);
        }
        // Local geometry is the default coach — Grok vision was timing out mid-call.
        // Set POSE_COACH=grok to force the slower vision path.
        const useGrok = String(process.env.POSE_COACH || '').toLowerCase() === 'grok';
        coachMode = useGrok ? 'grok' : 'geometry';
        const grokCompare = useGrok ? createGrokPoseCoach() : null;
        const matcher = createPoseMatcher({
          extractPose: image => poseWorker.detect(image),
          comparePose: args => {
            // Geometry sticks on lastFocusJoint via shouldSpeakPoseCue, so rotating
            // excludeJoints every look spam-cycled "raise foot/knee/wrist" — only
            // force a different body part once the same joint(s) keep coming back.
            if (grokCompare) {
              return grokCompare({
                ...args,
                excludeJoints: excludeJointsForCompare(coachMemory.spokenJoints),
              });
            }
            return comparePoseGeometry({
              ...args,
              excludeJoints: excludeJointsAfterRepeats(coachMemory),
            });
          },
        });
        await matcher.setReference(loaded.dataUrl);
        poseMatcher = matcher;
        referenceState = 'ready';
        console.log(`[pose-matcher] reference pose ready from ${loaded.path} (coach=${coachMode})`);
      } catch (error) {
        referenceState = 'missing';
        const detail = error instanceof Error ? error.message : String(error);
        referenceUnavailableMessage = /reference photo|reference joints/i.test(detail)
          ? 'Speak English only. Say the reference photo needs to show a clear full-body pose, and ask them to choose another photo.'
          : 'Speak English only. Say the reference pose could not be loaded right now.';
        console.warn('[mediapipe] reference pose unavailable', detail);
      }
    })();

    const latestCropped = () => {
      const photo = camera.latest();
      if (!photo) return null;
      return cropFacetimeFrame(photo);
    };

    /**
     * Compare the live frame to the reference skeleton extracted by MediaPipe.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const judgeFrame = async (cropped) => {
      if (poseMatcher) {
        // The FaceTime caller feed is mirrored. Unmirror only the inference input
        // so MediaPipe's left/right landmarks match the unmirrored reference photo.
        const encoded = await encodeFramePng(cropped, { mirrorHorizontally: true });
        if (!encoded) return { status: 'unreadable', feedback: null, seen: false, ready: false, cue: null };
        const result = await poseMatcher.check(`data:image/png;base64,${encoded.base64Data}`);
        const seen = result.status !== 'person_not_visible' && result.status !== 'reference_missing';
        const ready = result.status === 'matched';
        if (result.status !== 'check_in_progress') {
          lastReady = { at: Date.now(), seen, ready, cue: result.feedback ?? null };
        }
        console.log(`[pose-matcher] coach status=${result.status}${result.coverage == null ? '' : ` coverage=${result.coverage}`}${result.score == null ? '' : ` score=${result.score}`}`);
        return {
          status: result.status,
          feedback: result.feedback ?? null,
          seen,
          ready,
          cue: result.feedback ?? null,
          focusJoint: result.focusJoint ?? null,
          landmarks: result.landmarks ?? null,
          goodJoints: result.goodJoints ?? [],
        };
      }
      return { status: referenceState === 'loading' ? 'reference_loading' : 'reference_missing', feedback: null, seen: false, ready: false, cue: null, landmarks: null, goodJoints: [] };
    };

    /**
     * Flash, FaceTime still, and disk save. Matching has already happened before
     * the auto-match path starts its countdown.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     * @param {{ analyze?: boolean }} [options]
     */
    const commitPhoto = async cropped => {
      flashShutter();
      showCapture(cropped);
      const saved = await saveFrameCapture(cropped);
      console.log(`[caller-camera] snap saved=${saved.savedPath ?? 'no'} ok=${saved.ok}`);

      if (saved.ok && saved.bytes) {
        try {
          // Gallery ingest uses the durable capture artifact as its source.
          const captureBytes = await readFile(saved.savedPath);
          const gallery = await uploadCaptureToGallery({
            bytes: captureBytes,
            mimeType: 'image/png',
            name: saved.savedPath ? saved.savedPath.split(/[\\/]/).pop() : undefined,
            note: 'Captured by Chert pose agent',
          });
          if (gallery.skipped) {
            console.log(`[gallery] ${gallery.message}`);
          } else if (gallery.ok) {
            console.log(`[gallery] uploaded item=${gallery.item?.id ?? 'ok'}`);
          } else {
            console.warn(`[gallery] ${gallery.message}`);
          }
        } catch (error) {
          console.warn('[gallery] upload failed', error instanceof Error ? error.message : error);
        }
      }

      return {
        ok: saved.ok,
        snapped: true,
        savedPath: saved.savedPath,
        seen: true,
        ready: true,
        cue: null,
        message: 'Photo taken.',
      };
    };

    /**
     * 3-2-1, then shutter. Do not await say() playout (tool deadlock risk).
     * @param {{ holdStill?: boolean }} [options]
     */
    const countdownAndSave = async ({ holdStill = false } = {}) => {
      const cropped = latestCropped();
      if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
      // Refuse only when a fresh MediaPipe check already said the frame is empty.
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
          console.warn('[caller-camera] countdown say failed', error instanceof Error ? error.message : error);
        }
        for (const digit of [3, 2, 1]) {
          countdownDigit = digit;
          await sleep(DIGIT_MS);
        }
        countdownDigit = 0;

        const finalCrop = latestCropped();
        if (!finalCrop) return { ok: false, message: 'The camera dropped during countdown. Ask them to say cheese again.' };
        const result = await commitPhoto(finalCrop);
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
        console.warn('[caller-camera] take_photo failed', error instanceof Error ? error.message : error);
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
      // Do not coach or auto-snap over the greeting.
      if (!introDone) return { ok: true, message: noSpeech };
      if (judged.status === 'person_not_visible' || judged.status === 'insufficient_visibility') {
        // Keep last cue / spoken joints — a brief visibility miss used to reset
        // memory and re-speak the same wrist tip on the next adjust.
        coachMemory = afterCoachObservation(coachMemory, judged, null);
        const instruction = judged.status === 'person_not_visible'
          ? 'Please step into frame so I can see your full body.'
          : 'Please step into frame with your arms and legs visible.';
        if (speak) {
          try {
            session.say(instruction, { allowInterruptions: false });
          } catch (error) {
            console.warn('[caller-camera] framing say failed', error instanceof Error ? error.message : error);
          }
          return { ok: true, message: noSpeech };
        }
        return { ok: true, message: instruction };
      }
      // Track every look, not just spoken ones — a stuck joint goes silent after
      // its first utterance (shouldSpeakPoseCue), so only counting spoken cues
      // would never notice it's been the worst joint look after look with nothing
      // new to say — that silently went mute for the rest of the call before this.
      coachMemory = { ...coachMemory, ...trackStuckJoint(coachMemory, judged.focusJoint) };
      // At the same moment coaching is about to force a switch off a stuck or
      // ping-ponging joint, confirm a limb that's already right first instead of
      // immediately piling on another correction. Only during ordinary coaching —
      // never preempt a real match or a "want the picture?" close offer with this.
      const confirmation = judged.status === 'adjust' ? confirmGoodLimb(judged, coachMemory) : null;
      const effectiveJudged = confirmation
        ? { ...judged, status: 'confirm_good', focusJoint: confirmation.focusJoint, feedback: confirmation.feedback, cue: confirmation.feedback }
        : judged;
      // A spoken request may take another photo even while the auto loop is waiting out the last match.
      const step = nextCoachStep(effectiveJudged, { autoSnapArmed: repeat || autoSnapArmed });
      if (step.action === 'snap') {
        if (busy || countdownDigit) return { ok: true, message: noSpeech };
        console.log('[caller-camera] reference matched — countdown and snap');
        const snap = await countdownAndSave({ holdStill: true });
        if (snap.ok) {
          autoSnapArmed = false;
          coachMemory = afterCoachObservation(coachMemory, { status: 'matched', ready: true }, null);
          if (speak) session.generateReply({ instructions: photoAckSpeech() });
        }
        return snap;
      }

      autoSnapArmed = step.autoSnapArmed;
      if (step.action !== 'coach' || !step.say) return { ok: true, message: noSpeech };
      // Same joint → stay quiet until they change it (or match). Passing the spoken
      // set here made geometry advance to a new body part every LOOK_EVERY_MS.
      if (!shouldSpeakPoseCue(effectiveJudged, coachMemory.lastFocusJoint)) {
        return { ok: true, message: noSpeech };
      }
      // Coalesced silent-look + guide_pose both get the same result; only one TTS.
      if (speak && step.say === coachMemory.lastCue) return { ok: true, message: noSpeech };
      if (!speak && !repeat && step.say === coachMemory.lastCue) return { ok: true, message: noSpeech };
      // Do not gate on `speaking` — the "one second" filler leaves speaking=true
      // and would swallow the real cue. busy/countdown still block.
      if (speak && (busy || countdownDigit)) return { ok: true, message: noSpeech };
      coachMemory = afterCoachObservation(coachMemory, effectiveJudged, step.say);
      const message = coachSpeech(step.say);
      if (speak) {
        // Speak via TTS (not generateReply): RealtimeModel server VAD ignores
        // allowInterruptions:false and cancels cue turns when the caller talks.
        console.log(`[caller-camera] coach cue: ${step.say}`);
        try {
          session.say(`Okay. ${step.say}`, { allowInterruptions: false });
        } catch (error) {
          console.warn('[caller-camera] coach say failed', error instanceof Error ? error.message : error);
        }
        return { ok: true, message: noSpeech };
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
      if (!poseMatcher) {
        console.log('[pose-matcher] silent look skipped: no usable reference pose');
        return { ok: false, message: 'No reference pose loaded.' };
      }
      const judged = await judgeFrame(cropped);
      try {
        // judgeFrame detects on the unmirrored (flopped) frame — draw onto the same
        // orientation, or every joint lands mirrored into the frame's padding.
        const unmirrored = await mirrorFrameHorizontally(cropped);
        const debugPath = await saveDebugSkeleton(unmirrored ?? cropped, judged.landmarks);
        if (debugPath) console.log(`[debug-skeleton] saved ${debugPath}`);
      } catch (error) {
        console.warn('[debug-skeleton] could not save test frame', error instanceof Error ? error.message : error);
      }
      if (judged.status === 'person_not_visible' || judged.status === 'insufficient_visibility') {
        console.log(`[caller-camera] silent look: ${judged.status} (not spoken)`);
      } else if (judged.status === 'visibility_glitch') {
        console.log('[caller-camera] silent look: visibility glitch (debounced, waiting for next look to confirm)');
      }
      return followCoachStep(judged, { speak: true, repeat: false });
    };

    ctx.addShutdownCallback(async () => {
      clearInterval(timer);
      clearTimeout(lookTimer);
      camera.stop();
      await poseWorker.close();
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
              if (!poseMatcher) {
                return { ok: false, message: referenceUnavailableMessage };
              }
              const cropped = latestCropped();
              if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              // Grok vision needs a filler; local geometry returns immediately.
              if (coachMode === 'grok') {
                try {
                  session.say('Okay, one second.', { allowInterruptions: false });
                } catch (error) {
                  console.warn('[caller-camera] guide filler failed', error instanceof Error ? error.message : error);
                }
              }
              let judged;
              busy = true;
              try {
                judged = await judgeFrame(cropped);
              } catch (error) {
                console.warn('[caller-camera] guide failed', error instanceof Error ? error.message : error);
                return { ok: false, message: 'Could not check the pose. Ask them to try again.' };
              } finally {
                busy = false;
              }
              // Speak the cue via TTS here — returning coachSpeech for the
              // realtime model often became silence after check_in_progress races.
              return followCoachStep(judged, { speak: true, repeat: true });
            },
          }),
          take_photo: llm.tool({
            description: 'Count down and take the photo now. Call immediately when they say cheese. A reference-skeleton match already starts this countdown on its own, so do not call it just because they look close.',
            execute: async () => {
              if (!introDone) return { ok: true, message: noSpeech };
              if (busy) return { ok: false, message: 'Already taking a photo. Wait a moment.' };
              const snap = await countdownAndSave({ holdStill: false });
              if (snap.ok) autoSnapArmed = false;
              return snap;
            },
          }),
          match_reference_pose: llm.tool({
            description: 'Compare the live frame to the reference skeleton. Say only the returned difference. If they match, the countdown and photo run inside this tool.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already working. Wait a moment.' };
              await referenceReady;
              if (!poseMatcher) {
                return { ok: false, message: referenceUnavailableMessage };
              }
              const cropped = latestCropped();
              if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              let judged;
              busy = true;
              try {
                judged = await judgeFrame(cropped);
              } catch (error) {
                console.warn('[mediapipe] reference comparison failed', error instanceof Error ? error.message : error);
                return { ok: false, message: 'Could not compare with the reference pose. Ask them to try again.' };
              } finally { busy = false; }
              return followCoachStep(judged, { speak: true, repeat: true });
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

    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      introStarted = true;
      // Failsafe: if state events miss the end of the greeting, unlock coaching anyway.
      setTimeout(() => {
        if (!introDone) {
          introDone = true;
          console.log('[caller-camera] introduction timeout — coaching unlocked');
        }
      }, 8_000);
      session.generateReply({ instructions: greeting });
    });
    const runLook = async () => {
      if (!introDone || busy || looking || countdownDigit) return null;
      const cropped = latestCropped();
      if (!cropped) {
        if (!announcedWait) {
          announcedWait = true;
          console.log('[caller-camera] no caller camera frame yet');
        }
        return null;
      }
      const started = Date.now();
      looking = true;
      try {
        await silentLook(cropped);
      } catch (error) {
        console.warn('[caller-camera] silent look failed', error instanceof Error ? error.message : error);
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
    // Poll for introDone; first real compare waits until the greeting has finished.
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
