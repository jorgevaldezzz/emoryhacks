# Pose matcher (standalone)

An isolated reference-pose checker. It turns a reference photo and a caller
snapshot into normalized body landmarks, compares visible limb angles, and
returns a short correction for a voice agent. It does not change or import the
existing `pose-agent`.

## Use

```js
import { createPoseMatcher, extractPoseFromImage } from './src/index.mjs';

const matcher = createPoseMatcher({
  extractPose: image => extractPoseFromImage(image),
  onResult: result => voiceSession.generateReply({
    instructions: `Tell the caller this pose feedback in one sentence: ${result.feedback}`,
  }),
});

await matcher.setReference(referenceImageDataUrl);
// Call on an explicit user request, or start opt-in periodic checks:
await matcher.check(callerImageDataUrl);
// matcher.startPeriodic({ getImage: captureCurrentFrame });
```

Images may be data URLs or base64 strings. `XAI_API_KEY` is required only when
using the built-in xAI extractor. `extractPose` is injectable so a dedicated
pose-estimation model can replace it without changing the matcher.

The default cadence is 12 seconds and periodic sampling is off. Prefer an
explicit “check my pose” action while the user is adjusting; periodic checks
can be enabled after the caller opts in. Use `stopPeriodic()` when the call ends.
Only landmarks and brief feedback need to reach the voice agent; the matcher
does not retain image files. The built-in extractor sends each supplied image
to xAI's Responses API with `store: false`.

Comparison uses elbow and knee angles, so it tolerates differences in camera
distance better than raw pixel comparison. It requires at least 55% of its four
limb chains to be visible, ignores low-confidence joints, and reports at most
two largest mismatches. This is a prototype: monocular image estimates can
confuse left/right, occlusion, or perspective, so feedback stays approximate.

## Chert integration

`onResult` is the adapter boundary: provide a callback that asks the existing
voice session to speak `result.feedback`. The package has no Chert, LiveKit, or
camera dependency and does not upload photos to Chert. A later integration can
provide the FaceTime frame capture function and voice callback without coupling
pose matching to the current agent implementation.

Run the package checks from this directory with `npm test` and `npm run check`.
