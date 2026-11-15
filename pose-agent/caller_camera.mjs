// FaceTime camera subscription, image encoding, and local capture persistence.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoStream } from '@livekit/rtc-node';

const CALLER_TRACK = 'facetime-remote-video';
const CAPTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures');

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
      console.warn('[caller-camera] could not open camera stream', error instanceof Error ? error.message : error);
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
      if (!abort.signal.aborted && generationId === generation) console.warn('[caller-camera] camera stream ended', error);
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
    console.log(`[caller-camera] watching ${publication.name || 'caller video'}`);
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
 * Mirror a frame's pixels horizontally, as raw RGBA (not PNG). judgeFrame detects
 * landmarks on the unmirrored (flopped) frame, so anything drawing those landmarks
 * back onto a frame — like the debug skeleton — needs this, not the raw caller frame,
 * or every joint lands mirrored into whatever padding sits on the opposite side.
 * @param {VideoFrame} frame
 * @returns {Promise<VideoFrame | null>}
 */
export async function mirrorFrameHorizontally(frame) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  if (!rgba?.data?.length || !rgba.width || !rgba.height) return null;
  const { data, info } = await sharp(Buffer.from(rgba.data), {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  }).flop().raw().toBuffer({ resolveWithObject: true });
  return new VideoFrame(new Uint8Array(data), info.width, info.height, VideoBufferType.RGBA);
}

/**
 * Encode a camera frame as PNG bytes for MediaPipe or disk.
 * Preserves aspect ratio. Never force a square — that was squashing cheese snaps
 * after the FaceTime chrome crop. Optional maxSide only downscales with fit:inside.
 * @param {VideoFrame} frame
 * @param {{ maxSide?: number, mirrorHorizontally?: boolean }} [options]
 * @returns {Promise<{ base64Data: string, bytes: Buffer, width: number, height: number } | null>}
 */
export async function encodeFramePng(frame, options = {}) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  if (!rgba?.data?.length || !rgba.width || !rgba.height) return null;

  let pipeline = sharp(Buffer.from(rgba.data), {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  });
  if (options.mirrorHorizontally) pipeline = pipeline.flop();
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
 * Encode and save a frame as a timestamped PNG.
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
    console.warn('[caller-camera] could not save capture', message);
    return { ok: false, message: `Could not save capture: ${message}`, bytes: encoded.bytes };
  }
}
