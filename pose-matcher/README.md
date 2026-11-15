# MediaPipe pose matcher

This package compares normalized landmarks extracted by Google's MediaPipe Pose
Landmarker Tasks API. It has no xAI vision dependency: image inference runs in a
persistent Python process, while the Chert agent remains in Node and uses xAI
Realtime for voice.

## Runtime setup

From `pose-agent/`, install the Python runtime and download Google's Pose
Landmarker Full model:

```sh
python3 mediapipe/setup_mediapipe.py
```

`MediaPipePoseWorker` starts one JSON-lines sidecar and loads the model once.
Each request contains base64 encoded image bytes; each response contains all 33
MediaPipe normalized landmarks with visibility confidence. Pass either a data
URL or base64 string to `detect()`.

```js
import { createPoseMatcher, MediaPipePoseWorker } from './src/index.mjs';

const worker = new MediaPipePoseWorker();
// The application injects its Grok or other pose-pair comparison adapter here.
const comparePose = async posePair => poseComparisonService.compare(posePair);
const matcher = createPoseMatcher({
  extractPose: image => worker.detect(image),
  comparePose,
});
await matcher.setReference(referenceImageDataUrl);
const result = await matcher.check(callerImageDataUrl);
await worker.close();
```

Both the reference and caller images go through the same local model. The
matcher rejects no-person and low-confidence frames locally before invoking
`comparePose`. The Chert agent provides a Grok adapter that compares neutral
MediaPipe skeleton overlays, not the original photos, and returns one focused
correction or a match result. Comparison can remain uncertain when joints are
occluded or left/right is ambiguous.

Run the package checks with `npm test` and `npm run check`.
