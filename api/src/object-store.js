/**
 * Gallery image bytes on local disk (UPLOAD_DIR).
 * Metadata (url / storageKey) lives in MongoDB — see models.js.
 */

import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "./db.js";

/**
 * @param {{ filename: string, buffer: Buffer, mime: string }} input
 * @returns {Promise<{ filename: string, url: string | null, storageKey: string }>}
 */
export async function putImageObject(input) {
  const filename = path.basename(input.filename);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), input.buffer);
  return { filename, url: null, storageKey: filename };
}

/**
 * @param {{ filename?: string | null, storageKey?: string | null }} item
 */
export async function deleteImageObject(item) {
  const key = item.storageKey || item.filename;
  if (!key) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(key)));
  } catch {
    // Missing file is fine.
  }
}

/**
 * Absolute local path (path-traversal safe).
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

/**
 * Public URL for a gallery item (API-hosted /uploads proxy).
 * @param {import('express').Request} req
 * @param {{ filename?: string | null, url?: string | null, storageKey?: string | null }} item
 */
export function imageUrlFor(req, item) {
  if (item.url) return item.url;
  const name = item.filename || item.storageKey || "";
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${encodeURIComponent(path.basename(name))}`;
}

/**
 * Stream a stored image for the /uploads proxy.
 * @param {string} filename
 */
export function openImageObject(filename) {
  const full = resolveUploadPath(filename);
  if (!fs.existsSync(full)) return null;
  return {
    stream: fs.createReadStream(full),
    contentType: guessMime(filename),
  };
}

/**
 * @param {string} filename
 */
function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}
