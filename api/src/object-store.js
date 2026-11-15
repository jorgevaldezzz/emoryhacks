/**
 * Image object store.
 *
 * - Local (default): files under UPLOAD_DIR
 * - Cloud: S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Supabase S3)
 *   when S3_BUCKET (+ credentials) is set.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { UPLOAD_DIR } from "./db.js";

/**
 * @returns {'local' | 's3'}
 */
export function objectStoreMode() {
  return process.env.S3_BUCKET?.trim() ? "s3" : "local";
}

function s3Config() {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket,
    region: process.env.S3_REGION?.trim() || "auto",
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim(),
    publicBase: process.env.S3_PUBLIC_URL?.replace(/\/$/, "") || null,
    prefix: (process.env.S3_PREFIX || "gallery/").replace(/^\//, ""),
  };
}

/** @type {import('@aws-sdk/client-s3').S3Client | null} */
let s3Client = null;

async function getS3() {
  const cfg = s3Config();
  if (!cfg) throw new Error("S3 is not configured");
  if (!cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for cloud image storage");
  }
  if (!s3Client) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    s3Client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }
  return { client: s3Client, cfg };
}

/**
 * @param {string} filename
 */
export function objectKey(filename) {
  const safe = path.basename(filename);
  const cfg = s3Config();
  if (!cfg) return safe;
  return `${cfg.prefix}${safe}`;
}

/**
 * @param {{ filename: string, buffer: Buffer, mime: string }} input
 */
export async function putImageObject(input) {
  const filename = path.basename(input.filename);
  if (objectStoreMode() === "s3") {
    const { client, cfg } = await getS3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: objectKey(filename),
        Body: input.buffer,
        ContentType: input.mime,
      })
    );
    return;
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), input.buffer);
}

/**
 * @param {string} filename
 */
export async function deleteImageObject(filename) {
  const safe = path.basename(filename);
  if (objectStoreMode() === "s3") {
    try {
      const { client, cfg } = await getS3();
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(
        new DeleteObjectCommand({
          Bucket: cfg.bucket,
          Key: objectKey(safe),
        })
      );
    } catch (err) {
      console.warn("[api] S3 delete failed:", err instanceof Error ? err.message : err);
    }
    return;
  }

  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, safe));
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
 * Public or API-proxied URL for a stored image.
 * @param {import('express').Request} req
 * @param {string} filename
 */
export async function imageUrlFor(req, filename) {
  const safe = path.basename(filename);
  if (objectStoreMode() === "s3") {
    const cfg = s3Config();
    if (cfg?.publicBase) {
      return `${cfg.publicBase}/${objectKey(safe)}`;
    }
    // Fall back to API proxy so private buckets still work.
  }
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${encodeURIComponent(safe)}`;
}

/**
 * Stream or buffer an image for the /uploads proxy.
 * @param {string} filename
 * @returns {Promise<{ stream: import('node:stream').Readable, contentType: string } | null>}
 */
export async function openImageObject(filename) {
  const safe = path.basename(filename);
  if (objectStoreMode() === "s3") {
    try {
      const { client, cfg } = await getS3();
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const out = await client.send(
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: objectKey(safe),
        })
      );
      if (!out.Body) return null;
      const stream =
        out.Body instanceof Readable
          ? out.Body
          : Readable.fromWeb(/** @type {any} */ (out.Body));
      return {
        stream,
        contentType: out.ContentType || guessMime(safe),
      };
    } catch {
      return null;
    }
  }

  const full = resolveUploadPath(safe);
  if (!fs.existsSync(full)) return null;
  return {
    stream: fs.createReadStream(full),
    contentType: guessMime(safe),
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
