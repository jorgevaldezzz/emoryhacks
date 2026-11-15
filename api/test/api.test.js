import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";

describe("imphotogenic api", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "imphoto-api-"));
  /** @type {MongoMemoryServer} */
  const mongod = await MongoMemoryServer.create();

  process.env.JWT_SECRET = "test-jwt-secret-32chars-minimum!!";
  process.env.GALLERY_INGEST_SECRET = "test-ingest-secret-32chars-min!!";
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "imphotogenic_test";
  process.env.UPLOAD_DIR = path.join(dataDir, "uploads");
  process.env.DATA_DIR = dataDir;
  process.env.CORS_ORIGIN = "*";
  process.env.GALLERY_MAX_ITEMS = "3";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.S3_BUCKET;

  /** @type {import('express').Express} */
  let app;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  before(async () => {
    const mod = await import("../src/server.js");
    app = await mod.createApp();
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const { closeDb } = await import("../src/db.js");
    await closeDb();
    await mongod.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function json(pathname, options = {}) {
    const res = await fetch(`${base}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  it("signs up into MongoDB and hashes the password (never returns the hash)", async () => {
    const { res, body } = await json("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        email: "jorge@example.com",
        password: "secret12",
        username: "jorge",
      }),
    });
    assert.equal(res.status, 201);
    assert.ok(body.token);
    assert.equal(body.user.email, "jorge@example.com");
    assert.equal(body.user.username, "jorge");
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const row = await client
      .db(process.env.MONGODB_DB)
      .collection("users")
      .findOne({ email: "jorge@example.com" });
    await client.close();
    assert.ok(row);
    assert.equal(row.username, "jorge");
    assert.ok(String(row.password_hash).startsWith("$2"));
    assert.notEqual(row.password_hash, "secret12");
  });

  it("logs in with the correct password and rejects a wrong one", async () => {
    const bad = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "wrong" }),
    });
    assert.equal(bad.res.status, 401);

    const good = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    assert.equal(good.res.status, 200);
    assert.ok(good.body.token);
  });

  it("stores a gallery upload attached to the authenticated user", async () => {
    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    const token = login.body.token;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    const { res, body } = await json("/api/gallery", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        imageBase64: png.toString("base64"),
        mimeType: "image/png",
        name: "inspiration.png",
        note: "Uploaded inspiration",
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(body.item.source, "upload");
    assert.ok(body.item.url.includes("/uploads/"));

    const listed = await json("/api/gallery", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.res.status, 200);
    assert.equal(listed.body.items.length, 1);

    const img = await fetch(body.item.url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type")?.includes("image"), true);
  });

  it("lets the Chert agent ingest a snap into the user gallery", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const { res, body } = await json("/api/gallery/chert", {
      method: "POST",
      headers: { "X-Ingest-Secret": process.env.GALLERY_INGEST_SECRET },
      body: JSON.stringify({
        email: "jorge@example.com",
        imageBase64: png.toString("base64"),
        mimeType: "image/png",
        name: "pose-snap.png",
        note: "Chert snap",
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(body.item.source, "chert");

    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    const listed = await json("/api/gallery", {
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(listed.body.items.length, 2);
    assert.equal(listed.body.maxItems, 3);
    assert.ok(listed.body.items.some((i) => i.source === "chert"));
  });

  it("prunes the oldest gallery items when the per-user cap is exceeded", async () => {
    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    const token = login.body.token;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    for (let i = 0; i < 3; i += 1) {
      const { res } = await json("/api/gallery", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          imageBase64: png.toString("base64"),
          mimeType: "image/png",
          name: `extra-${i}.png`,
          note: `cap-${i}`,
        }),
      });
      assert.equal(res.status, 201);
    }

    const listed = await json("/api/gallery", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.res.status, 200);
    assert.equal(listed.body.items.length, 3);
    assert.equal(listed.body.count, 3);
    assert.equal(listed.body.maxItems, 3);

    const health = await json("/health");
    assert.equal(health.body.database, "mongodb");
    assert.equal(health.body.storage, "local");
    assert.equal(health.body.galleryMaxItems, 3);

    const victim = listed.body.items[listed.body.items.length - 1];
    const del = await json(`/api/gallery/${victim.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(del.res.status, 200);

    const after = await json("/api/gallery", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(after.body.items.length, 2);
    assert.equal(
      after.body.items.some((i) => i.id === victim.id),
      false
    );
  });
});
