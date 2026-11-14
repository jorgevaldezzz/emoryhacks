// Photos of the caller. Grok Voice does not accept images, so each snapshot is sent to
// the xAI vision model and the spoken coach only receives the short text cue.
import { llm } from '@livekit/agents';
import { RoomEvent, TrackKind, TrackSource, VideoFrame, VideoStream } from '@livekit/rtc-node';

const CALLER_TRACK = 'facetime-remote-video';
const VISION_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.7';

const VISION_PROMPT = `You are looking at one photo from the caller's FaceTime camera.
Reply with JSON only, no markdown: {"cue": null} or {"cue": "<one short spoken sentence>"}.
Use a cue only when you can see the person and there is one useful adjustment to their position, posture, or what they are showing the camera.
Use null when the frame is empty, too dark, the person is out of frame, or nothing needs to be said.
Do not invent body parts or objects you cannot see.`;

/**
 * @param {string} text
 * @returns {string | null}
 */
export function cueFromVisionText(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const cue = JSON.parse(match[0])?.cue;
    if (typeof cue !== 'string') return null;
    const trimmed = cue.trim().replace(/\s+/g, ' ');
    return trimmed ? trimmed.slice(0, 240) : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
export function visionOutputText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const record = /** @type {{ output_text?: unknown, output?: unknown }} */ (payload);
  if (typeof record.output_text === 'string') return record.output_text;
  const chunks = [];
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    const content = item && typeof item === 'object' && Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

/**
 * @param {VideoFrame} frame
 * @returns {VideoFrame}
 */
export function copyFrame(frame) {
  return new VideoFrame(new Uint8Array(frame.data), frame.width, frame.height, frame.type);
}

/**
 * @param {import('@livekit/rtc-node').TrackPublication} publication
 * @returns {number}
 */
function publicationRank(publication) {
  if (publication.name === CALLER_TRACK) return 0;
  if (publication.source === TrackSource.SOURCE_CAMERA) return 1;
  return 2;
}

/**
 * @param {import('@livekit/rtc-node').RemoteParticipant | undefined} participant
 * @returns {import('@livekit/rtc-node').RemoteTrackPublication | undefined}
 */
function callerVideoPublication(participant) {
  if (!participant) return undefined;
  const videos = [...participant.trackPublications.values()].filter(publication => publication.kind === TrackKind.KIND_VIDEO);
  videos.sort((a, b) => publicationRank(a) - publicationRank(b));
  return /** @type {import('@livekit/rtc-node').RemoteTrackPublication | undefined} */ (videos[0]);
}

/**
 * Keep the newest frame from the caller's camera.
 * @param {import('@livekit/rtc-node').Room} room
 * @param {import('@livekit/rtc-node').RemoteParticipant} caller
 */
export function watchCallerCamera(room, caller) {
  const identity = caller.identity;
  /** @type {VideoFrame | null} */
  let latest = null;
  /** @type {ReadableStreamDefaultReader<import('@livekit/rtc-node').VideoFrameEvent> | null} */
  let reader = null;
  let watching = '';
  let generation = 0;
  const abort = new AbortController();

  const pump = async (track, generationId) => {
    const stream = new VideoStream(track);
    const next = stream.getReader();
    reader = next;
    try {
      while (!abort.signal.aborted && generationId === generation) {
        const { done, value } = await next.read();
        if (done || !value) break;
        latest = copyFrame(value.frame);
      }
    } catch (error) {
      if (!abort.signal.aborted && generationId === generation) console.warn('[caller-vision] camera stream ended', error);
    }
  };

  const attach = (participant) => {
    if (!participant || participant.identity !== identity) return;
    const publication = callerVideoPublication(participant);
    if (!publication) return;
    if (typeof publication.setSubscribed === 'function') publication.setSubscribed(true);
    const track = publication.track;
    const trackId = track?.sid ?? publication.sid;
    if (!track || !trackId || watching === trackId) return;
    watching = trackId;
    generation += 1;
    console.log(`[caller-vision] watching ${publication.name || 'caller video'}`);
    reader?.cancel().catch(() => {});
    pump(track, generation);
  };

  const onSubscribed = (_track, _publication, participant) => attach(participant);
  const onPublished = (_publication, participant) => attach(participant);

  room.on(RoomEvent.TrackSubscribed, onSubscribed);
  room.on(RoomEvent.TrackPublished, onPublished);
  attach(caller);

  return {
    /** @returns {VideoFrame | null} */
    latest: () => latest,
    stop() {
      abort.abort();
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackPublished, onPublished);
      reader?.cancel().catch(() => {});
    },
  };
}

/**
 * Ask the vision model for one coaching cue from a camera frame.
 * @param {VideoFrame} frame
 * @param {{ apiKey?: string, model?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string | null>}
 */
export async function cueFromFrame(frame, options = {}) {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY is missing');
  const serialized = await llm.serializeImage(llm.createImageContent({
    image: frame,
    inferenceDetail: 'low',
    inferenceWidth: 512,
    inferenceHeight: 512,
    mimeType: 'image/png',
  }));
  if (!serialized.base64Data) return null;
  const response = await (options.fetchImpl ?? fetch)(VISION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? process.env.XAI_VISION_MODEL ?? DEFAULT_MODEL,
      store: false,
      input: [{
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:image/png;base64,${serialized.base64Data}`, detail: 'low' },
          { type: 'input_text', text: VISION_PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : response.statusText;
    throw new Error(`vision request failed (${response.status}): ${message}`);
  }
  return cueFromVisionText(visionOutputText(payload));
}
