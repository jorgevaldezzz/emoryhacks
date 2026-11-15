# IMPhotogenic API

Separate backend for the Vercel website and the Chert pose agent.

- **Users** — email + **bcrypt-hashed** passwords (never stored in plaintext)
- **Sessions** — JWT bearer tokens
- **Gallery** — image files on disk + metadata in SQLite
- **Chert ingest** — pose snaps posted into a user’s gallery via a shared secret
- **Location recommendations** — Grok reads a reference background; Typesense finds nearby matching photo spots

## Run locally

```sh
cp api/.env.example api/.env
# edit JWT_SECRET, GALLERY_INGEST_SECRET, CORS_ORIGIN,
# XAI_API_KEY, TYPESENSE_URL, and TYPESENSE_SEARCH_KEY
npm install
cd api
npm start
```

Health check: `GET http://127.0.0.1:8787/health`

The location recommendation route uses the read-only Typesense search key and
Grok's vision API. It returns useful results only where the `photo_spots`
collection is populated. For the current Atlanta data, start Typesense and seed
the curated spots from `../typesense` before using the website. Add Atlanta OSM
data for broader local coverage.

## Deploy on another server

This is meant to live **off Vercel** (Railway, Render, Fly.io, a VPS, etc.):

1. Set `JWT_SECRET`, `GALLERY_INGEST_SECRET`, and `CORS_ORIGIN` to your Vercel domain.
2. Mount persistent volumes for `DATA_DIR` / `UPLOAD_DIR` (or the defaults `./data` and `./uploads`).
3. Set `XAI_API_KEY`, `XAI_BACKGROUND_MODEL` (default `grok-4.7`), `TYPESENSE_URL`, and `TYPESENSE_SEARCH_KEY` on the API host. Keep all keys server-side.
4. Expose `PORT` (default `8787`).

Docker build context is the repository root because the API shares the Typesense
workspace:

```sh
cd ..
docker build -f api/Dockerfile -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e JWT_SECRET=... \
  -e GALLERY_INGEST_SECRET=... \
  -e CORS_ORIGIN=https://your-app.vercel.app \
  -e XAI_API_KEY=... \
  -e TYPESENSE_URL=https://your-typesense-host:443 \
  -e TYPESENSE_SEARCH_KEY=... \
  -v imphoto-data:/data -v imphoto-uploads:/uploads \
  imphotogenic-api
```

## Wire the website (Vercel)

In the browser (or edit `website/config.js`):

```js
localStorage.setItem("IMPHOTOGENIC_API_URL", "https://your-api-host.example.com");
```

## Wire the Chert agent

In `pose-agent/.env.local`:

```sh
GALLERY_API_URL=https://your-api-host.example.com
GALLERY_INGEST_SECRET=same-as-api
GALLERY_USER_EMAIL=you@email.com   # must already have signed up on the site
```

Each FaceTime snap is saved under `pose-agent/captures/` and also posted to `POST /api/gallery/chert`.

## API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/signup` | — | Create account (password hashed with bcrypt) |
| POST | `/api/auth/login` | — | Log in → JWT |
| GET | `/api/auth/me` | Bearer | Current user |
| GET | `/api/gallery` | Bearer | List gallery items |
| POST | `/api/gallery` | Bearer | Upload inspiration (`image` file or `imageBase64`) |
| DELETE | `/api/gallery/:id` | Bearer | Remove an item |
| POST | `/api/gallery/chert` | `X-Ingest-Secret` | Agent snap → user gallery |
| POST | `/api/locations/recommendations` | Bearer | Multipart `image`, `lat`, `lng` → background label and nearby matching spots |
| GET | `/uploads/:filename` | — | Serve stored image bytes |

The website sends the uploaded reference image and the user's coordinates to
this API only after the user allows location access. Grok classifies the photo's
background into one fixed tag group: park/skatepark/BeltLine/water,
campus/architecture/marble, historic/Sweet Auburn/landmark, or
garden/greenery/ticketed. Typesense searches nearby places using the matching
group's categories, query, and coordinates; the website displays up to three
results as map pins and recommendation cards. Coordinates are used for the
search and are not saved.

## Tests

```sh
npm test --workspace api
npm test --workspace typesense
npm run check --workspace typesense
```
