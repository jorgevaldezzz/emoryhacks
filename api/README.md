# IMPhotogenic API

Backend for the Vercel website and Chert pose agent. User records and gallery
images live in MongoDB Atlas in the `imphotogenic` database.

- **Users** — normalized email, display name, bcrypt password hash, and usage
  counters. Passwords are one-way hashed and never stored as plaintext.
- **Sessions** — JWT bearer tokens.
- **Gallery** — one MongoDB document per image, associated with its user.
- **Quota** — 100 MiB of image bytes per account by default. Each image is
  limited to 8 MiB. Quota reservation is atomic, and deleting an image frees
  its bytes.
- **Chert ingest** — pose snaps posted into a user's gallery via a shared secret.
- **Location recommendations** — Grok classifies a reference background and
  Typesense returns up to three nearby matching photo spots.

## Configure and run

```sh
cp api/.env.example api/.env
# Set MongoDB, auth, Grok, Typesense, and CORS values in api/.env.
npm install
npm start --workspace api
```

Use a MongoDB Atlas database user with only `readWrite` access to `imphotogenic`.
Set `MONGODB_URI` to its SRV connection string and keep the credentials in the
host's environment variables or an untracked `.env` file. Never commit secrets.
`MONGODB_DATABASE` defaults to `imphotogenic`; `GALLERY_QUOTA_BYTES` defaults to
`104857600` (100 MiB).

Health check: `GET http://127.0.0.1:8787/health`

The location recommendation route requires `XAI_API_KEY`, `TYPESENSE_URL`,
and a read-only `TYPESENSE_SEARCH_KEY`. It only returns useful results where
the `photo_spots` collection is populated. Seed the curated Atlanta places
from `typesense/` for the local demo; add Atlanta OSM data for broader coverage.
Grok classifies the reference background into one fixed tag group: park,
skatepark, BeltLine, and water; campus, architecture, and marble; historic,
Sweet Auburn, and landmark; or garden, greenery, and ticketed. Typesense uses
the group's categories and query to return up to three results within 10 km.
Coordinates are used for the search and are not saved.

## Deploy

This API can run on Railway, Render, Fly, a VPS, or another Node host. Configure
`MONGODB_URI`, `JWT_SECRET`, `GALLERY_INGEST_SECRET`, `CORS_ORIGIN`,
`XAI_API_KEY`, `TYPESENSE_URL`, and `TYPESENSE_SEARCH_KEY` in the host's
environment. No persistent local disk is needed for gallery images.

```sh
docker build -f api/Dockerfile -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e MONGODB_URI="$MONGODB_URI" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e GALLERY_INGEST_SECRET="$GALLERY_INGEST_SECRET" \
  -e CORS_ORIGIN=https://your-app.vercel.app \
  -e XAI_API_KEY="$XAI_API_KEY" \
  -e TYPESENSE_URL="$TYPESENSE_URL" \
  -e TYPESENSE_SEARCH_KEY="$TYPESENSE_SEARCH_KEY" \
  imphotogenic-api
```

### Render dashboard settings

The API depends on the root npm workspace because its recommendation route
imports `typesense/`. Configure the Render web service connected to this repo:

1. Set the branch to `main` and leave **Root Directory** empty (repository
   root).
2. Set **Runtime** to **Docker**, **Dockerfile Path** to `api/Dockerfile`, and
   **Docker Context Directory** to `.` (repository root).
3. Add `MONGODB_URI`, `JWT_SECRET`, `GALLERY_INGEST_SECRET`, and
   `CORS_ORIGIN`. For this site, set `CORS_ORIGIN` to
   `https://www.myboyfriendtakeshorriblephotos.club,https://myboyfriendtakeshorriblephotos.club`.
4. Add `XAI_API_KEY`, `TYPESENSE_URL`, and `TYPESENSE_SEARCH_KEY`. The
   Typesense URL must be reachable from Render; do not use `localhost` unless
   Typesense runs in the same container.
5. Save, then choose **Manual Deploy → Deploy latest commit**. Confirm the
   deployed commit includes `api/src/routes/locations.js` and the build
   succeeds.

Render's root directory controls which repository files are available during
the build, and Dockerfile/context paths are relative to that root. This service
must use the repository root so the image can copy both `api/` and `typesense/`.
See [Render monorepo support](https://render.com/docs/monorepo-support) and
[Render's Docker service settings](https://render.com/docs/docker).

Verify the route exists after deployment with:

```sh
curl -i -X POST https://imphotogenic-api.onrender.com/api/locations/recommendations
```

Without a bearer token this should return `401 Unauthorized`; `404 Cannot POST`
means Render is still serving an older deployment or the wrong service.

## Wire the website (Vercel)

Deploy the API to a public Node host, then set its public origin in
`website/config.js` as `IMPHOTOGENIC_API_URL` (or set it in the browser):

```js
localStorage.setItem("IMPHOTOGENIC_API_URL", "https://your-api-host.example.com");
```

The website uses the local API address only when opened on `localhost` or
`127.0.0.1`; hosted pages do not send account requests to a visitor's computer.

## Wire the Chert agent

In `pose-agent/.env.local`:

```sh
GALLERY_API_URL=https://your-api-host.example.com
GALLERY_INGEST_SECRET=same-as-api
GALLERY_USER_EMAIL=you@email.com   # must already have signed up on the site
```

Each FaceTime snap is saved under `pose-agent/captures/` and also posted to
`POST /api/gallery/chert`.

## API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/signup` | — | Create account (password hashed with bcrypt) |
| POST | `/api/auth/login` | — | Log in → JWT |
| GET | `/api/auth/me` | Bearer | Current user |
| GET | `/api/gallery` | Bearer | List gallery items and storage usage |
| POST | `/api/gallery` | Bearer | Upload inspiration (`image` file or `imageBase64`) |
| DELETE | `/api/gallery/:id` | Bearer | Remove an item and reclaim quota |
| POST | `/api/gallery/chert` | `X-Ingest-Secret` | Agent snap → user gallery |
| GET | `/uploads/:id` | — | Serve image bytes stored in Atlas |
| POST | `/api/locations/recommendations` | Bearer | Multipart `image`, `lat`, `lng` → classified background and up to three nearby places |
