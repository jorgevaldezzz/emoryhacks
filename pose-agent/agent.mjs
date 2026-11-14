import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { takePhotoFromFrame, watchCallerCamera } from './caller_vision.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { cropFacetimeFrame, frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';

const LOOK_EVERY_MS = 8_000;
const READY_TTL_MS = 2_500;
const COUNTDOWN_MS = 3_200;
const SNAP_FRAMES = Math.round(FPS * 0.7);
const REPLAY_FRAMES = Math.round(FPS * 4);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Silent auto looks compare the caller to an internal sample skeleton. Cheese is the only visible snap.
const instructions = `You are a pose coach on a FaceTime video call. The caller sees your AI face, not a stick-figure overlay.
Always speak English only. Never switch languages.
Silent camera checks run in the background and compare their pose to an internal target. When you receive a pose cue, say only that cue in one short sentence, then stop. Do not say you took a photo for those cues. If a cue says they look ready, tell them they are ready and can say cheese for the photo.
Only take a real photo when they clearly say cheese, or clearly confirm they want a photo now (yes / take the photo / I'm ready after you asked). Then call the take_photo tool.
After a real photo, acknowledge it briefly and ask if they want another. If they say yes, tell them to say cheese when ready.
If they ask for guidance, call the guide_pose tool and say only that cue.
Never invent a correction that was not in a cue. Never mention files, messaging, or an on-screen skeleton.
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

    const latestCropped = () => {
      const photo = camera.latest();
      if (!photo) return null;
      return cropFacetimeFrame(photo);
    };

    /**
     * Ready-check now, unless a fresh check is already available.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const readyCheck = async (cropped) => {
      if (lastReady && Date.now() - lastReady.at < READY_TTL_MS) return lastReady;
      const result = await takePhotoFromFrame(cropped, { save: false });
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      return lastReady;
    };

    /**
     * Final snap only when someone is in frame.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const commitPhoto = async (cropped) => {
      const result = await takePhotoFromFrame(cropped, { save: true });
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      if (result.seen) {
        flashShutter();
        showCapture(cropped);
      }
      console.log(`[caller-vision] photo: seen=${result.seen} ready=${result.ready} cue=${result.cue ?? 'none'}${result.savedPath ? ` saved=${result.savedPath}` : ''}`);
      return result;
    };

    /**
     * Silent auto shutter: estimate caller pose vs internal sample skeleton.
     * No flash, preview, or save. Speaks when they need a cue or look ready.
     * @param {import('@livekit/rtc-node').VideoFrame} cropped
     */
    const silentLook = async (cropped) => {
      const result = await takePhotoFromFrame(cropped, { save: false });
      lastReady = { at: Date.now(), seen: result.seen, ready: result.ready, cue: result.cue };
      if (!result.seen) {
        console.log('[caller-vision] silent look: nobody in frame');
        return result;
      }
      if (!result.cue || result.cue === lastCue || speaking || busy) return result;
      lastCue = result.cue;
      console.log(`[caller-vision] silent look cue: ready=${result.ready} ${result.cue}`);
      const readyHint = result.ready
        ? 'They match the target pose well. Tell them they look ready and can say cheese for the photo.'
        : 'Coach them toward the target pose.';
      session.generateReply({
        instructions: `Speak English only. A silent pose check just compared them to the internal target pose (the caller did not see a shutter or a skeleton). ${readyHint} Say only this cue in one short sentence, then stop. Do not say you took a photo: ${result.cue}`,
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
            description: 'Compare the caller to the internal target pose and return one short guidance cue. Use when they ask for guidance, help posing, or how to line up.',
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
                  return { ok: true, message: 'Speak English only. Nobody is clearly in frame. Ask them to step into the camera so you can see them.' };
                }
                if (ready.ready) {
                  return {
                    ok: true,
                    message: `Speak English only. Say only this cue, then stop: ${ready.cue ?? 'You look lined up and ready — say cheese when you want the photo.'}`,
                  };
                }
                return {
                  ok: true,
                  message: `Speak English only. Say only this guidance cue, then stop: ${ready.cue ?? 'Adjust your stance a little to match the target pose.'}`,
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
            description: 'Run the cheese photo flow: ready-check, 3-2-1 countdown, then take and show the photo. Use only when they say cheese or clearly confirm they want a photo now.',
            execute: async () => {
              if (busy) return { ok: false, message: 'Already taking a photo. Wait a moment.' };
              const cropped = latestCropped();
              if (!cropped) {
                return { ok: false, message: 'No camera frame yet. Ask them to keep FaceTime Video on.' };
              }
              busy = true;
              try {
                const ready = await readyCheck(cropped);
                if (!ready.seen) {
                  return {
                    ok: false,
                    message: 'Speak English only. Do not take a photo. Nobody is in frame. Ask them to step into the camera, then say cheese again.',
                  };
                }

                // Visible 3-2-1 on the agent video. Do not await say() playout from inside
                // a tool (that can deadlock); speak once and sleep through the countdown.
                try {
                  session.say('Three. Two. One.', { allowInterruptions: false });
                } catch (error) {
                  console.warn('[caller-vision] countdown say failed', error instanceof Error ? error.message : error);
                }
                for (const digit of [3, 2, 1]) {
                  countdownDigit = digit;
                  await sleep(Math.floor(COUNTDOWN_MS / 3));
                }
                countdownDigit = 0;
                await sleep(150);

                const finalCrop = latestCropped();
                if (!finalCrop) {
                  return { ok: false, message: 'The camera dropped during countdown. Ask them to say cheese again.' };
                }
                const finalReady = await readyCheck(finalCrop);
                if (!finalReady.seen) {
                  return {
                    ok: false,
                    message: 'Speak English only. Do not save a photo. They left the frame during countdown. Ask them to get back in view and say cheese again.',
                  };
                }

                const result = await commitPhoto(finalCrop);
                if (!result.seen) {
                  // Should be rare after the second check; still do not treat as a keeper.
                  return {
                    ok: false,
                    message: 'Speak English only. Nobody was clearly in the final frame, so skip celebrating the photo and ask them to try cheese again.',
                  };
                }
                return {
                  ok: true,
                  message: `Speak English only. Acknowledge you took the photo and it is on FaceTime. Say: ${result.cue ?? 'Looking good.'}. Then ask if they want another. If yes, tell them to say cheese when ready.`,
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
