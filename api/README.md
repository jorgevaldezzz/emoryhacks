# IMPhotogenic API

Separate backend for the Vercel website and the Chert pose agent.

- **Users** — email + username + **bcrypt-hashed** passwords (never plaintext, never Typesense)
- **Sessions** — JWT bearer tokens
- **Gallery** — image files in **cloud object storage** (or local disk) + metadata in **Postgres** (or SQLite)
- **Cap** — `GALLERY_MAX_ITEMS` (default 25); oldest images are deleted when a user exceeds it
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
Returns `{ database: "sqlite"|"postgres", storage: "local"|"s3", galleryMaxItems }`.

Local default: **SQLite + disk** under `./data` and `./uploads`.

## Cloud production (recommended)

Host the API on Railway / Render / Fly / a VPS, and point it at managed cloud services:

| Concern | Env | Example providers |
|---------|-----|-------------------|
| Users + gallery metadata | `DATABASE_URL` | Neon, Supabase Postgres, Railway Postgres |
| Image bytes | `S3_BUCKET` + keys | Cloudflare R2, AWS S3, Supabase Storage (S3 API) |
| Secrets | `JWT_SECRET`, `GALLERY_INGEST_SECRET` | platform secret store |

Example (Neon + Cloudflare R2):

```sh
DATABASE_URL=postgresql://…@….neon.tech/imphotogenic?sslmode=require
S3_BUCKET=imphotogenic-gallery
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=1
# optional public CDN:
# S3_PUBLIC_URL=https://gallery.yourdomain.com
GALLERY_MAX_ITEMS=25
CORS_ORIGIN=https://your-app.vercel.app
```

Docker still works; with cloud DB + S3 you no longer need persistent volumes for data/uploads:

```sh
docker build -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e JWT_SECRET=... \
  -e GALLERY_INGEST_SECRET=... \
  -e CORS_ORIGIN=https://your-app.vercel.app \
  -e DATABASE_URL=postgresql://... \
  -e S3_BUCKET=... \
  -e S3_ENDPOINT=... \
  -e S3_ACCESS_KEY_ID=... \
  -e S3_SECRET_ACCESS_KEY=... \
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
| POST | `/api/auth/signup` | — | Create account (`email`, `password`, optional `username`/`name`) |
| POST | `/api/auth/login` | — | Log in → JWT |
| GET | `/api/auth/me` | Bearer | Current user |
| GET | `/api/gallery` | Bearer | List gallery (`items`, `count`, `maxItems`) |
| POST | `/api/gallery` | Bearer | Upload inspiration (`image` file or `imageBase64`); may prune oldest |
| DELETE | `/api/gallery/:id` | Bearer | Remove an item |
| POST | `/api/gallery/chert` | `X-Ingest-Secret` | Agent snap → user gallery |
| GET | `/uploads/:filename` | — | Serve / proxy stored image bytes |

## Tests

```sh
npm test
```

Tests always use temporary SQLite + local disk (no cloud credentials required).
