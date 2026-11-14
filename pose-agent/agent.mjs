import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { encodeFramePng, saveFrameCapture, takePhotoFromFrame, watchCallerCamera } from './caller_vision.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { cropFacetimeFrame, frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { createLoadedPoseMatcher } from './reference.mjs';

const LOOK_EVERY_MS = 8_000;
const READY_TTL_MS = 2_500;
const DIGIT_MS = 850;
const SNAP_FRAMES = Math.round(FPS * 0.9);
const REPLAY_FRAMES = Math.round(FPS * 4);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Guidance compares the caller to a reference photo via pose-matcher.
// Cheese snaps immediately — vision never blocks the shutter.
const instructions = `You are a pose coach on a FaceTime video call. The caller sees your AI face.
Always speak English only. Never switch languages.
When you get a pose cue, say "Okay" then only that body tip in one short sentence. Never say you are looking at, checking, reviewing, or going back to an image, photo, snapshot, or camera frame.
If a cue says they look ready, tell them they are ready and can say cheese.
When they say cheese (or clearly confirm a photo now), call take_photo immediately with no spoken preamble before the tool.
After a real photo, acknowledge briefly that you took it and ask if they want another. If yes, tell them to say cheese when ready.
If they ask for guidance, call guide_pose and say "Okay" then only that cue.
Never invent a correction that was not in a cue. Never mention files, messaging, or skeletons.
Be clear that you are an AI.`;
const greeting = 'Greet in one short English sentence: say they can ask for guidance, you will help them match the reference pose, and to say cheese for a three-two-one countdown before a photo.';

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

    /** @type {Awaited<ReturnType<typeof createLoadedPoseMatcher>>['matcher'] | null} */
    let poseMatcher = null;
    try {
      const loaded = await createLoadedPoseMatcher();
      poseMatcher = loaded.matcher;
      console.log(`[pose-matcher] reference ready via ${loaded.source} (${loaded.imagePath})`);
    } catch (error) {
      console.warn('[pose-matcher] reference unavailable', error instanceof Error ? error.message : error);
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

    const latestCropped = () => {
      const photo = camera.latest();
      if (!photo) return null;
      return cropFacetimeFrame(photo);
    };

    /**
     * Compare the caller frame to the loaded reference pose.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const compareToReference = async (cropped) => {
      if (!poseMatcher) {
        const result = await takePhotoFromFrame(cropped, { save: false });
        return {
          seen: result.seen,
          ready: result.ready,
          cue: result.cue,
          status: result.seen ? (result.ready ? 'matched' : 'adjust') : 'person_not_visible',
        };
      }
      const encoded = await encodeFramePng(cropped);
      if (!encoded) {
        return { seen: false, ready: false, cue: null, status: 'encode_failed' };
      }
      const result = await poseMatcher.check(`data:image/png;base64,${encoded.base64Data}`);
      const seen = result.status !== 'person_not_visible' && result.status !== 'reference_missing';
      return {
        seen,
        ready: result.ready === true || result.status === 'matched',
        cue: result.feedback ?? null,
        status: result.status,
        score: result.score ?? null,
      };
    };

    /**
     * Analyze-only pose check. Never used to gate the cheese shutter.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const readyCheck = async (cropped) => {
      if (lastReady && Date.now() - lastReady.at < READY_TTL_MS) return lastReady;
      const result = await compareToReference(cropped);
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      return lastReady;
    };

    /**
     * Cheese snap: flash + FaceTime still + disk save first. Pose tip after.
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
        const result = await compareToReference(cropped);
        analysis = { seen: result.seen, ready: result.ready, cue: result.cue };
        lastReady = { at: Date.now(), ...analysis };
      } catch (error) {
        console.warn('[caller-vision] post-snap compare failed', error instanceof Error ? error.message : error);
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
     * Silent auto look against the reference pose. No flash, preview, or save.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const silentLook = async (cropped) => {
      const result = await compareToReference(cropped);
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
            description: 'Compare the caller to the reference pose and return one short guidance cue. Use when they ask for guidance, help posing, or how to line up.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already working. Wait a moment.' };
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
                  message: `Speak English only. Say Okay, then only this tip, then stop. Never mention looking at an image: ${ready.cue ?? 'Shift your stance a little to match the reference pose.'}`,
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
              if (lastReady && Date.now() - lastReady.at < READY_TTL_MS && !lastReady.seen) {
                return {
                  ok: false,
                  message: 'Speak English only. Do not take a photo. Nobody is in frame. Ask them to step into the camera, then say cheese again.',
                };
              }

              busy = true;
              try {
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
