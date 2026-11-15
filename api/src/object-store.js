/**
 * Gallery image bytes.
 *
 * Production: Vercel Blob (`BLOB_READ_WRITE_TOKEN`).
 * Tests / local without a token: files under UPLOAD_DIR (API proxies via /uploads).
 */

import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "./db.js";

/**
 * @returns {'vercel-blob' | 'local'}
 */
export function objectStoreMode() {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ? "vercel-blob" : "local";
}

/**
 * @param {{ filename: string, buffer: Buffer, mime: string }} input
 * @returns {Promise<{ filename: string, url: string | null, pathname: string | null }>}
 */
export async function putImageObject(input) {
  const filename = path.basename(input.filename);
  const pathname = `gallery/${filename}`;

  if (objectStoreMode() === "vercel-blob") {
    const { put } = await import("@vercel/blob");
    const blob = await put(pathname, input.buffer, {
      access: "public",
      contentType: input.mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return {
      filename,
      url: blob.url,
      pathname: blob.pathname || pathname,
    };
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), input.buffer);
  return { filename, url: null, pathname: null };
}

/**
 * @param {{ filename?: string | null, url?: string | null, pathname?: string | null }} item
 */
export async function deleteImageObject(item) {
  if (objectStoreMode() === "vercel-blob") {
    const target = item.url || item.pathname;
    if (!target) return;
    try {
      const { del } = await import("@vercel/blob");
      await del(target, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } catch (err) {
      console.warn("[api] Vercel Blob delete failed:", err instanceof Error ? err.message : err);
    }
    return;
  }

  if (!item.filename) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(item.filename)));
  } catch {
    // Missing file is fine.
  }
}

/**
 * Absolute local path (path-traversal safe). Only for local mode.
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
 * Public URL for a gallery item.
 * @param {import('express').Request} req
 * @param {{ filename: string, url?: string | null }} item
 */
export async function imageUrlFor(req, item) {
  if (item.url) return item.url;
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${encodeURIComponent(path.basename(item.filename))}`;
}

/**
 * Stream a locally stored image for the /uploads proxy.
 * @param {string} filename
 */
export async function openImageObject(filename) {
  if (objectStoreMode() === "vercel-blob") {
    // Public blob URLs are served by Vercel CDN; proxy is only for local mode.
    return null;
  }
  const full = resolveUploadPath(filename);
  if (!fs.existsSync(full)) return null;
  const { createReadStream } = await import("node:fs");
  return {
    stream: createReadStream(full),
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
