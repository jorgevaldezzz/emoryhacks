# emoryhacks
Emory Hacks Github Repo

## Standalone pose matcher

`pose-matcher/` extracts body landmarks from a reference photo and caller
snapshot, compares visible limb angles, and returns concise feedback. The Chert
agent in `pose-agent/` loads a reference from `reference-images/` (or
`POSE_REFERENCE_IMAGE`), coaches each live frame toward that skeleton, then
counts down and snaps when the pose matches. See
[`pose-matcher/README.md`](pose-matcher/README.md) for limitations.
