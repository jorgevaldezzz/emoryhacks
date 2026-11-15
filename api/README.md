# IMPhotogenic API

Backend for the Vercel website and Chert pose agent. It provides account
signup, login, session validation, and per-user gallery storage backed by
MongoDB Atlas. Passwords are bcrypt-hashed; the API never stores plaintext
passwords. Gallery images are limited to 8 MiB each and 100 MiB per account by
default.

## Configure and run

```sh
cp api/.env.example api/.env
# Fill in MongoDB, JWT, gallery ingest, and CORS values in api/.env.
npm install
npm start --workspace api
```

Use a MongoDB Atlas database user with only `readWrite` access to the
`imphotogenic` database. Keep connection credentials and secrets in environment
variables or an untracked `.env` file; never commit them. `MONGODB_DATABASE`
defaults to `imphotogenic`, and `GALLERY_QUOTA_BYTES` defaults to 104857600
(100 MiB).

Health check: `GET http://127.0.0.1:8787/health`.

## Deploy on Render

Configure the Render web service connected to this repository:

1. Set branch to `main` and leave **Root Directory** empty.
2. Set **Runtime** to **Docker**, **Dockerfile Path** to `api/Dockerfile`, and
   **Docker Context Directory** to `.`.
3. Set `MONGODB_URI`, `MONGODB_DATABASE`, `JWT_SECRET`,
   `GALLERY_INGEST_SECRET`, `GALLERY_QUOTA_BYTES`, and `CORS_ORIGIN` in the
   service environment. Set `CORS_ORIGIN` to the website's allowed origins,
   comma-separated, for example:
   `https://www.myboyfriendtakeshorriblephotos.club,https://myboyfriendtakeshorriblephotos.club`.
   Vercel deployment URLs for this project are also allowed so preview links can
   reach the API during review.
4. Save and deploy the latest commit from `main`.

No persistent local disk is needed. Account and gallery data live in MongoDB.

## Connect the website

Set `IMPHOTOGENIC_API_URL` in `website/config.js` to the public API origin. The
website uses a local API URL only when opened on `localhost` or `127.0.0.1`.

## Connect the Chert agent

Set the API origin and ingest secret in `pose-agent/.env.local`:

```sh
GALLERY_API_URL=https://your-api-host.example.com
GALLERY_INGEST_SECRET=same-as-api
GALLERY_USER_EMAIL=you@email.com
```

The email must belong to an existing account. Chert captures are stored in that
user's gallery.

## API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/signup` | None | Create account and return a JWT |
| POST | `/api/auth/login` | None | Verify password and return a JWT |
| GET | `/api/auth/me` | Bearer | Return the current user |
| GET | `/api/gallery` | Bearer | List gallery items and storage usage |
| POST | `/api/gallery` | Bearer | Save an upload to the current user's gallery |
| DELETE | `/api/gallery/:id` | Bearer | Remove an item and reclaim quota |
| POST | `/api/gallery/chert` | `X-Ingest-Secret` | Save a Chert capture to a user's gallery |
| GET | `/uploads/:id` | None | Serve stored image bytes |
