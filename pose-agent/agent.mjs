import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { encodeFramePng, takePhotoFromFrame, watchCallerCamera } from './caller_vision.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { createPoseMatcher, extractPoseFromImage } from '../pose-matcher/src/index.mjs';

const LOOK_EVERY_MS = 8_000;
const SNAP_FRAMES = Math.round(FPS * 0.7);
const REPLAY_FRAMES = Math.round(FPS * 4);

// Grok Voice never gets pixels. Photos are taken on a timer (and on take_photo);
// each photo is shown on FaceTime and becomes one short spoken cue.
const instructions = `You are a pose coach on a FaceTime video call.
Always speak English only. Never switch to Spanish or any other language, even if the video is blank, dark, or the camera is off.
The caller sees your animated face, a bright white flash when a photo is taken, then the photo itself on your video.
Photos are taken for them. When you are told a photo was taken, always acknowledge it in one short English sentence, mention what you noticed if a cue is given, then ask if they want more photos. Then stop.
If they say yes, more, another, keep going, or ask you to take a photo, call the take_photo tool.
If they ask to compare or check their pose against the reference photo, call check_pose. Give the returned correction briefly, one step at a time. Never invent a mismatch.
If the camera is off or the frame is empty, say so briefly in English and ask them to turn the camera back on. Do not apologize in another language.
Never say you cannot see a file, or that messaging is missing.
Never invent a correction that was not in a cue.
If they ask an unrelated question, answer in one or two short English sentences.
Be clear that you are an AI.`;
const greeting = 'Greet the caller in one short English sentence: say you are an AI pose coach, that you will take photos and show them on the call, and that you will ask before taking more after each one. Stay in English.';

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
    let tick = 0, speaking = false, looking = false, announcedWait = false;
    let snapUntil = 0, replayUntil = 0, lookTimer;
    // After each photo we ask before taking another. First auto look is allowed.
    let wantsMore = true;
    /** @type {Uint8Array | null} */
    let replayPixels = null;
    const frame = () => {
      const snapping = tick < snapUntil;
      const pixels = (!snapping && tick < replayUntil && replayPixels)
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
        // Start the still after the white flash finishes.
        replayUntil = tick + SNAP_FRAMES + REPLAY_FRAMES;
      } catch (error) {
        console.warn('[caller-vision] could not preview capture', error instanceof Error ? error.message : error);
      }
    };

    const session = new voice.AgentSession({
      llm: new xai.realtime.RealtimeModel({ voice: 'leo' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });

    // Reference-pose checks are a separate opt-in tool. The reference image is
    // configured locally; only normalized landmarks and feedback reach the voice model.
    let poseMatcher;
    if (process.env.POSE_REFERENCE_IMAGE) {
      try {
        const bytes = await readFile(process.env.POSE_REFERENCE_IMAGE);
        const extension = process.env.POSE_REFERENCE_IMAGE.toLowerCase().split('.').at(-1);
        const mime = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
        const reference = `data:${mime};base64,${bytes.toString('base64')}`;
        poseMatcher = createPoseMatcher({ extractPose: image => extractPoseFromImage(image) });
        await poseMatcher.setReference(reference);
        console.log('[pose-matcher] reference pose ready');
      } catch (error) {
        console.warn('[pose-matcher] reference pose unavailable', error instanceof Error ? error.message : error);
        poseMatcher = undefined;
      }
    }

    /**
     * Flash, show the frame on FaceTime, save, and ask vision for a cue.
     * @param {import('@livekit/rtc-node').VideoFrame} photo
     */
    const snapPhoto = async (photo) => {
      flashShutter();
      // Always show the frame on FaceTime, even when vision cannot describe it.
      showCapture(photo);
      const result = await takePhotoFromFrame(photo);
      wantsMore = false;
      const observation = result.cue
        ? result.cue
        : (result.seen === false
          ? 'Your camera looks off or I cannot see you in the frame'
          : 'I saved that shot');
      console.log(`[caller-vision] photo: ${observation}${result.savedPath ? ` saved=${result.savedPath}` : ''}`);
      return { ...result, observation };
    };

    /** @param {{ observation: string }} result */
    const announcePhoto = (result) => {
      session.generateReply({
        instructions: `Speak English only. You just took a photo and it is showing on your FaceTime video now. Acknowledge that you took the photo, then say this observation in the same short reply: ${result.observation}. Then ask if they want more photos. Do not mention files or folders. Never switch languages.`,
      });
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
            description: 'Take one photo of the caller right now, show it on FaceTime, and ask if they want more. Use when they ask for a photo, another photo, or say yes to more photos.',
            execute: async () => {
              if (looking) {
                return { ok: false, message: 'Already taking a photo. Wait a moment.' };
              }
              const photo = camera.latest();
              if (!photo) {
                console.log('[caller-vision] take_photo: no caller camera frame yet');
                return { ok: false, message: 'I do not have a camera frame yet. Keep FaceTime Video on and stay in front of the camera.' };
              }
              looking = true;
              try {
                const result = await snapPhoto(photo);
                return {
                  ok: result.ok,
                  message: `Speak English only. Acknowledge you took a photo and it is on FaceTime now. Say: ${result.observation}. Then ask if they want more photos. Never switch languages.`,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn('[caller-vision] take_photo failed', message);
                return { ok: false, message: 'I could not finish that photo. Ask them to try again.' };
              } finally {
                looking = false;
              }
            },
          }),
          ...(poseMatcher ? {
            check_pose: llm.tool({
              description: 'Compare the caller pose now with the configured reference photo. Use only when the caller asks to check or compare their pose.',
              execute: async () => {
                if (looking) return { ok: false, message: 'A photo check is already in progress. Wait a moment.' };
                const photo = camera.latest();
                if (!photo) return { ok: false, message: 'I do not have a camera frame yet. Keep FaceTime Video on and stay in frame.' };
                looking = true;
                try {
                  const encoded = await encodeFramePng(photo);
                  if (!encoded) return { ok: false, message: 'I could not read the camera frame. Please try again.' };
                  const result = await poseMatcher.check(`data:image/png;base64,${encoded.base64Data}`);
                  console.log(`[pose-matcher] ${result.status}${result.score === null ? '' : ` score=${result.score}`}`);
                  return { ok: result.ok, message: `Speak English only. Tell the caller: ${result.feedback}` };
                } catch (error) {
                  console.warn('[pose-matcher] check failed', error instanceof Error ? error.message : error);
                  return { ok: false, message: 'I could not compare the poses just now. Please try again.' };
                } finally { looking = false; }
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
    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const stopGreeting = greetOnBridgeReady(ctx.room, () => session.generateReply({ instructions: greeting }));
    lookTimer = setInterval(() => {
      if (!wantsMore || speaking || looking) return;
      const photo = camera.latest();
      if (!photo) {
        if (!announcedWait) {
          announcedWait = true;
          console.log('[caller-vision] no caller camera frame yet');
        }
        return;
      }
      looking = true;
      snapPhoto(photo).then(result => {
        announcePhoto(result);
      }).catch(error => {
        console.warn('[caller-vision] look failed', error instanceof Error ? error.message : error);
        wantsMore = false;
        flashShutter();
        showCapture(photo);
        session.generateReply({
          instructions: 'Speak English only. You just took a photo and it is showing on FaceTime. Acknowledge that you took it, say you could not describe it this time, then ask if they want more photos. Never switch languages.',
        });
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
