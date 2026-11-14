import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { sendPhotoOverText } from './chert_send.mjs';
import { encodeFramePng, saveCapturePng, watchCallerCamera } from './caller_vision.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { frameToAgentRgba } from './frame_display.mjs';
import { greetOnBridgeReady } from './greet.mjs';

const SNAP_FRAMES = Math.round(FPS * 0.35);
const REPLAY_FRAMES = Math.round(FPS * 3);

// Camera watch + capture stay on always: later the bot will auto-snap once the
// caller matches a reference skeleton, after a countdown. For now, voice triggers
// the same capture path and texts the photo back over iMessage.
const instructions = `You are a pose coach on a FaceTime video call.
The caller sees your animated face, and briefly sees the photo you just took after a snap.
You cannot see the camera yourself. When the caller asks you to take a photo, snap a picture, look at them, check their pose, or says they are ready, call the take_photo tool.
After take_photo returns, say only the tool's message in one short sentence, then stop.
Do not take a photo unless they ask, or clearly say they are ready for one.
If they ask a question unrelated to a photo, answer in one or two short sentences.
Be clear that you are an AI.`;
const greeting = 'Greet the caller in one short sentence: say you are an AI pose coach and tell them to say "take a photo" when they are ready.';

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
    let tick = 0, speaking = false, snapUntil = 0, replayUntil = 0, takingPhoto = false;
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
    const showCapture = (pixels) => {
      replayPixels = pixels;
      replayUntil = tick + REPLAY_FRAMES;
    };

    const session = new voice.AgentSession({
      llm: new xai.realtime.RealtimeModel({ voice: 'leo' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });
    ctx.addShutdownCallback(async () => {
      clearInterval(timer);
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
            description: 'Take one photo of the caller on FaceTime, show it briefly on your video, and text it back over iMessage. Use when they ask to take a photo, snap a picture, look at them, check their pose, or say they are ready.',
            execute: async () => {
              if (takingPhoto) {
                return { ok: false, message: 'Already taking a photo. Wait a moment.' };
              }
              const photo = camera.latest();
              if (!photo) {
                console.log('[caller-vision] take_photo: no caller camera frame yet');
                return {
                  ok: false,
                  message: 'No camera frame yet. Ask them to keep FaceTime Video on and face the camera.',
                };
              }
              takingPhoto = true;
              flashShutter();
              try {
                const encoded = await encodeFramePng(photo);
                if (!encoded) {
                  return { ok: false, message: 'Could not encode the camera frame. Ask them to try again.' };
                }
                let savedPath;
                try {
                  savedPath = await saveCapturePng(encoded.bytes);
                } catch (error) {
                  console.warn('[caller-vision] could not save capture', error instanceof Error ? error.message : error);
                }
                try {
                  showCapture(frameToAgentRgba(photo, WIDTH, HEIGHT));
                } catch (error) {
                  console.warn('[caller-vision] could not preview capture', error instanceof Error ? error.message : error);
                }

                const sent = await sendPhotoOverText({
                  bytes: encoded.bytes,
                  caption: 'Here is the pose photo I just took on FaceTime.',
                });
                console.log(`[caller-vision] take_photo: send=${sent.channel} ok=${sent.ok}${savedPath ? ` saved=${savedPath}` : ''}`);
                if (sent.ok) {
                  return {
                    ok: true,
                    message: sent.channel === 'imessage-media'
                      ? 'Photo taken and sent to you over text.'
                      : 'Photo taken. I texted you a note; open Messages to confirm.',
                    savedPath,
                    channel: sent.channel,
                  };
                }
                return {
                  ok: true,
                  message: savedPath
                    ? 'Photo taken and shown on my video, but iMessage is not configured yet. Set PHOTO_RECIPIENT and CHERT_SIGNING_SECRET to text it.'
                    : 'Photo taken and shown on my video, but it could not be saved or texted.',
                  savedPath,
                  channel: sent.channel,
                  sendError: sent.message,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn('[caller-vision] take_photo failed', message);
                return { ok: false, message: 'The photo could not be sent. Ask them to try again.' };
              } finally {
                takingPhoto = false;
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
