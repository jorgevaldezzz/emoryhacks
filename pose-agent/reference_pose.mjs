// Resolve the development reference photo used as the coaching target.
// Prefer POSE_REFERENCE_IMAGE; otherwise use the first image in reference-images/.
import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const REFERENCE_IMAGES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'reference-images',
);

/**
 * @param {string} filePath
 * @returns {string}
 */
export function mimeForImagePath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * @param {string} [envPath]
 * @param {string} [dir]
 * @returns {Promise<string | null>}
 */
export async function resolveReferenceImagePath(envPath = process.env.POSE_REFERENCE_IMAGE, dir = REFERENCE_IMAGES_DIR) {
  const configured = typeof envPath === 'string' ? envPath.trim() : '';
  if (configured) {
    await access(configured);
    return path.resolve(configured);
  }
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const image = names
    .filter(name => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))[0];
  return image ? path.join(dir, image) : null;
}

/**
 * @param {string} [envPath]
 * @param {string} [dir]
 * @returns {Promise<{ path: string, mime: string, dataUrl: string } | null>}
 */
export async function loadReferenceImage(envPath = process.env.POSE_REFERENCE_IMAGE, dir = REFERENCE_IMAGES_DIR) {
  const filePath = await resolveReferenceImagePath(envPath, dir);
  if (!filePath) return null;
  const bytes = await readFile(filePath);
  const mime = mimeForImagePath(filePath);
  return {
    path: filePath,
    mime,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
  };
}
