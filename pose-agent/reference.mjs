// Load a reference pose image for the matcher. Website uploads will replace the
// default sample path later; for now POSE_REFERENCE_IMAGE or references/sample.png.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoseMatcher, extractPoseFromImage, normalizePoseResult } from '../pose-matcher/src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REFERENCE_IMAGE = path.join(HERE, 'references', 'sample.png');
export const DEFAULT_REFERENCE_LANDMARKS = path.join(HERE, 'references', 'sample.landmarks.json');

/**
 * @param {string} filePath
 * @returns {string}
 */
export function mimeForImagePath(filePath) {
  const extension = filePath.toLowerCase().split('.').at(-1);
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function imagePathToDataUrl(filePath) {
  const bytes = await readFile(filePath);
  return `data:${mimeForImagePath(filePath)};base64,${bytes.toString('base64')}`;
}

/**
 * Map SAMPLE_SKELETON-style joints into matcher landmark keys.
 * @param {Record<string, [number, number]>} skeleton
 */
export function landmarksFromSampleSkeleton(skeleton) {
  const map = {
    nose: 'head',
    left_shoulder: 'leftShoulder',
    right_shoulder: 'rightShoulder',
    left_elbow: 'leftElbow',
    right_elbow: 'rightElbow',
    left_wrist: 'leftWrist',
    right_wrist: 'rightWrist',
    left_hip: 'leftHip',
    right_hip: 'rightHip',
    left_knee: 'leftKnee',
    right_knee: 'rightKnee',
    left_ankle: 'leftAnkle',
    right_ankle: 'rightAnkle',
  };
  const landmarks = {};
  for (const [joint, key] of Object.entries(map)) {
    const point = skeleton?.[key];
    if (!point) continue;
    landmarks[joint] = { x: point[0], y: point[1], confidence: 0.95 };
  }
  return normalizePoseResult({ landmarks, person_visible: Object.keys(landmarks).length >= 3 });
}

/**
 * @param {{ imagePath?: string }} [options]
 */
export function resolveReferenceImagePath(options = {}) {
  return options.imagePath
    || process.env.POSE_REFERENCE_IMAGE
    || DEFAULT_REFERENCE_IMAGE;
}

/**
 * Create a matcher and load the reference image (or sidecar landmarks for the sample).
 * @param {{
 *   imagePath?: string,
 *   landmarksPath?: string | null,
 *   extractPose?: (image: string) => Promise<{ personVisible: boolean, landmarks: Record<string, { x: number, y: number, confidence: number }> }>,
 * }} [options]
 */
export async function createLoadedPoseMatcher(options = {}) {
  const imagePath = resolveReferenceImagePath(options);
  const matcher = createPoseMatcher({
    extractPose: options.extractPose ?? (image => extractPoseFromImage(image)),
  });

  const landmarksPath = options.landmarksPath === null
    ? null
    : (options.landmarksPath
      ?? (imagePath === DEFAULT_REFERENCE_IMAGE ? DEFAULT_REFERENCE_LANDMARKS : null));

  if (landmarksPath) {
    try {
      const raw = JSON.parse(await readFile(landmarksPath, 'utf8'));
      matcher.setReferencePose(normalizePoseResult(raw));
      return { matcher, imagePath, landmarksPath, source: 'landmarks' };
    } catch {
      // Fall through to image extraction.
    }
  }

  const dataUrl = await imagePathToDataUrl(imagePath);
  await matcher.setReference(dataUrl);
  return { matcher, imagePath, landmarksPath: landmarksPath ?? null, source: 'image' };
}
