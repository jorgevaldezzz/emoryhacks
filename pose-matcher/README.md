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
const matcher = createPoseMatcher({ extractPose: image => worker.detect(image) });
await matcher.setReference(referenceImageDataUrl);
const result = await matcher.check(callerImageDataUrl);
await worker.close();
```

Both the reference and caller images go through the same local model. When no
person is detected or too few limb landmarks are visible, the comparison asks
the caller to get into frame instead of inventing a correction. Comparison uses
elbow and knee angles, which are less sensitive to camera distance than raw
pixel positions. It requires at least 55% of the four limb chains to be visible,
ignores landmarks with confidence below 0.35, and reports at most two largest
mismatches. Single-image pose estimates remain approximate when joints are
occluded or left/right is ambiguous.

Run the package checks with `npm test` and `npm run check`.
