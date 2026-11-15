# IMPhotogenic API

Separate backend for the Vercel website and the Chert pose agent.

- **Users (MongoDB Atlas)** — email + username + **bcrypt-hashed** passwords
- **Sessions** — JWT bearer tokens (+ httpOnly cookie)
- **Gallery** — image files on disk; metadata in MongoDB, always filtered by `req.userId`
- **Cap** — `GALLERY_MAX_ITEMS` (default 25); oldest images are deleted when a user exceeds it
- **Chert ingest** — pose snaps posted into a user’s gallery via a shared secret

## Run locally

```sh
cd api
cp .env.example .env
# set MONGODB_URI (Atlas), JWT_SECRET, GALLERY_INGEST_SECRET, CORS_ORIGIN
npm install
npm start
```

Health check: `GET http://127.0.0.1:8787/health`  
Returns `{ database: "mongodb", storage: "local", galleryMaxItems }`.

## Cloud setup

### MongoDB Atlas

1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Create a database user + allow network access for your API host.
3. Copy the connection string into `MONGODB_URI`.
4. Optional: `MONGODB_DB=imphotogenic`.

Collections (created automatically by mongoose):

| Collection | Fields |
|------------|--------|
| `users` | `email`, `passwordHash`, `name`, `username`, timestamps |
| `images` | `userId`, `url`, `storageKey`, `filename`, `kind`, `chertCode`, `source`, `note`, timestamps |

### Image files

Gallery bytes live under `UPLOAD_DIR` (default `./uploads`). Mount a persistent volume on Railway/Render/Fly so uploads survive restarts.

## Deploy the API

```sh
JWT_SECRET=…
GALLERY_INGEST_SECRET=…
MONGODB_URI=mongodb+srv://…
MONGODB_DB=imphotogenic
CORS_ORIGIN=https://your-app.vercel.app
GALLERY_MAX_ITEMS=25
UPLOAD_DIR=/uploads
```

Docker:

```sh
docker build -t imphotogenic-api .
docker run --rm -p 8787:8787 \
  -e JWT_SECRET=... \
  -e GALLERY_INGEST_SECRET=... \
  -e MONGODB_URI=mongodb+srv://... \
  -e CORS_ORIGIN=https://your-app.vercel.app \
  -v imphoto-uploads:/uploads \
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
| POST | `/api/auth/login` | — | Log in → JWT + cookie |
| POST | `/api/auth/logout` | — | Clear cookie |
| GET | `/api/auth/me` | Bearer / cookie | Current user |
| GET | `/api/gallery` | Bearer / cookie | List gallery (`items`, `count`, `maxItems`) |
| POST | `/api/gallery` | Bearer / cookie | Upload inspiration image |
| DELETE | `/api/gallery/:id` | Bearer / cookie | Remove item (scoped to your user) |
| POST | `/api/gallery/chert` | `X-Ingest-Secret` | Agent snap → user gallery |
| GET | `/uploads/:filename` | — | Serve stored image bytes |

## Tests

```sh
npm test
```

Uses `mongodb-memory-server` + local disk (no Atlas required).
