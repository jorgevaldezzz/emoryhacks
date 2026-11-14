import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, ServerOptions, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { cueFromFrame, watchCallerCamera } from './caller_vision.mjs';

const LOOK_EVERY_MS = 8_000;

// The voice model never sees the camera. caller_vision.mjs hands it one cue at a time.
const instructions = `You are a pose coach on a FaceTime video call.
The caller sees a simple animated face while you talk.
You cannot see the camera yourself. A photo of the caller is taken every few seconds, and you are handed one short coaching cue from that photo.
When you receive a cue, say it in one short sentence and stop. Do not repeat a cue you already gave.
If the caller asks a question, answer in one or two short sentences.
If no photo has arrived, ask them to step back so their whole body is in frame.
Be clear that you are an AI. Never invent a correction you were not given.`;
// Said once, as soon as FaceTime is ready. Keep it short: it is the first thing the caller hears.
const greeting = 'Greet the caller in one short sentence: say you are an AI pose coach and ask them to step into frame so you can look.';

export default defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session or sending video.
    const caller = await ctx.waitForParticipant();
    const camera = watchCallerCamera(ctx.room, caller.identity);

    // Video: one camera track, published by this agent. The Mac shows video only
    // from the participant that speaks, so the picture and the voice stay together.
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let tick = 0, speaking = false, looking = false, lastCue = '', sawCamera = false, announcedWait = false;
    let lookTimer;
    const frame = () => source.captureFrame(new VideoFrame(drawFace(tick++, speaking), WIDTH, HEIGHT, VideoBufferType.RGBA));
    frame();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(frame, 1000 / FPS);

    const session = new voice.AgentSession({
      llm: new xai.realtime.RealtimeModel({ voice: 'leo' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });
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
      agent: new voice.Agent({ instructions }),
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
      sawCamera = true;
      looking = true;
      cueFromFrame(photo).then(cue => {
        if (!cue || cue === lastCue || speaking) return;
        lastCue = cue;
        console.log(`[caller-vision] cue: ${cue}`);
        session.generateReply({
          instructions: `A new photo of the caller was just taken. Say only this cue, in one short sentence: ${cue}`,
        });
      }).catch(error => {
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
