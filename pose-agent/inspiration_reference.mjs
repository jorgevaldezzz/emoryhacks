// Bridge the website's "Inspiration upload" photo into a live call: fetch the
// account's most recent inspiration upload from the gallery API, extract its
// MediaPipe skeleton, store that skeleton back into the gallery, and hand back
// a data URL the pose matcher can use as its coaching reference. This replaces
// the local reference-images/ dev-only path (see AGENTS.md "Future pose
// reference uploads") once GALLERY_API_URL / GALLERY_INGEST_SECRET /
// GALLERY_USER_EMAIL are set — those are the same three env vars gallery_upload.mjs
// already uses to push Chert captures the other direction.
import sharp from 'sharp';
import { drawPoseSkeleton } from './debug_skeleton.mjs';

/**
 * @param {{ apiUrl?: string, ingestSecret?: string, email?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ itemId: string, mime: string, dataUrl: string } | null>}
 */
export async function fetchInspirationUpload(options = {}) {
  const apiUrl = (options.apiUrl ?? process.env.GALLERY_API_URL ?? '').replace(/\/$/, '');
  const ingestSecret = options.ingestSecret ?? process.env.GALLERY_INGEST_SECRET;
  const email = options.email ?? process.env.GALLERY_USER_EMAIL;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!apiUrl || !ingestSecret || !email) return null;

  const lookup = await fetchImpl(
    `${apiUrl}/api/gallery/chert/reference?email=${encodeURIComponent(email)}`,
    { headers: { 'X-Ingest-Secret': ingestSecret }, signal: AbortSignal.timeout(20_000) },
  );
  if (!lookup.ok) return null;
  const lookupBody = await lookup.json().catch(() => ({}));
  const item = lookupBody?.item;
  if (!item?.url || !item?.id) return null;

  const imageUrl = /^https?:\/\//i.test(item.url) ? item.url : `${apiUrl}${item.url}`;
  const imageRes = await fetchImpl(imageUrl, { signal: AbortSignal.timeout(20_000) });
  if (!imageRes.ok) return null;
  const mime = imageRes.headers.get?.('content-type') || item.mimeType || 'image/jpeg';
  const bytes = Buffer.from(await imageRes.arrayBuffer());
  if (!bytes.length) return null;
  return { itemId: item.id, mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}

/**
 * Draw a MediaPipe skeleton overlay onto the inspiration photo itself.
 * @param {{ dataUrl: string, detectPose: (image: string) => Promise<any> }} options
 * @returns {Promise<{ buffer: Buffer, drawn: number } | null>}
 */
export async function buildSkeletonOverlay({ dataUrl, detectPose }) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const pose = await detectPose(dataUrl);
  if (!pose?.personVisible) return null;
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(decoded.data);
  const drawn = drawPoseSkeleton(pixels, decoded.info.width, decoded.info.height, pose.landmarks);
  if (drawn < 4) return null;
  const buffer = await sharp(Buffer.from(pixels), {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
  }).png().toBuffer();
  return { buffer, drawn };
}

/**
 * @param {{ bytes: Buffer, apiUrl?: string, ingestSecret?: string, email?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, skipped?: boolean, item?: object, message: string }>}
 */
export async function uploadSkeletonToGallery(options) {
  const apiUrl = (options.apiUrl ?? process.env.GALLERY_API_URL ?? '').replace(/\/$/, '');
  const ingestSecret = options.ingestSecret ?? process.env.GALLERY_INGEST_SECRET;
  const email = options.email ?? process.env.GALLERY_USER_EMAIL;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!apiUrl || !ingestSecret || !email) {
    return { ok: false, skipped: true, message: 'Gallery env is not set; skeleton stays local only.' };
  }
  if (!options.bytes?.length) {
    return { ok: false, message: 'No skeleton bytes to upload.' };
  }

  const res = await fetchImpl(`${apiUrl}/api/gallery/chert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': ingestSecret },
    body: JSON.stringify({
      email,
      imageBase64: options.bytes.toString('base64'),
      mimeType: 'image/png',
      name: 'inspiration-skeleton.png',
      note: 'Inspiration skeleton',
      source: 'upload',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body?.error === 'string' ? body.error : res.statusText;
    return { ok: false, message: `Skeleton upload failed (${res.status}): ${detail}` };
  }
  return { ok: true, item: body.item, message: 'Skeleton saved to gallery.' };
}

/**
 * Fetch the caller's website inspiration upload, derive and store its skeleton,
 * and return the original photo as a reference image for setReference().
 * Returns null (never throws) so callers can fall back to a local reference
 * image — e.g. when no inspiration upload exists yet, or the gallery API is
 * unreachable.
 * @param {{ apiUrl?: string, ingestSecret?: string, email?: string, detectPose: (image: string) => Promise<any>, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ path: string, mime: string, dataUrl: string } | null>}
 */
export async function syncInspirationReference(options) {
  let upload;
  try {
    upload = await fetchInspirationUpload(options);
  } catch (error) {
    console.warn('[inspiration-reference] could not fetch the website upload', error instanceof Error ? error.message : error);
    return null;
  }
  if (!upload) return null;

  try {
    const overlay = await buildSkeletonOverlay({ dataUrl: upload.dataUrl, detectPose: options.detectPose });
    if (overlay) {
      const result = await uploadSkeletonToGallery({ ...options, bytes: overlay.buffer });
      if (!result.ok && !result.skipped) {
        console.warn(`[inspiration-reference] ${result.message}`);
      } else if (result.ok) {
        console.log(`[inspiration-reference] skeleton saved item=${result.item?.id ?? 'ok'} joints=${overlay.drawn}`);
      }
    } else {
      console.warn('[inspiration-reference] MediaPipe could not find enough joints in the inspiration upload to draw a skeleton');
    }
  } catch (error) {
    console.warn('[inspiration-reference] skeleton generation failed', error instanceof Error ? error.message : error);
  }

  return { path: `gallery:${upload.itemId}`, mime: upload.mime, dataUrl: upload.dataUrl };
}
