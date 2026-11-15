# emoryhacks
Emory Hacks Github Repo

## Pieces

| Path | Role |
|------|------|
| `website/` | Static IMPhotogenic UI (host on Vercel) |
| `api/` | Auth + gallery database/storage (host on a **separate** server) |
| `pose-agent/` | Chert FaceTime pose coach; uploads snaps into the gallery API |
| `pose-matcher/` | Landmark comparison library used by the agent |

Passwords are **bcrypt-hashed** in the API (not Typesense). Production should set
`DATABASE_URL` (Postgres) and `S3_BUCKET` (R2/S3) for cloud users + image storage;
local default is SQLite + disk. Each account has a gallery cap
(`GALLERY_MAX_ITEMS`, default 25) that auto-deletes the oldest shots. See
[`api/README.md`](api/README.md) for env vars and how to point the Vercel site +
Chert agent at that host.

## Standalone pose matcher

`pose-matcher/` extracts body landmarks from a reference photo and caller
snapshot, compares visible limb angles, and returns concise feedback. The Chert
agent in `pose-agent/` loads a reference from `reference-images/` (or
`POSE_REFERENCE_IMAGE`), coaches each live frame toward that skeleton, then
counts down and snaps when the pose matches. See
[`pose-matcher/README.md`](pose-matcher/README.md) for limitations.
