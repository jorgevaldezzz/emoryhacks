// Internal sample reference pose used only for comparing silent looks / guidance.
// Not drawn on FaceTime — the caller sees the AI face, not this stick figure.
// Standing portrait: head, torso, arms slightly out, feet planted.

const INK = [236, 244, 248];
const JOINT = [255, 200, 118];

/** Normalized joints in [0,1] space for a standing sample pose. */
export const SAMPLE_SKELETON = {
  head: [0.50, 0.16],
  neck: [0.50, 0.26],
  leftShoulder: [0.38, 0.30],
  rightShoulder: [0.62, 0.30],
  leftElbow: [0.28, 0.44],
  rightElbow: [0.72, 0.44],
  leftWrist: [0.24, 0.58],
  rightWrist: [0.76, 0.58],
  hip: [0.50, 0.52],
  leftHip: [0.44, 0.52],
  rightHip: [0.56, 0.52],
  leftKnee: [0.43, 0.70],
  rightKnee: [0.57, 0.70],
  leftAnkle: [0.42, 0.88],
  rightAnkle: [0.58, 0.88],
};

/**
 * Compact text description of the target pose for the vision model.
 * @param {typeof SAMPLE_SKELETON} [skeleton]
 * @returns {string}
 */
export function describeSampleSkeleton(skeleton = SAMPLE_SKELETON) {
  const joints = Object.entries(skeleton)
    .map(([name, [x, y]]) => `${name}=(${x.toFixed(2)},${y.toFixed(2)})`)
    .join(', ');
  return `Standing portrait facing the camera: head near top-center, arms slightly out from the sides, feet planted about shoulder-width. Normalized joints (x,y in 0..1, origin top-left): ${joints}.`;
}

const BONES = [
  ['head', 'neck'],
  ['neck', 'leftShoulder'],
  ['neck', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['neck', 'hip'],
  ['hip', 'leftHip'],
  ['hip', 'rightHip'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
];

/**
 * @param {number} nx
 * @param {number} ny
 * @param {number} width
 * @param {number} height
 */
function px(nx, ny, width, height) {
  return [Math.round(nx * width), Math.round(ny * height)];
}

/**
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number[]} color
 * @param {number} thickness
 */
function drawLine(pixels, width, height, x0, y0, x1, y1, color, thickness = 3) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (dx * i) / steps);
    const y = Math.round(y0 + (dy * i) / steps);
    for (let oy = -thickness; oy <= thickness; oy++) {
      for (let ox = -thickness; ox <= thickness; ox++) {
        if (ox * ox + oy * oy > thickness * thickness) continue;
        const px_ = x + ox;
        const py = y + oy;
        if (px_ < 0 || py < 0 || px_ >= width || py >= height) continue;
        const idx = (py * width + px_) * 4;
        pixels[idx] = color[0];
        pixels[idx + 1] = color[1];
        pixels[idx + 2] = color[2];
        pixels[idx + 3] = 255;
      }
    }
  }
}

/**
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @param {number[]} color
 */
function drawDisk(pixels, width, height, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      const idx = (y * width + x) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = 255;
    }
  }
}

/**
 * Draw the sample skeleton into an existing RGBA buffer.
 * @param {Uint8Array} pixels
 * @param {{ width?: number, height?: number, skeleton?: typeof SAMPLE_SKELETON }} [options]
 */
export function drawSampleSkeleton(pixels, options = {}) {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const skeleton = options.skeleton ?? SAMPLE_SKELETON;
  for (const [a, b] of BONES) {
    const [x0, y0] = px(skeleton[a][0], skeleton[a][1], width, height);
    const [x1, y1] = px(skeleton[b][0], skeleton[b][1], width, height);
    drawLine(pixels, width, height, x0, y0, x1, y1, INK, 3);
  }
  for (const point of Object.values(skeleton)) {
    const [x, y] = px(point[0], point[1], width, height);
    const radius = point === skeleton.head ? 18 : 6;
    drawDisk(pixels, width, height, x, y, radius, point === skeleton.head ? INK : JOINT);
  }
}
