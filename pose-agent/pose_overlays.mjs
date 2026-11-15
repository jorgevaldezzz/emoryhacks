import sharp from 'sharp';

const WIDTH = 900;
const HEIGHT = 640;
const PAD = 72;
const BODY_WIDTH = 620;
const LABELS = [
  ['nose', 'head'], ['left_shoulder', 'L shoulder'], ['right_shoulder', 'R shoulder'],
  ['left_elbow', 'L elbow'], ['right_elbow', 'R elbow'], ['left_wrist', 'L wrist'],
  ['right_wrist', 'R wrist'], ['left_hip', 'L hip'], ['right_hip', 'R hip'],
  ['left_knee', 'L knee'], ['right_knee', 'R knee'], ['left_ankle', 'L ankle'],
  ['right_ankle', 'R ankle'],
];
const BONES = [
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'], ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
];

/** Render only normalized MediaPipe joints on a plain canvas; source imagery is never included. */
export async function renderPoseOverlay(pose) {
  const points = new Map();
  for (const [key] of LABELS) {
    const point = pose?.landmarks?.[key];
    if (!point || point.confidence < 0.35 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    points.set(key, point);
  }
  if (points.size < 4) throw new Error('Not enough confident landmarks to render a pose overlay.');
  const aspect = Number.isFinite(pose.imageWidth / pose.imageHeight) ? pose.imageWidth / pose.imageHeight : 1;
  const minX = Math.min(...[...points.values()].map(point => point.x * aspect));
  const maxX = Math.max(...[...points.values()].map(point => point.x * aspect));
  const minY = Math.min(...[...points.values()].map(point => point.y));
  const maxY = Math.max(...[...points.values()].map(point => point.y));
  const scale = Math.min((BODY_WIDTH - PAD * 2) / Math.max(maxX - minX, 0.05), (HEIGHT - PAD * 2) / Math.max(maxY - minY, 0.05));
  const offsetX = (BODY_WIDTH - (maxX - minX) * scale) / 2;
  const offsetY = (HEIGHT - (maxY - minY) * scale) / 2;
  const xy = point => ({ x: offsetX + (point.x * aspect - minX) * scale, y: offsetY + (point.y - minY) * scale });
  const lines = BONES.filter(([a, b]) => points.has(a) && points.has(b)).map(([a, b]) => {
    const p1 = xy(points.get(a)), p2 = xy(points.get(b));
    return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>`;
  }).join('');
  const visibleLabels = LABELS.filter(([key]) => points.has(key));
  const joints = visibleLabels.map(([key], index) => {
    const p = xy(points.get(key));
    return `<g><circle cx="${p.x}" cy="${p.y}" r="13"/><text x="${p.x}" y="${p.y + 5}" text-anchor="middle" fill="#ffffff" stroke="none" font-size="13">${index + 1}</text></g>`;
  }).join('');
  const legend = visibleLabels.map(([, label], index) => {
    const y = 72 + index * 38;
    return `<text x="650" y="${y}">${index + 1}. ${label}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="100%" height="100%" fill="#f6f7fb"/><g fill="none" stroke="#d946ef" stroke-width="8" stroke-linecap="round">${lines}</g><g fill="#171923" stroke="#f6f7fb" stroke-width="3" font-family="Arial,sans-serif" font-size="13" font-weight="700">${joints}</g><line x1="625" y1="30" x2="625" y2="610" stroke="#d4d7e0"/><g fill="#171923" font-family="Arial,sans-serif" font-size="20" font-weight="600">${legend}</g></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
