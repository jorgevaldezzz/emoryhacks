import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { takePhotoFromFrame, watchCallerCamera } from './caller_vision.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';

const LOOK_EVERY_MS = 8_000;
const SNAP_FRAMES = Math.round(FPS * 0.35);
const REPLAY_FRAMES = Math.round(FPS * 3);

// Grok Voice never gets pixels. Photos are taken on a timer (and on take_photo);
// each photo becomes one short cue the coach can say.
const instructions = `You are a pose coach on a FaceTime video call.
The caller sees your animated face. Photos of them are taken automatically every few seconds, and you are handed a short cue describing what they are doing.
Treat every cue as something you can see right now. Say the cue in one short sentence, then stop.
React to what the cue says: smiling, facing away, waving, posture, framing, and similar actions.
Never say you cannot see them, cannot see a file, cannot open a photo, or that messaging is missing.
Never invent a correction that was not in a cue.
If the caller asks a question, answer in one or two short sentences.
If they ask you to take a photo now, call the take_photo tool, then say only the tool's message.
Be clear that you are an AI.`;
const greeting = 'Greet the caller in one short sentence: say you are an AI pose coach and that you can already see them through the camera, then ask them to get into frame.';

export default defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session or sending video.
    const caller = await ctx.waitForParticipant();
    let camera = { latest: () => null, stop() {} };
    try {
      camera = watchCallerCamera(ctx.room, caller);
    } catch (error) {
      console.warn('[caller-vision] camera watch failed', error instanceof Error ? error.message : error);
    }

    // Video: one camera track, published by this agent. The Mac shows video only
    // from the participant that speaks, so the picture and the voice stay together.
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let tick = 0, speaking = false, looking = false, lastCue = '', announcedWait = false;
    let snapUntil = 0, replayUntil = 0, lookTimer;
    /** @type {Uint8Array | null} */
    let replayPixels = null;
    const frame = () => {
      const snapping = tick < snapUntil;
      const pixels = (tick < replayUntil && replayPixels)
        ? replayPixels
        : drawFace(tick, speaking, snapping);
      source.captureFrame(new VideoFrame(pixels, WIDTH, HEIGHT, VideoBufferType.RGBA));
      tick += 1;
    };
    frame();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(frame, 1000 / FPS);

    const flashShutter = () => { snapUntil = tick + SNAP_FRAMES; };
    const showCapture = (photo) => {
      try {
        replayPixels = frameToAgentRgba(photo, WIDTH, HEIGHT);
        replayUntil = tick + REPLAY_FRAMES;
      } catch (error) {
        console.warn('[caller-vision] could not preview capture', error instanceof Error ? error.message : error);
      }
    };

    const session = new voice.AgentSession({
      llm: new xai.realtime.RealtimeModel({ voice: 'leo' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });

    /**
     * @param {import('@livekit/rtc-node').VideoFrame} photo
     * @param {{ preview?: boolean }} [options]
     */
    const lookAtPhoto = async (photo, options = {}) => {
      flashShutter();
      if (options.preview) showCapture(photo);
      const result = await takePhotoFromFrame(photo);
      if (!result.cue || result.cue === lastCue || speaking) return result;
      lastCue = result.cue;
      console.log(`[caller-vision] cue: ${result.cue}${result.savedPath ? ` saved=${result.savedPath}` : ''}`);
      session.generateReply({
        instructions: `A new photo of the caller was just taken. You can see them. Say only this observation, in one short sentence: ${result.cue}`,
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
          take_photo: llm.tool({
            description: 'Take one photo of the caller right now, look at it, and return what you see. Use when they ask to take a photo or snap a picture.',
            execute: async () => {
              if (looking) {
                return { ok: false, message: 'Already looking. Wait a moment.' };
              }
              const photo = camera.latest();
              if (!photo) {
                console.log('[caller-vision] take_photo: no caller camera frame yet');
                return { ok: false, message: 'I do not have a camera frame yet. Keep FaceTime Video on and stay in front of the camera.' };
              }
              looking = true;
              try {
                const result = await lookAtPhoto(photo, { preview: true });
                return {
                  ok: result.ok,
                  message: result.cue ?? result.message,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn('[caller-vision] take_photo failed', message);
                return { ok: false, message: 'I could not check that photo. Try again in a moment.' };
              } finally {
                looking = false;
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
    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const stopGreeting = greetOnBridgeReady(ctx.room, () => session.generateReply({ instructions: greeting }));
    lookTimer = setInterval(() => {
      if (speaking || looking) return;
      const photo = camera.latest();
      if (!photo) {
        if (!announcedWait) {
          announcedWait = true;
          console.log('[caller-vision] no caller camera frame yet');
        }
        return;
      }
      looking = true;
      lookAtPhoto(photo).catch(error => {
        console.warn('[caller-vision] look failed', error instanceof Error ? error.message : error);
      }).finally(() => { looking = false; });
    }, LOOK_EVERY_MS);
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.AGENT_NAME || 'video-agent',
  // npm start prewarms a child process that must import this folder before it can take a call.
  // The default 10s limit expires when the project lives on /mnt/c in WSL. One child, two minutes.
  numIdleProcesses: 1,
  initializeProcessTimeout: 120_000,
}));
