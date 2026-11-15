import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { drawPoseSkeleton } from './debug_skeleton.mjs';
import { loadReferenceImage } from './reference_pose.mjs';
import { MediaPipePoseWorker } from '../pose-matcher/src/mediapipe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(HERE, 'debug-skeletons', 'reference-mediapipe.png'));
const reference = await loadReferenceImage();
if (!reference) throw new Error('No reference image found in reference-images/ or POSE_REFERENCE_IMAGE.');

const worker = new MediaPipePoseWorker();
try {
  const [bytes, pose] = await Promise.all([
    readFile(reference.path),
    worker.detect(reference.dataUrl),
  ]);
  if (!pose?.personVisible) throw new Error(`MediaPipe did not detect a person in ${reference.path}`);
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(decoded.data);
  const drawn = drawPoseSkeleton(pixels, decoded.info.width, decoded.info.height, pose.landmarks);
  if (drawn < 4) throw new Error(`MediaPipe returned too few visible landmarks (${drawn}) to draw a useful skeleton.`);
  const png = await sharp(Buffer.from(pixels), {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
  }).png().toBuffer();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, png);
  console.log(`Reference: ${reference.path}`);
  console.log(`MediaPipe joints drawn: ${drawn}`);
  console.log(`Overlay: ${output}`);
} finally {
  await worker.close();
}
