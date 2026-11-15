import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR, insertGalleryItem, deleteGalleryItem } from "./db.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

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
 * Persist an image buffer and create a gallery row for the user.
 * @param {{
 *   userId: string,
 *   buffer: Buffer,
 *   mime: string,
 *   originalName?: string | null,
 *   note?: string | null,
 *   source?: string,
 * }} input
 */
export function saveGalleryImage(input) {
  assertAllowedMime(input.mime);
  if (!input.buffer?.length) {
    const err = new Error("Image data is empty");
    err.status = 400;
    throw err;
  }
  // ~8 MB soft limit for a single gallery image.
  if (input.buffer.length > 8 * 1024 * 1024) {
    const err = new Error("Image is too large (max 8MB)");
    err.status = 413;
    throw err;
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = randomUUID();
  const filename = `${id}${extensionForMime(input.mime)}`;
  const diskPath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(diskPath, input.buffer);

  const createdAt = new Date().toISOString();
  insertGalleryItem({
    id,
    userId: input.userId,
    filename,
    originalName: input.originalName ?? null,
    note: input.note ?? null,
    source: input.source || "upload",
    createdAt,
  });

  return {
    id,
    filename,
    originalName: input.originalName ?? null,
    note: input.note ?? null,
    source: input.source || "upload",
    createdAt,
  };
}

/**
 * @param {string} id
 * @param {string} userId
 */
export function removeGalleryImage(id, userId) {
  const item = deleteGalleryItem(id, userId);
  if (!item) return null;
  const diskPath = path.join(UPLOAD_DIR, item.filename);
  try {
    fs.unlinkSync(diskPath);
  } catch {
    // Missing file is fine — DB row is already gone.
  }
  return item;
}

/**
 * Absolute path for a stored filename (path-traversal safe).
 * @param {string} filename
 */
export function resolveUploadPath(filename) {
  const base = path.resolve(UPLOAD_DIR);
  const full = path.resolve(UPLOAD_DIR, path.basename(filename));
  if (!full.startsWith(base + path.sep) && full !== base) {
    const err = new Error("Invalid filename");
    err.status = 400;
    throw err;
  }
  return full;
}
