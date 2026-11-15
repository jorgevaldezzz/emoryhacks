# emoryhacks
Emory Hacks Github Repo

## Pieces

| Path | Role |
|------|------|
| `website/` | Static IMPhotogenic UI (host on Vercel) |
| `api/` | Auth + MongoDB Atlas gallery API (host on a **separate** server) |
| `pose-agent/` | Chert FaceTime pose coach; uploads snaps into the gallery API |
| `pose-matcher/` | Landmark comparison library used by the agent |

Passwords are **bcrypt-hashed** in the API. Users, gallery metadata, and image
bytes live in MongoDB Atlas. Each account has a 100 MiB gallery quota by
default. See [`api/README.md`](api/README.md) for configuration and deployment.

## Standalone pose matcher

`pose-matcher/` extracts body landmarks from a reference photo and caller
snapshot, compares visible limb angles, and returns concise feedback. The Chert
agent in `pose-agent/` loads a reference from `reference-images/` (or
`POSE_REFERENCE_IMAGE`), coaches each live frame toward that skeleton, then
counts down and snaps when the pose matches. See
[`pose-matcher/README.md`](pose-matcher/README.md) for limitations.
