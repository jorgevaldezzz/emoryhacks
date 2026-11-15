import { randomUUID } from "node:crypto";
import {
  deleteGalleryItem,
  findGalleryItemForUser,
  GALLERY_QUOTA_BYTES,
  insertGalleryItem,
} from "./db.js";

export const MAX_GALLERY_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function assertAllowedMime(mime) {
  if (!ALLOWED_MIME.has(mime)) {
    const err = new Error("Only JPEG, PNG, WebP, and GIF images are allowed");
    err.status = 400;
    throw err;
  }
}

export async function saveGalleryImage(input) {
  assertAllowedMime(input.mime);
  if (!input.buffer?.length) {
    const err = new Error("Image data is empty");
    err.status = 400;
    throw err;
  }
  if (input.buffer.length > MAX_GALLERY_IMAGE_BYTES) {
    const err = new Error("Image is too large (max 8 MiB)");
    err.status = 413;
    throw err;
  }

  const item = {
    _id: randomUUID(),
    userId: input.userId,
    image: input.buffer,
    mimeType: input.mime,
    byteSize: input.buffer.length,
    originalName: input.originalName ?? null,
    note: input.note ?? null,
    source: input.source || "upload",
    createdAt: new Date().toISOString(),
  };
  const saved = await insertGalleryItem(item);
  if (!saved) {
    const quotaMiB = Math.floor(GALLERY_QUOTA_BYTES / (1024 * 1024));
    const err = new Error(`Gallery storage limit reached (${quotaMiB} MiB per account)`);
    err.status = 413;
    throw err;
  }

  return {
    id: item._id,
    originalName: item.originalName,
    note: item.note,
    source: item.source,
    createdAt: item.createdAt,
    byteSize: item.byteSize,
  };
}

export async function removeGalleryImage(id, userId) {
  return deleteGalleryItem(id, userId);
}

export async function getGalleryImage(id, userId) {
  return findGalleryItemForUser(id, userId);
}
