// Image-to-landmark extraction. The provider can be replaced by passing an
// extractPose function to createPoseMatcher, without changing comparison logic.
export const JOINTS = Object.freeze([
  'nose', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee',
  'right_knee', 'left_ankle', 'right_ankle',
]);

const PROMPT = `Estimate visible human pose landmarks in this image. Return JSON only, shaped as {"landmarks":{"nose":{"x":0.5,"y":0.2,"confidence":0.9},...},"person_visible":true}. Coordinates are normalized 0 to 1 from the image's top-left. Include these keys when visible: ${JOINTS.join(', ')}. Omit occluded or uncertain joints. Do not infer joints outside the image. confidence is 0 to 1. If no person is clearly visible, return {"landmarks":{},"person_visible":false}.`;

function parsePayload(payload) {
  let text = payload?.output_text;
  if (typeof text !== 'string') {
    text = (payload?.output ?? []).flatMap(item => item?.content ?? [])
      .map(part => part?.text).filter(value => typeof value === 'string').join('\n');
  }
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Pose extractor returned no JSON object.');
  return JSON.parse(match[0]);
}

export function normalizePoseResult(raw) {
  const landmarks = {};
  for (const joint of JOINTS) {
    const point = raw?.landmarks?.[joint];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) continue;
    landmarks[joint] = { x: point.x, y: point.y, confidence: Math.max(0, Math.min(1, Number(point.confidence) || 0)) };
  }
  return { personVisible: raw?.person_visible === true && Object.keys(landmarks).length >= 3, landmarks };
}

// grok-4.7 reasons before it answers, and this landmark prompt takes it 28-36 s on a
// single photo: 20 s aborted every call. Keep the ceiling well above that, and let
// POSE_VISION_TIMEOUT_MS tighten it where a caller cannot wait.
const DEFAULT_TIMEOUT_MS = 60_000;

/** Extract normalized landmarks from a data URL or base64 image using xAI. */
export async function extractPoseFromImage(image, {
  apiKey = process.env.XAI_API_KEY,
  model = process.env.POSE_VISION_MODEL || process.env.XAI_VISION_MODEL || 'grok-4.7',
  timeoutMs = Number(process.env.POSE_VISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('XAI_API_KEY is required for image pose extraction.');
  if (typeof image !== 'string' || !image) throw new TypeError('image must be a data URL or base64 string.');
  const imageUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
  const response = await fetchImpl('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // Reading landmarks off a photo needs looking, not deliberating: low effort answers
    // in ~13 s where the default spends ~40 s reasoning, for the same landmarks.
    body: JSON.stringify({ model, store: false, reasoning: { effort: 'low' }, input: [{ role: 'user', content: [
      { type: 'input_image', image_url: imageUrl, detail: 'high' },
      { type: 'input_text', text: PROMPT },
    ] }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Pose extraction failed (${response.status}): ${payload?.error?.message ?? response.statusText}`);
  return normalizePoseResult(parsePayload(payload));
}
