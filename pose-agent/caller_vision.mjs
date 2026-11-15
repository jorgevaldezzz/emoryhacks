// Photos of the caller. Grok Voice does not accept images, so each snapshot is sent to
// the xAI vision model and the spoken coach only receives the short text cue.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoStream } from '@livekit/rtc-node';

const CALLER_TRACK = 'facetime-remote-video';
const VISION_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.7';
const CAPTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures');

/**
 * Build the vision prompt. When a reference image is attached, coach toward that
 * pose — never toward the old arms-out sample scaffold.
 * @param {{ hasReference?: boolean }} [options]
 */
export function buildVisionPrompt(options = {}) {
  const hasReference = options.hasReference === true;
  if (!hasReference) {
    return `Estimate whether a person is clearly visible in this FaceTime frame.
Reply with JSON only, no markdown: {"seen": false, "ready": false, "cue": null} or {"seen": true, "ready": false, "cue": "<one short English tip>"}.
Set seen to true when a person is clearly visible.
ready must always be false when no reference pose is configured.
When seen is true, cue must tell them a reference pose still needs to be set before you can coach alignment — for example "I need the target pose loaded before I can guide you."
Never mention photos, images, snapshots, cameras, files, folders, messaging, or skeletons. Never write Spanish or any language other than English.
When seen is false (blank, dark, camera off, no person), ready must be false and cue must be null.`;
  }
  return `The FIRST image is the TARGET reference pose. The SECOND image is the caller on FaceTime.
Estimate both body poses (head, shoulders, elbows, wrists, hips, knees, ankles).
Coach the caller to match the reference pose — ignore any default standing or arms-out scaffold.
Reply with JSON only, no markdown: {"seen": false, "ready": false, "cue": null} or {"seen": true, "ready": false|true, "cue": "<one short English coaching tip>"}.
Set seen to true when a person is clearly visible in the caller frame.
Set ready to true only when their pose closely matches the reference. Otherwise ready is false.
When seen is true and they do not match, cue must be ONLY one specific body correction toward the reference — for example "Raise your left elbow higher." or "Shift your weight onto your right leg."
When seen is true and they match, cue must be exactly "Hold still."
Do not tell them to say cheese or to ask for another check. Do not give generic praise like "you look good" or "stand up" unless that is the exact mismatch.
Never mention photos, images, snapshots, cameras, files, folders, messaging, skeletons on screen, or that you are looking/checking/reviewing anything. Never write Spanish or any language other than English.
When seen is false (blank, dark, camera off, no person), ready must be false and cue must be null.`;
}

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
 * Preserves aspect ratio. Never force a square — that was squashing cheese snaps
 * after the FaceTime chrome crop. Optional maxSide only downscales with fit:inside.
 * @param {VideoFrame} frame
 * @param {{ maxSide?: number }} [options]
 * @returns {Promise<{ base64Data: string, bytes: Buffer, width: number, height: number } | null>}
 */
export async function encodeFramePng(frame, options = {}) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  if (!rgba?.data?.length || !rgba.width || !rgba.height) return null;

  let pipeline = sharp(Buffer.from(rgba.data), {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  });
  const maxSide = options.maxSide;
  if (Number.isFinite(maxSide) && maxSide > 0) {
    pipeline = pipeline.resize({
      width: maxSide,
      height: maxSide,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const bytes = await pipeline.png().toBuffer();
  const meta = await sharp(bytes).metadata();
  return {
    base64Data: bytes.toString('base64'),
    bytes,
    width: meta.width ?? rgba.width,
    height: meta.height ?? rgba.height,
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
 * Encode and save a frame as a timestamped PNG. Does not call vision.
 * Saves at the frame's native cropped aspect — no square stretch.
 * @param {VideoFrame} frame
 * @param {{ captureDir?: string, at?: Date, maxSide?: number }} [options]
 * @returns {Promise<{ ok: boolean, savedPath?: string, message: string, bytes?: Buffer, width?: number, height?: number }>}
 */
export async function saveFrameCapture(frame, options = {}) {
  const encoded = await encodeFramePng(frame, { maxSide: options.maxSide });
  if (!encoded) {
    return { ok: false, message: 'Could not encode the camera frame.' };
  }
  try {
    const savedPath = await saveCapturePng(encoded.bytes, { dir: options.captureDir, at: options.at });
    return {
      ok: true,
      savedPath,
      message: 'Capture saved.',
      bytes: encoded.bytes,
      width: encoded.width,
      height: encoded.height,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[caller-vision] could not save capture', message);
    return { ok: false, message: `Could not save capture: ${message}`, bytes: encoded.bytes };
  }
}

/**
 * Ask the vision model for one coaching cue from a camera frame.
 * Cheese snaps should save via saveFrameCapture first — do not wait on this for the shutter.
 * Pass referenceImage (data URL) so coaching targets that pose instead of any scaffold.
 * @param {VideoFrame} frame
 * @param {{ apiKey?: string, model?: string, fetchImpl?: typeof fetch, save?: boolean, captureDir?: string, referenceImage?: string | null, visionPrompt?: string }} [options]
 * @returns {Promise<PhotoResult>}
 */
export async function takePhotoFromFrame(frame, options = {}) {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY is missing');
  // Downscale for vision only — fit:inside keeps aspect (never 512x512 stretch).
  const encoded = await encodeFramePng(frame, { maxSide: options.maxSide ?? 1024 });
  if (!encoded) {
    return { ok: false, seen: false, ready: false, cue: null, message: 'Could not encode the camera frame.' };
  }

  const referenceImage = typeof options.referenceImage === 'string' && options.referenceImage.startsWith('data:')
    ? options.referenceImage
    : null;
  const prompt = options.visionPrompt ?? buildVisionPrompt({ hasReference: Boolean(referenceImage) });
  /** @type {Array<{ type: string, image_url?: string, detail?: string, text?: string }>} */
  const content = [];
  if (referenceImage) {
    content.push({ type: 'input_image', image_url: referenceImage, detail: 'high' });
  }
  content.push(
    { type: 'input_image', image_url: `data:image/png;base64,${encoded.base64Data}`, detail: 'low' },
    { type: 'input_text', text: prompt },
  );

  const response = await (options.fetchImpl ?? fetch)(VISION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? process.env.XAI_VISION_MODEL ?? DEFAULT_MODEL,
      store: false,
      input: [{ role: 'user', content }],
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
  // Cheese snaps save via saveFrameCapture before vision. Pass save: false for analyze-only.
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
    ready: referenceImage ? ready : false,
    cue,
    message: cue ?? (ready ? 'You look lined up and ready.' : 'Pose checked.'),
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
