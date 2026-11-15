# emoryhacks
Emory Hacks Github Repo

## Pieces

| Path | Role |
|------|------|
| `website/` | Static IMPhotogenic UI (host on Vercel) |
| `api/` | Auth + gallery database/storage (host on a **separate** server) |
| `pose-agent/` | Chert FaceTime pose coach; uploads snaps into the gallery API |
| `pose-matcher/` | Landmark comparison library used by the agent |

Passwords are **bcrypt-hashed** in the API. Gallery images live on the API
host’s disk; metadata and users live in SQLite. See [`api/README.md`](api/README.md)
for deploy env vars and how to point the Vercel site + Chert agent at that host.

## Standalone pose matcher

`pose-matcher/` extracts body landmarks from a reference photo and caller
snapshot, compares visible limb angles, and returns concise feedback. The Chert
agent in `pose-agent/` loads a reference from `reference-images/` (or
`POSE_REFERENCE_IMAGE`), coaches each live frame toward that skeleton, then
counts down and snaps when the pose matches. See
[`pose-matcher/README.md`](pose-matcher/README.md) for limitations.
