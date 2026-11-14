// Photos of the caller. Grok Voice does not accept images, so each snapshot is sent to
// the xAI vision model and the spoken coach only receives the short text cue.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llm } from '@livekit/agents';
import { RoomEvent, TrackKind, TrackSource, VideoFrame, VideoStream } from '@livekit/rtc-node';

const CALLER_TRACK = 'facetime-remote-video';
const VISION_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.7';
const CAPTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures');

const VISION_PROMPT = `You are looking at one photo from the caller's FaceTime camera.
Reply with JSON only, no markdown: {"seen": false, "cue": null} or {"seen": true, "cue": "<one short spoken sentence>"}.
Set seen to true when a person is clearly visible.
When seen is true, cue must describe what they are doing right now in one short spoken sentence: smile, frown, facing the camera, turned away, waving, hands up, sitting, standing, stepping back, too close, or similar.
If nothing special is happening, say a brief ready/framed observation such as "You're facing the camera and look ready."
When seen is false, cue must be null.
Do not invent body parts or actions you cannot see. Do not mention files, folders, or messaging.`;

/**
 * @typedef {{ ok: boolean, seen: boolean, cue: string | null, message: string, savedPath?: string }} PhotoResult
 */

/**
 * @param {unknown} cue
 * @returns {string | null}
 */
function normalizeCue(cue) {
  if (typeof cue !== 'string') return null;
  const trimmed = cue.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 240) : null;
}

/**
 * @param {string} text
 * @returns {{ seen: boolean, cue: string | null }}
 */
export function resultFromVisionText(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return { seen: false, cue: null };
  try {
    const parsed = JSON.parse(match[0]);
    const cue = normalizeCue(parsed?.cue);
    const seen = parsed?.seen === true || Boolean(cue);
    return { seen, cue: seen ? cue : null };
  } catch {
    return { seen: false, cue: null };
  }
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function cueFromVisionText(text) {
  return resultFromVisionText(text).cue;
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
function publicationList(participant) {
  const publications = participant?.trackPublications;
  if (!publications) return [];
  if (typeof publications.values === 'function') return [...publications.values()];
  return Object.values(publications);
}

function callerVideoPublication(participant) {
  if (!participant || typeof participant === 'string') return undefined;
  const videos = publicationList(participant).filter(publication => publication?.kind === TrackKind.KIND_VIDEO);
  videos.sort((a, b) => publicationRank(a) - publicationRank(b));
  return /** @type {import('@livekit/rtc-node').RemoteTrackPublication | undefined} */ (videos[0]);
}

/**
 * Keep the newest frame from the caller's camera.
 * @param {import('@livekit/rtc-node').Room} room
 * @param {import('@livekit/rtc-node').RemoteParticipant} caller
 */
export function watchCallerCamera(room, caller) {
  const identity = typeof caller === 'string' ? caller : caller?.identity;
  const initial = typeof caller === 'string' ? room.remoteParticipants?.get(caller) : caller;
  /** @type {VideoFrame | null} */
  let latest = null;
  /** @type {ReadableStreamDefaultReader<import('@livekit/rtc-node').VideoFrameEvent> | null} */
  let reader = null;
  let watching = '';
  let generation = 0;
  const abort = new AbortController();

  const pump = async (track, generationId) => {
    let stream;
    try {
      stream = new VideoStream(track);
    } catch (error) {
      console.warn('[caller-vision] could not open camera stream', error instanceof Error ? error.message : error);
      return;
    }
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
  if (initial) attach(initial);

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
 * Encode a camera frame as PNG bytes for vision or disk.
 * @param {VideoFrame} frame
 * @returns {Promise<{ base64Data: string, bytes: Buffer } | null>}
 */
export async function encodeFramePng(frame) {
  const serialized = await llm.serializeImage(llm.createImageContent({
    image: frame,
    inferenceDetail: 'low',
    inferenceWidth: 512,
    inferenceHeight: 512,
    mimeType: 'image/png',
  }));
  if (!serialized.base64Data) return null;
  return {
    base64Data: serialized.base64Data,
    bytes: Buffer.from(serialized.base64Data, 'base64'),
  };
}

/**
 * Save the newest capture for debugging what the coach saw.
 * @param {Buffer} bytes
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string>}
 */
export async function saveCapturePng(bytes, options = {}) {
  const dir = options.dir ?? CAPTURE_DIR;
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'last.png');
  await writeFile(filePath, bytes);
  return filePath;
}

/**
 * Ask the vision model for one coaching cue from a camera frame.
 * @param {VideoFrame} frame
 * @param {{ apiKey?: string, model?: string, fetchImpl?: typeof fetch, save?: boolean, captureDir?: string }} [options]
 * @returns {Promise<PhotoResult>}
 */
export async function takePhotoFromFrame(frame, options = {}) {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY is missing');
  const encoded = await encodeFramePng(frame);
  if (!encoded) {
    return { ok: false, seen: false, cue: null, message: 'Could not encode the camera frame.' };
  }

  /** @type {string | undefined} */
  let savedPath;
  if (options.save !== false) {
    try {
      savedPath = await saveCapturePng(encoded.bytes, { dir: options.captureDir });
    } catch (error) {
      console.warn('[caller-vision] could not save capture', error instanceof Error ? error.message : error);
    }
  }

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
          { type: 'input_image', image_url: `data:image/png;base64,${encoded.base64Data}`, detail: 'low' },
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

  const { seen, cue } = resultFromVisionText(visionOutputText(payload));
  if (!seen) {
    return {
      ok: true,
      seen: false,
      cue: null,
      message: 'Photo taken, but no person was clearly visible. Ask them to step back, face the camera, and try again.',
      savedPath,
    };
  }
  return {
    ok: true,
    seen: true,
    cue,
    message: cue ?? 'Photo taken. The caller looks ready.',
    savedPath,
  };
}

/**
 * @param {VideoFrame} frame
 * @param {{ apiKey?: string, model?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string | null>}
 */
export async function cueFromFrame(frame, options = {}) {
  const result = await takePhotoFromFrame(frame, { ...options, save: false });
  return result.cue;
}
