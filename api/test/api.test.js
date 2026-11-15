import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("imphotogenic api", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "imphoto-api-"));
  process.env.JWT_SECRET = "test-jwt-secret-32chars-minimum!!";
  process.env.GALLERY_INGEST_SECRET = "test-ingest-secret-32chars-min!!";
  process.env.DATA_DIR = dataDir;
  process.env.UPLOAD_DIR = path.join(dataDir, "uploads");
  process.env.SQLITE_PATH = path.join(dataDir, "test.sqlite");
  process.env.CORS_ORIGIN = "*";

  /** @type {import('express').Express} */
  let app;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;
  let recommendLocationsStub = async () => ({ ok: false, reason: "unavailable", spots: [] });

  before(async () => {
    const mod = await import("../src/server.js");
    app = mod.createApp({ recommendLocations: (...args) => recommendLocationsStub(...args) });
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const { closeDb } = await import("../src/db.js");
    closeDb();
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

  async function multipart(pathname, form, headers = {}) {
    const res = await fetch(`${base}${pathname}`, { method: "POST", body: form, headers });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  it("signs up and hashes the password (never returns the hash)", async () => {
    const { res, body } = await json("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        email: "jorge@example.com",
        password: "secret12",
        name: "Jorge",
      }),
    });
    assert.equal(res.status, 201);
    assert.ok(body.token);
    assert.equal(body.user.email, "jorge@example.com");
    assert.equal(body.user.name, "Jorge");
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);

    const DatabaseSync = require("node:sqlite").DatabaseSync;
    const db = new DatabaseSync(process.env.SQLITE_PATH);
    const row = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("jorge@example.com");
    db.close();
    assert.ok(row.password_hash.startsWith("$2"));
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

  it("stores a gallery upload for the authenticated user", async () => {
    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    const token = login.body.token;
    // 1x1 PNG
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
    assert.ok(listed.body.items.some((i) => i.source === "chert"));
  });

  it("requires authentication and valid coordinates for location recommendations", async () => {
    const unauthenticated = await multipart("/api/locations/recommendations", new FormData());
    assert.equal(unauthenticated.res.status, 401);

    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    const token = login.body.token;
    const invalid = new FormData();
    invalid.set("lat", "91");
    invalid.set("lng", "-84.3");
    invalid.set("image", new Blob([Buffer.from("png")], { type: "image/png" }), "reference.png");
    const invalidResponse = await multipart("/api/locations/recommendations", invalid, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(invalidResponse.res.status, 400);
    assert.match(invalidResponse.body.error, /valid latitude and longitude/);
  });

  it("passes the reference image and location to the recommender and returns safe results", async () => {
    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    const token = login.body.token;
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    let received;
    recommendLocationsStub = async (input) => {
      received = input;
      return {
        ok: true,
        reason: "found",
        reference_scene: "forest",
        reference_background: "trees and a grassy trail",
        spots: [{ name: "Atlanta park", category: "park" }],
        attribution: "© OpenStreetMap contributors",
      };
    };

    const form = new FormData();
    form.set("lat", "33.7490");
    form.set("lng", "-84.3880");
    form.set("image", new Blob([image], { type: "image/png" }), "reference.png");
    const response = await multipart("/api/locations/recommendations", form, {
      Authorization: `Bearer ${token}`,
    });

    assert.equal(response.res.status, 200);
    assert.equal(received.lat, 33.749);
    assert.equal(received.lng, -84.388);
    assert.ok(Buffer.isBuffer(received.image));
    assert.equal(received.mimeType, "image/png");
    assert.equal(response.body.reference_scene, "forest");
    assert.equal(response.body.spots[0].name, "Atlanta park");
    assert.equal(response.body.attribution, "© OpenStreetMap contributors");
  });

  it("does not expose recommendation provider details to the browser", async () => {
    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "jorge@example.com", password: "secret12" }),
    });
    recommendLocationsStub = async () => ({
      ok: false,
      reason: "unavailable",
      spots: [],
      message: "Try again later.",
      detail: "private upstream exception",
    });

    const form = new FormData();
    form.set("lat", "33.7490");
    form.set("lng", "-84.3880");
    form.set("image", new Blob([Buffer.from("png")], { type: "image/png" }), "reference.png");
    const response = await multipart("/api/locations/recommendations", form, {
      Authorization: `Bearer ${login.body.token}`,
    });
    assert.equal(response.res.status, 200);
    assert.equal(response.body.message, "Try again later.");
    assert.equal(response.body.detail, undefined);
  });
});
