// Reads a background out of a photo, and says how far the caller's background
// is from the one they want.
//
// Typesense does not look at pixels — it searches text and geography. So one
// vision call turns both images into the small vocabulary in scene.mjs, and
// everything after that is an ordinary search. The call is injectable
// (`fetchImpl`) and the whole module is optional: every failure here becomes a
// plain "no match available", never a broken call.
//
// Any OpenAI-compatible chat endpoint works. The default is OpenAI, because
// pose-agent already holds an OPENAI_API_KEY.
import { ConfigError } from './client.mjs';
import { normalizeSceneKey, sceneVocabulary } from './scene.mjs';

/** Errors from this module carry a machine-readable `code`. */
export class VisionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'VisionError';
    this.code = code; // bad_image | unreadable | unavailable
  }
}

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 8000;
// Before base64, which adds a third again. Bigger than this is a photo nobody
// needed to send, and it only slows the call down.
const MAX_BYTES = 8 * 1024 * 1024;

const MAGIC = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF; good enough here
];

function sniff(bytes) {
  const found = MAGIC.find(({ bytes: magic }) => magic.every((byte, i) => bytes[i] === byte));
  if (!found) throw new VisionError('bad_image', 'Not a JPEG, PNG, GIF or WebP.');
  return found.mime;
}

/**
 * Anything an image might arrive as -> something the model API accepts.
 * Accepts a data: URL, an https: URL, raw bytes, or {data, mimeType}.
 */
export function toImageUrl(image) {
  if (!image) throw new VisionError('bad_image', 'No image given.');

  if (typeof image === 'string') {
    if (image.startsWith('data:image/')) return image;
    if (/^https?:\/\//.test(image)) return image;
    throw new VisionError('bad_image', 'A string image must be a data: URL or an http(s) URL.');
  }

  if (image instanceof ArrayBuffer || ArrayBuffer.isView(image)) return dataUrl(asBytes(image));
  if (image.data) return dataUrl(asBytes(image.data), image.mimeType);
  throw new VisionError('bad_image', `Cannot read an image from a ${typeof image}.`);
}

function asBytes(data) {
  // A base64 payload, with or without the data: URL wrapper around it.
  if (typeof data === 'string') return Uint8Array.from(Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64'));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new VisionError('bad_image', 'Image data must be bytes or a base64 string.');
}

function dataUrl(bytes, mimeType) {
  if (bytes.byteLength === 0) throw new VisionError('bad_image', 'The image is empty.');
  if (bytes.byteLength > MAX_BYTES) {
    throw new VisionError('bad_image', `The image is ${Math.round(bytes.byteLength / 1e6)} MB; keep it under 8 MB.`);
  }
  const mime = mimeType ?? sniff(bytes);
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

const SYSTEM = `You compare the BACKGROUND of photographs for a photo-coaching assistant.
Ignore people, faces, clothing, pets and anything held in frame. Judge only what is behind the subject.

Classify each background as exactly one of these scenes:
${sceneVocabulary()}

Reply with JSON only:
{
  "reference": {"scene": "<one scene key>", "tags": ["<=4 short words for what is actually behind the subject>"], "background": "<8 words or fewer>"},
  "current": {"scene": "<one scene key>", "tags": [...], "background": "..."},
  "similarity": <0.0 to 1.0, how alike the two BACKGROUNDS would look in a photo>,
  "difference": "<one sentence, 20 words or fewer, addressed to the caller as 'you', saying how their background differs>"
}
Omit "current", "similarity" and "difference" when only one image is given.
Similarity is about the kind of place, not the exact spot: two different mountain ridges are about 0.8, a ridge and an office wall are below 0.1.`;

function userContent(referenceUrl, currentUrl) {
  const content = [
    { type: 'text', text: currentUrl
      ? 'Image 1 is the reference photo the caller wants to recreate. Image 2 is the caller right now.'
      : 'Image 1 is the reference photo the caller wants to recreate. There is no second image.' },
    { type: 'image_url', image_url: { url: referenceUrl, detail: 'low' } },
  ];
  if (currentUrl) content.push({ type: 'image_url', image_url: { url: currentUrl, detail: 'low' } });
  return content;
}

function profileFrom(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string').slice(0, 6) : [];
  return {
    scene: normalizeSceneKey(raw.scene),
    tags,
    background: typeof raw.background === 'string' ? raw.background.slice(0, 120) : undefined,
  };
}

function sentence(value) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, 160);
  return clean || undefined;
}

/**
 * Describe one or two backgrounds, and score how alike they are.
 *
 * @param {object} args
 * @param {*} args.reference        The photo the caller wants to recreate.
 * @param {*} [args.current]        A frame of the caller now. Omit to only describe the reference.
 * @param {object} [args.env]
 * @param {Function} [args.fetchImpl]   Injected in tests; defaults to global fetch.
 * @param {string} [args.model]     Defaults to $VISION_MODEL, then gpt-4o-mini.
 * @param {number} [args.timeoutMs]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{reference: object, current?: object, similarity?: number, difference?: string}>}
 * @throws {ConfigError|VisionError}
 */
export async function compareBackgrounds({
  reference,
  current,
  env = process.env,
  fetchImpl = globalThis.fetch,
  model = env.VISION_MODEL || DEFAULT_MODEL,
  baseUrl = env.VISION_BASE_URL || DEFAULT_BASE_URL,
  timeoutMs = Number(env.VISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  const apiKey = env.VISION_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigError('No vision key. Set OPENAI_API_KEY (or VISION_API_KEY) in .env.local.');
  }

  // Validate both images before spending a request on either.
  const referenceUrl = toImageUrl(reference);
  const currentUrl = current ? toImageUrl(current) : undefined;

  // The caller's signal and our own deadline, whichever comes first.
  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent(referenceUrl, currentUrl) },
        ],
      }),
      signal: abort,
    });
  } catch (error) {
    const why = error?.name === 'TimeoutError' || timeout.aborted ? `no answer in ${timeoutMs} ms` : error.message;
    throw new VisionError('unavailable', `The vision model did not answer: ${why}`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new ConfigError(`The vision key was rejected (HTTP ${response.status}). Check OPENAI_API_KEY.`);
    }
    throw new VisionError('unavailable', `Vision model returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  let parsed;
  try {
    const body = await response.json();
    parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '');
  } catch (error) {
    throw new VisionError('unreadable', 'The vision model did not return readable JSON.', { cause: error });
  }

  const referenceProfile = profileFrom(parsed.reference);
  if (!referenceProfile) throw new VisionError('unreadable', 'The vision model described no reference background.');

  const result = { reference: referenceProfile };
  const currentProfile = currentUrl ? profileFrom(parsed.current) : undefined;
  if (currentProfile) {
    result.current = currentProfile;
    result.similarity = score(parsed.similarity, referenceProfile, currentProfile);
    result.difference = sentence(parsed.difference);
  }
  return result;
}

// A missing or nonsense number should not read as "identical". Fall back to the
// two scene keys, which is the judgement we actually rely on.
function score(value, reference, current) {
  const number = Number(value);
  if (Number.isFinite(number)) return Math.min(1, Math.max(0, number));
  return reference.scene !== 'unknown' && reference.scene === current.scene ? 0.8 : 0.2;
}
