import { randomUUID } from "node:crypto";
import {
  countGalleryForUser,
  insertGalleryItem,
  deleteGalleryItem,
  listOldestGalleryForUser,
} from "./db.js";
import { deleteImageObject, putImageObject } from "./object-store.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Default soft cap per account; oldest images are deleted when exceeded. */
export function galleryMaxItems() {
  const raw = Number(process.env.GALLERY_MAX_ITEMS || 25);
  if (!Number.isFinite(raw) || raw < 1) return 25;
  return Math.floor(raw);
}

/**
 * @param {string} mime
 */
export function extensionForMime(mime) {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

/**
 * @param {string} mime
 */
export function assertAllowedMime(mime) {
  if (!ALLOWED_MIME.has(mime)) {
    const err = new Error("Only JPEG, PNG, WebP, and GIF images are allowed");
    err.status = 400;
    throw err;
  }
}

/**
 * If the user is at/over the gallery cap, delete oldest items until there is room.
 * @param {string} userId
 */
export async function enforceGalleryCap(userId) {
  const max = galleryMaxItems();
  const count = await countGalleryForUser(userId);
  if (count < max) return { pruned: 0, max };

  const overflow = count - max + 1;
  const oldest = await listOldestGalleryForUser(userId, overflow);
  let pruned = 0;
  for (const item of oldest) {
    await removeGalleryImage(item.id, userId);
    pruned += 1;
  }
  return { pruned, max };
}

/**
 * Persist an image (Vercel Blob or local) and attach a gallery row to the user.
 * @param {{
 *   userId: string,
 *   buffer: Buffer,
 *   mime: string,
 *   originalName?: string | null,
 *   note?: string | null,
 *   source?: string,
 * }} input
 */
export async function saveGalleryImage(input) {
  assertAllowedMime(input.mime);
  if (!input.buffer?.length) {
    const err = new Error("Image data is empty");
    err.status = 400;
    throw err;
  }
  if (input.buffer.length > 8 * 1024 * 1024) {
    const err = new Error("Image is too large (max 8MB)");
    err.status = 413;
    throw err;
  }

  const cap = await enforceGalleryCap(input.userId);

  const id = randomUUID();
  const filename = `${id}${extensionForMime(input.mime)}`;
  const stored = await putImageObject({
    filename,
    buffer: input.buffer,
    mime: input.mime,
  });

  const createdAt = new Date().toISOString();
  try {
    await insertGalleryItem({
      id,
      userId: input.userId,
      filename: stored.filename,
      url: stored.url,
      pathname: stored.pathname,
      originalName: input.originalName ?? null,
      note: input.note ?? null,
      source: input.source || "upload",
      createdAt,
    });
  } catch (err) {
    await deleteImageObject(stored);
    throw err;
  }

  return {
    id,
    filename: stored.filename,
    url: stored.url,
    pathname: stored.pathname,
    originalName: input.originalName ?? null,
    note: input.note ?? null,
    source: input.source || "upload",
    createdAt,
    pruned: cap.pruned,
    galleryMaxItems: cap.max,
  };
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function removeGalleryImage(id, userId) {
  const item = await deleteGalleryItem(id, userId);
  if (!item) return null;
  await deleteImageObject(item);
  return item;
}

export { resolveUploadPath } from "./object-store.js";
