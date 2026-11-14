# emoryhacks
Emory Hacks Github Repo

## Standalone pose matcher

`pose-matcher/` extracts body landmarks from a reference photo and caller
snapshot, compares visible limb angles, and returns concise feedback. The Chert
agent in `pose-agent/` loads a reference from `reference-images/` (or
`POSE_REFERENCE_IMAGE`) for vision coaching via `guide_pose`, and exposes
`match_reference_pose` for the landmark-angle score. See
[`pose-matcher/README.md`](pose-matcher/README.md) for limitations.
