// Photos of the caller. Grok Voice does not accept images, so each snapshot is sent to
// the xAI vision model and the spoken coach only receives the short text cue.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llm } from '@livekit/agents';
import { RoomEvent, TrackKind, TrackSource, VideoFrame, VideoStream } from '@livekit/rtc-node';
import { describeSampleSkeleton } from './skeleton.mjs';

const CALLER_TRACK = 'facetime-remote-video';
const VISION_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.7';
const CAPTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures');

/**
 * Build the vision prompt. The sample skeleton is an internal target only — the
 * caller never sees it; estimate their pose from this photo and compare.
 * @param {string} [targetPose]
 */
export function buildVisionPrompt(targetPose = describeSampleSkeleton()) {
  return `You are looking at one photo from the caller's FaceTime camera.
Mentally estimate a stick-figure skeleton of the person in the photo (head, shoulders, elbows, wrists, hips, knees, ankles).
Compare that estimated pose to this INTERNAL target pose (the caller cannot see it on screen): ${targetPose}
Reply with JSON only, no markdown: {"seen": false, "ready": false, "cue": null} or {"seen": true, "ready": false|true, "cue": "<one short spoken sentence in English>"}.
Set seen to true when a person is clearly visible.
Set ready to true only when their estimated skeleton closely matches the target (facing camera, similar stance and arm positions). Otherwise ready is false.
When seen is true, cue must be English only: one short coaching tip toward the target (step left/right, move closer/back, raise/lower arms, straighten posture, face the camera). If ready is true, cue should tell them they look ready for a photo (for example "You look lined up and ready — say cheese when you want the shot.").
When seen is false (blank, dark, camera off, no person), ready must be false and cue must be null.
Do not invent body parts or actions you cannot see. Do not mention files, folders, messaging, stick figures on their screen, or that a photo was taken. Never write the cue in Spanish or any language other than English.`;
}

const VISION_PROMPT = buildVisionPrompt();

/**
 * @typedef {{ ok: boolean, seen: boolean, ready: boolean, cue: string | null, message: string, savedPath?: string }} PhotoResult
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
 * @returns {{ seen: boolean, ready: boolean, cue: string | null }}
 */
export function resultFromVisionText(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return { seen: false, ready: false, cue: null };
  try {
    const parsed = JSON.parse(match[0]);
    const cue = normalizeCue(parsed?.cue);
    const seen = parsed?.seen === true || Boolean(cue);
    const ready = seen && parsed?.ready === true;
    return { seen, ready, cue: seen ? cue : null };
  } catch {
    return { seen: false, ready: false, cue: null };
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
 * Save a capture with a chronological filename (ISO timestamp, sortable).
 * @param {Buffer} bytes
 * @param {{ dir?: string, at?: Date }} [options]
 * @returns {Promise<string>}
 */
export async function saveCapturePng(bytes, options = {}) {
  const dir = options.dir ?? CAPTURE_DIR;
  await mkdir(dir, { recursive: true });
  const stamp = (options.at ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${stamp}.png`);
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

  const { seen, ready, cue } = resultFromVisionText(visionOutputText(payload));
  /** @type {string | undefined} */
  let savedPath;
  // Only keep chronological captures when a person is actually in frame.
  if (options.save !== false && seen) {
    try {
      savedPath = await saveCapturePng(encoded.bytes, { dir: options.captureDir });
    } catch (error) {
      console.warn('[caller-vision] could not save capture', error instanceof Error ? error.message : error);
    }
  }
  if (!seen) {
    return {
      ok: true,
      seen: false,
      ready: false,
      cue: null,
      message: 'No person was clearly visible. Do not treat this as a taken photo.',
      savedPath,
    };
  }
  return {
    ok: true,
    seen: true,
    ready,
    cue,
    message: cue ?? (ready ? 'You look lined up and ready.' : 'Photo taken.'),
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
