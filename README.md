# emoryhacks
Emory Hacks Github Repo

## Standalone pose matcher

`pose-matcher/` is an independent reference-pose comparison package. It extracts
body landmarks from a reference photo and caller snapshot, compares visible limb
angles, and exposes concise feedback for a voice agent. See
[`pose-matcher/README.md`](pose-matcher/README.md) for use and limitations. It
is kept separate from `pose-agent/` and is not connected to the FaceTime call
flow yet.
