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

## Configure and run

```sh
cd api
cp .env.example .env
# Set MONGODB_URI, JWT_SECRET, GALLERY_INGEST_SECRET, and CORS_ORIGIN.
npm install
npm start
```

Use a MongoDB Atlas database user with only `readWrite` access to `imphotogenic`.
Set `MONGODB_URI` to its SRV connection string and keep the credentials in the
host's environment variables or an untracked `.env` file. Never commit secrets.
`MONGODB_DATABASE` defaults to `imphotogenic`; `GALLERY_QUOTA_BYTES` defaults to
`104857600` (100 MiB).

Health check: `GET http://127.0.0.1:8787/health`

## Deploy

This API can run on Railway, Render, Fly, a VPS, or another Node host. Configure
`MONGODB_URI`, `JWT_SECRET`, `GALLERY_INGEST_SECRET`, and `CORS_ORIGIN` in the
host's environment. No persistent local disk is needed for gallery images.

```sh
docker build -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e MONGODB_URI="$MONGODB_URI" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e GALLERY_INGEST_SECRET="$GALLERY_INGEST_SECRET" \
  -e CORS_ORIGIN=https://your-app.vercel.app \
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
