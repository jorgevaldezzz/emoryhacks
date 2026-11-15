# IMPhotogenic API

Separate backend for the Vercel website and the Chert pose agent.

- **Users** — email + **bcrypt-hashed** passwords (never stored in plaintext)
- **Sessions** — JWT bearer tokens
- **Gallery** — image files on disk + metadata in SQLite
- **Chert ingest** — pose snaps posted into a user’s gallery via a shared secret

## Run locally

```sh
cd api
cp .env.example .env
# edit JWT_SECRET, GALLERY_INGEST_SECRET, CORS_ORIGIN
npm install
npm start
```

Health check: `GET http://127.0.0.1:8787/health`

## Deploy on another server

This is meant to live **off Vercel** (Railway, Render, Fly.io, a VPS, etc.):

1. Set `JWT_SECRET`, `GALLERY_INGEST_SECRET`, and `CORS_ORIGIN` to your Vercel domain.
2. Mount persistent volumes for `DATA_DIR` / `UPLOAD_DIR` (or the defaults `./data` and `./uploads`).
3. Expose `PORT` (default `8787`).

Docker:

```sh
docker build -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e JWT_SECRET=... \
  -e GALLERY_INGEST_SECRET=... \
  -e CORS_ORIGIN=https://your-app.vercel.app \
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
| GET | `/uploads/:filename` | — | Serve stored image bytes |

## Tests

```sh
npm test
```
