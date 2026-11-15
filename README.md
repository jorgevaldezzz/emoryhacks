# emoryhacks
Emory Hacks Github Repo

## Pieces

| Path | Role |
|------|------|
| `website/` | Static IMPhotogenic UI (host on Vercel) |
| `api/` | Auth + gallery database/storage (host on a **separate** server) |
| `pose-agent/` | Chert FaceTime pose coach; uploads snaps into the gallery API |
| `pose-matcher/` | Landmark comparison library used by the agent |

Passwords are **bcrypt-hashed** in the API and stored in **MongoDB Atlas** with
the username (not Typesense). Gallery image bytes go to **Vercel Blob**; each
item’s metadata/URL is attached to the user account in MongoDB. Each account has
a gallery cap (`GALLERY_MAX_ITEMS`, default 25) that auto-deletes the oldest
shots. See [`api/README.md`](api/README.md) for `MONGODB_URI` +
`BLOB_READ_WRITE_TOKEN` and how to point the Vercel site + Chert agent at the API.

## Standalone pose matcher

`pose-matcher/` extracts body landmarks from a reference photo and caller
snapshot, compares visible limb angles, and returns concise feedback. The Chert
agent in `pose-agent/` loads a reference from `reference-images/` (or
`POSE_REFERENCE_IMAGE`), coaches each live frame toward that skeleton, then
counts down and snaps when the pose matches. See
[`pose-matcher/README.md`](pose-matcher/README.md) for limitations.
