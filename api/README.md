# IMPhotogenic API

Separate backend for the Vercel website and the Chert pose agent.

- **Users (MongoDB Atlas)** — username + email + **bcrypt-hashed** passwords
- **Sessions** — JWT bearer tokens
- **Gallery images (Vercel Blob)** — bytes in Blob; metadata + blob URL on the user document’s gallery collection
- **Cap** — `GALLERY_MAX_ITEMS` (default 25); oldest images are deleted when a user exceeds it
- **Chert ingest** — pose snaps posted into a user’s gallery via a shared secret

Typesense is **not** used for accounts or gallery data.

## Run locally

```sh
cd api
cp .env.example .env
# set MONGODB_URI (Atlas), JWT_SECRET, GALLERY_INGEST_SECRET, CORS_ORIGIN
# set BLOB_READ_WRITE_TOKEN for real Blob uploads (optional for local disk fallback)
npm install
npm start
```

Health check: `GET http://127.0.0.1:8787/health`  
Returns `{ database: "mongodb", storage: "vercel-blob"|"local", galleryMaxItems }`.

## Cloud setup

### 1. MongoDB Atlas

1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Create a database user + allow network access (or `0.0.0.0/0` for demos).
3. Copy the connection string into `MONGODB_URI`.
4. Optional: `MONGODB_DB=imphotogenic`.

Collections (created automatically):

| Collection | Fields |
|------------|--------|
| `users` | `_id`, `email`, `username`, `password_hash`, `created_at` |
| `gallery_items` | `_id`, `user_id`, `filename`, `url`, `pathname`, `original_name`, `note`, `source`, `created_at` |

### 2. Vercel Blob

1. In the Vercel project → Storage → create a **Blob** store.
2. Connect it and enable the **read-write token** env var.
3. Copy `BLOB_READ_WRITE_TOKEN` into the API host env (Railway/Render/Fly/Vercel).

Gallery uploads call `put('gallery/<uuid>.png', …)` and store the returned public `url` on the user’s `gallery_items` row.

## Deploy the API

```sh
JWT_SECRET=…
GALLERY_INGEST_SECRET=…
MONGODB_URI=mongodb+srv://…
MONGODB_DB=imphotogenic
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…
CORS_ORIGIN=https://your-app.vercel.app
GALLERY_MAX_ITEMS=25
```

Docker:

```sh
docker build -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e JWT_SECRET=... \
  -e GALLERY_INGEST_SECRET=... \
  -e MONGODB_URI=mongodb+srv://... \
  -e BLOB_READ_WRITE_TOKEN=... \
  -e CORS_ORIGIN=https://your-app.vercel.app \
  imphotogenic-api
```

## Wire the website

```js
localStorage.setItem("IMPHOTOGENIC_API_URL", "https://your-api-host.example.com");
```

## Wire the Chert agent

```sh
GALLERY_API_URL=https://your-api-host.example.com
GALLERY_INGEST_SECRET=same-as-api
GALLERY_USER_EMAIL=you@email.com
```

## API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/signup` | — | Create account (`email`, `password`, `username`) |
| POST | `/api/auth/login` | — | Log in → JWT |
| GET | `/api/auth/me` | Bearer | Current user |
| GET | `/api/gallery` | Bearer | List gallery (`items`, `count`, `maxItems`) |
| POST | `/api/gallery` | Bearer | Upload → Vercel Blob + Mongo row |
| DELETE | `/api/gallery/:id` | Bearer | Remove item (+ Blob object) |
| POST | `/api/gallery/chert` | `X-Ingest-Secret` | Agent snap → user gallery |
| GET | `/uploads/:filename` | — | Local-disk proxy only (no Blob token) |

## Tests

```sh
npm test
```

Uses `mongodb-memory-server` + local disk (no Atlas / Blob token required).
