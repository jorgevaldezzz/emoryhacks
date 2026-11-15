// Test-only stills of the caller with their live pose drawn on.
// Written to disk. Never published on the FaceTime track.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { VideoBufferType } from '@livekit/rtc-node';

export const DEBUG_SKELETON_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'debug-skeletons',
);

const BONE = [64, 214, 255];
const JOINT = [255, 176, 64];
const BONES = [
  ['nose', 'left_shoulder'],
  ['nose', 'right_shoulder'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

/**
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number[]} color
 */
function drawLine(pixels, width, height, x0, y0, x1, y1, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (dx * i) / steps);
    const y = Math.round(y0 + (dy * i) / steps);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const idx = (y * width + x) * 4;
    pixels[idx] = color[0];
    pixels[idx + 1] = color[1];
    pixels[idx + 2] = color[2];
    pixels[idx + 3] = 255;
  }
}

/**
 * @param {Record<string, { x: number, y: number, confidence?: number }> | null | undefined} landmarks
 * @param {string} key
 * @returns {{ x: number, y: number } | null}
 */
function point(landmarks, key) {
  const joint = landmarks?.[key];
  if (!joint || !Number.isFinite(joint.x) || !Number.isFinite(joint.y)) return null;
  if (joint.x < 0 || joint.x > 1 || joint.y < 0 || joint.y > 1) return null;
  if (Number.isFinite(joint.confidence) && joint.confidence < 0.35) return null;
  return joint;
}

/**
 * Draw the caller's current pose into an RGBA buffer. Returns how many joints were drawn.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {Record<string, { x: number, y: number, confidence?: number }> | null | undefined} landmarks
 * @returns {number}
 */
export function drawPoseSkeleton(pixels, width, height, landmarks) {
  const placed = new Map();
  for (const key of new Set(BONES.flat())) {
    const joint = point(landmarks, key);
    if (!joint) continue;
    placed.set(key, [Math.round(joint.x * (width - 1)), Math.round(joint.y * (height - 1))]);
  }
  for (const [a, b] of BONES) {
    const start = placed.get(a);
    const end = placed.get(b);
    if (!start || !end) continue;
    drawLine(pixels, width, height, start[0], start[1], end[0], end[1], BONE);
  }
  for (const [x, y] of placed.values()) {
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        if (ox * ox + oy * oy > 4) continue;
        const px = x + ox;
        const py = y + oy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const idx = (py * width + px) * 4;
        pixels[idx] = JOINT[0];
        pixels[idx + 1] = JOINT[1];
        pixels[idx + 2] = JOINT[2];
        pixels[idx + 3] = 255;
      }
    }
  }
  return placed.size;
}

/**
 * Save a caller frame with the live skeleton drawn on it.
 * This file is for local testing. It is not shown on the call.
 * @param {{ data: Uint8Array | Buffer, width: number, height: number, type?: number, convert?: Function }} frame
 * @param {Record<string, { x: number, y: number, confidence?: number }> | null | undefined} landmarks
 * @param {{ dir?: string, at?: Date }} [options]
 * @returns {Promise<string | null>}
 */
export async function saveDebugSkeleton(frame, landmarks, options = {}) {
  const rgba = frame?.type === VideoBufferType.RGBA || typeof frame?.convert !== 'function'
    ? frame
    : frame.convert(VideoBufferType.RGBA);
  if (!rgba?.data?.length || !rgba.width || !rgba.height) return null;
  const pixels = new Uint8Array(rgba.data);
  drawPoseSkeleton(pixels, rgba.width, rgba.height, landmarks);
  const bytes = await sharp(Buffer.from(pixels), {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  }).png().toBuffer();
  const dir = options.dir ?? DEBUG_SKELETON_DIR;
  await mkdir(dir, { recursive: true });
  const stamp = (options.at ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${stamp}.png`);
  await writeFile(filePath, bytes);
  return filePath;
}
