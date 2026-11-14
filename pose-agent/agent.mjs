import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { encodeFramePng, saveFrameCapture, takePhotoFromFrame, watchCallerCamera } from './caller_vision.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { cropFacetimeFrame, frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { loadReferenceImage } from './reference_pose.mjs';
import { createPoseMatcher, extractPoseFromImage } from '../pose-matcher/src/index.mjs';

const LOOK_EVERY_MS = 8_000;
const READY_TTL_MS = 2_500;
const DIGIT_MS = 850;
const SNAP_FRAMES = Math.round(FPS * 0.9);
const REPLAY_FRAMES = Math.round(FPS * 4);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Silent looks and guide_pose coach toward the loaded reference image — never the arms-out scaffold.
const instructions = `You are a pose coach on a FaceTime video call. The caller sees your AI face.
Always speak English only. Never switch languages.
When you get a pose cue, say "Okay" then only that body tip in one short sentence. Never say you are looking at, checking, reviewing, or going back to an image, photo, snapshot, or camera frame.
If a cue says they look ready, tell them they are ready and can say cheese.
When they say cheese (or clearly confirm a photo now), call take_photo immediately with no spoken preamble before the tool.
After a real photo, acknowledge briefly that you took it and ask if they want another. If yes, tell them to say cheese when ready.
If they ask for guidance, help posing, how to line up, or to match the target/reference pose, call guide_pose and say "Okay" then only that cue.
If they ask to score or compare against the reference, call match_reference_pose when available and say only its feedback.
Never invent a correction that was not in a cue. Never mention files, messaging, or skeletons.
Be clear that you are an AI.`;
const greeting = 'Greet in one short English sentence: say they can ask for guidance, you will help them match the target pose, and to say cheese for a three-two-one countdown before a photo.';

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
    let tick = 0, speaking = false, busy = false, looking = false, lastCue = '', announcedWait = false;
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
    // All coaching (silent looks + guide_pose) targets that pose, not the sample scaffold.
    /** @type {string | null} */
    let referenceImage = null;
    let poseMatcher;
    try {
      const loaded = await loadReferenceImage();
      if (loaded) {
        referenceImage = loaded.dataUrl;
        poseMatcher = createPoseMatcher({ extractPose: image => extractPoseFromImage(image) });
        await poseMatcher.setReference(loaded.dataUrl);
        console.log(`[pose-matcher] reference pose ready from ${loaded.path}`);
      } else {
        console.warn('[pose-matcher] no reference image in POSE_REFERENCE_IMAGE or reference-images/');
      }
    } catch (error) {
      console.warn('[pose-matcher] reference pose unavailable', error instanceof Error ? error.message : error);
    }

    const latestCropped = () => {
      const photo = camera.latest();
      if (!photo) return null;
      return cropFacetimeFrame(photo);
    };

    /** Analyze the caller against the loaded reference pose (never the arms-out scaffold). */
    const analyzePose = (cropped) => takePhotoFromFrame(cropped, { save: false, referenceImage });

    /**
     * Analyze-only pose check. Never used to gate the cheese shutter.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const readyCheck = async (cropped) => {
      if (lastReady && Date.now() - lastReady.at < READY_TTL_MS) return lastReady;
      const result = await analyzePose(cropped);
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      return lastReady;
    };

    /**
     * Cheese snap: flash + FaceTime still + disk save first. Vision runs after for a tip.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const commitPhoto = async (cropped) => {
      flashShutter();
      showCapture(cropped);
      const saved = await saveFrameCapture(cropped);
      console.log(`[caller-vision] snap saved=${saved.savedPath ?? 'no'} ok=${saved.ok}`);

      /** @type {{ seen: boolean, ready: boolean, cue: string | null }} */
      let analysis = { seen: true, ready: false, cue: null };
      try {
        const result = await analyzePose(cropped);
        analysis = { seen: result.seen, ready: result.ready, cue: result.cue };
        lastReady = { at: Date.now(), ...analysis };
      } catch (error) {
        console.warn('[caller-vision] post-snap vision failed', error instanceof Error ? error.message : error);
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
     * Silent auto look: pose tip only. No flash, preview, or save.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const silentLook = async (cropped) => {
      if (!referenceImage) {
        console.log('[caller-vision] silent look skipped: no reference image');
        return { ok: false, seen: false, ready: false, cue: null, message: 'No reference pose loaded.' };
      }
      const result = await analyzePose(cropped);
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      if (!result.seen) {
        console.log('[caller-vision] silent look: nobody in frame');
        return result;
      }
      if (!result.cue || result.cue === lastCue || speaking || busy) return result;
      lastCue = result.cue;
      console.log(`[caller-vision] silent look cue: ready=${result.ready} ${result.cue}`);
      session.generateReply({
        instructions: `Speak English only. Say "Okay," then only this pose tip in one short sentence, then stop. Never say you looked at, checked, reviewed, or went back to an image or photo: ${result.cue}`,
      });
      return result;
    };

    ctx.addShutdownCallback(async () => {
      clearInterval(timer);
      clearInterval(lookTimer);
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
            description: 'Compare the caller to the loaded reference pose and return one short guidance cue. Use when they ask for guidance, help posing, how to line up, or to match the target pose.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already working. Wait a moment.' };
              if (!referenceImage) {
                return { ok: false, message: 'Speak English only. Say you need a reference pose in reference-images before you can guide them.' };
              }
              const cropped = latestCropped();
              if (!cropped) {
                return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              }
              busy = true;
              try {
                const ready = await readyCheck(cropped);
                if (!ready.seen) {
                  return { ok: true, message: 'Speak English only. Say Okay, then ask them to step into the camera so you can see them.' };
                }
                return {
                  ok: true,
                  message: `Speak English only. Say Okay, then only this tip, then stop. Never mention looking at an image: ${ready.cue ?? 'Shift your stance a little to match the target pose.'}`,
                };
              } catch (error) {
                console.warn('[caller-vision] guide failed', error instanceof Error ? error.message : error);
                return { ok: false, message: 'Could not check the pose. Ask them to try again.' };
              } finally {
                busy = false;
              }
            },
          }),
          take_photo: llm.tool({
            description: 'Start the cheese photo immediately: 3-2-1 on screen, then shutter flash, show the still on FaceTime, and save it. Call right away when they say cheese — no preamble.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already taking a photo. Wait a moment.' };
              const cropped = latestCropped();
              if (!cropped) {
                return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              }
              // Refuse only when a fresh check already said the frame is empty — never wait on vision here.
              if (lastReady && Date.now() - lastReady.at < READY_TTL_MS && !lastReady.seen) {
                return {
                  ok: false,
                  message: 'Speak English only. Do not take a photo. Nobody is in frame. Ask them to step into the camera, then say cheese again.',
                };
              }

              busy = true;
              try {
                // Countdown starts now. Do not await say() playout (tool deadlock risk).
                try {
                  session.say('Three. Two. One.', { allowInterruptions: false });
                } catch (error) {
                  console.warn('[caller-vision] countdown say failed', error instanceof Error ? error.message : error);
                }
                for (const digit of [3, 2, 1]) {
                  countdownDigit = digit;
                  await sleep(DIGIT_MS);
                }
                countdownDigit = 0;

                const finalCrop = latestCropped();
                if (!finalCrop) {
                  return { ok: false, message: 'The camera dropped during countdown. Ask them to say cheese again.' };
                }

                // Shutter + preview + disk save happen before any vision call.
                const result = await commitPhoto(finalCrop);
                if (!result.savedPath) {
                  return {
                    ok: false,
                    message: 'Speak English only. The shutter ran but the file did not save. Ask them to say cheese again.',
                  };
                }
                return {
                  ok: true,
                  message: `Speak English only. You already took the photo — it flashed and is on FaceTime. Acknowledge briefly. If there is a tip, say Okay then only: ${result.cue ?? 'Looking good.'}. Then ask if they want another. Never say you looked back at an image.`,
                };
              } catch (error) {
                countdownDigit = 0;
                console.warn('[caller-vision] take_photo failed', error instanceof Error ? error.message : error);
                return { ok: false, message: 'The photo flow failed. Ask them to say cheese again.' };
              } finally {
                countdownDigit = 0;
                busy = false;
              }
            },
          }),
          ...(poseMatcher ? {
            match_reference_pose: llm.tool({
              description: 'Score the caller against the loaded reference pose with landmark angles. Use when they ask for a score or a reference comparison; prefer guide_pose for normal coaching tips.',
              execute: async () => {
                if (busy) return { ok: false, message: 'Already working. Wait a moment.' };
                const cropped = latestCropped();
                if (!cropped) return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
                busy = true;
                try {
                  const encoded = await encodeFramePng(cropped);
                  if (!encoded) return { ok: false, message: 'I could not read the camera frame. Please try again.' };
                  const result = await poseMatcher.check(`data:image/png;base64,${encoded.base64Data}`);
                  console.log(`[pose-matcher] ${result.status}${result.score === null ? '' : ` score=${result.score}`}`);
                  return { ok: result.ok, message: `Speak English only. Say only this reference-pose feedback: ${result.feedback}` };
                } catch (error) {
                  console.warn('[pose-matcher] reference comparison failed', error instanceof Error ? error.message : error);
                  return { ok: false, message: 'Could not compare with the reference pose. Ask them to try again.' };
                } finally { busy = false; }
              },
            }),
          } : {}),
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
    lookTimer = setInterval(() => {
      if (busy || looking || speaking || countdownDigit) return;
      const cropped = latestCropped();
      if (!cropped) {
        if (!announcedWait) {
          announcedWait = true;
          console.log('[caller-vision] no caller camera frame yet');
        }
        return;
      }
      looking = true;
      silentLook(cropped).catch(error => {
        console.warn('[caller-vision] silent look failed', error instanceof Error ? error.message : error);
      }).finally(() => { looking = false; });
    }, LOOK_EVERY_MS);
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.AGENT_NAME || 'video-agent',
  numIdleProcesses: 1,
  initializeProcessTimeout: 120_000,
}));
