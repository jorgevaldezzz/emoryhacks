/**
 * Cloud MongoDB for user accounts + gallery metadata.
 *
 * Users: username/email + bcrypt password_hash (never plaintext, never Typesense).
 * Gallery rows point at Vercel Blob URLs (see object-store.js).
 *
 * Set MONGODB_URI (MongoDB Atlas or any MongoDB). Tests may pass a memory-server URI.
 */

import { MongoClient } from "mongodb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(ROOT, "uploads");

/** @type {MongoClient | null} */
let client = null;
/** @type {import('mongodb').Db | null} */
let db = null;

export function databaseMode() {
  return "mongodb";
}

function requireDb() {
  if (!db) throw new Error("Database has not been opened yet");
  return db;
}

/**
 * @param {string} [uri]
 */
export async function openDb(uri = process.env.MONGODB_URI) {
  const connectionString = String(uri || "").trim();
  if (!connectionString) {
    throw new Error(
      "MONGODB_URI is required. Use a MongoDB Atlas connection string (or mongodb-memory-server in tests)."
    );
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  client = new MongoClient(connectionString);
  await client.connect();
  const dbName = process.env.MONGODB_DB?.trim() || undefined;
  db = client.db(dbName);

  await db.collection("users").createIndexes([
    { key: { email: 1 }, unique: true, name: "users_email_unique" },
    { key: { username: 1 }, unique: true, sparse: true, name: "users_username_unique" },
  ]);
  await db.collection("gallery_items").createIndexes([
    { key: { user_id: 1, created_at: -1 }, name: "gallery_user_created" },
  ]);
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

/**
 * @param {Record<string, unknown>} row
 */
function mapUser(row) {
  if (!row) return undefined;
  return {
    id: row._id,
    email: row.email,
    name: row.username || row.name,
    username: row.username || row.name,
    password_hash: row.password_hash,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * @param {Record<string, unknown>} row
 */
function mapGallery(row) {
  if (!row) return undefined;
  return {
    id: row._id,
    filename: row.filename,
    url: row.url || null,
    pathname: row.pathname || null,
    originalName: row.original_name ?? null,
    note: row.note ?? null,
    source: row.source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * @param {string} email
 */
export async function findUserByEmail(email) {
  const row = await requireDb()
    .collection("users")
    .findOne({ email: email.trim().toLowerCase() });
  return mapUser(row);
}

/**
 * @param {string} id
 */
export async function findUserById(id) {
  const row = await requireDb().collection("users").findOne({ _id: id });
  return mapUser(row);
}

/**
 * @param {string} username
 */
export async function findUserByUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) return undefined;
  const row = await requireDb().collection("users").findOne({
    username: normalized,
  });
  return mapUser(row);
}

/**
 * @param {{ id: string, email: string, name: string, passwordHash: string, createdAt: string }} user
 */
export async function insertUser(user) {
  const username = String(user.name || "").trim().toLowerCase();
  await requireDb().collection("users").insertOne({
    _id: user.id,
    email: user.email.trim().toLowerCase(),
    username,
    name: username,
    password_hash: user.passwordHash,
    created_at: new Date(user.createdAt),
  });
}

/**
 * @param {string} userId
 */
export async function listGalleryForUser(userId) {
  const rows = await requireDb()
    .collection("gallery_items")
    .find({ user_id: userId })
    .sort({ created_at: -1 })
    .toArray();
  return rows.map(mapGallery);
}

/**
 * @param {string} userId
 */
export async function countGalleryForUser(userId) {
  return requireDb().collection("gallery_items").countDocuments({ user_id: userId });
}

/**
 * @param {string} userId
 * @param {number} limit
 */
export async function listOldestGalleryForUser(userId, limit) {
  const rows = await requireDb()
    .collection("gallery_items")
    .find({ user_id: userId })
    .sort({ created_at: 1 })
    .limit(limit)
    .toArray();
  return rows.map(mapGallery);
}

/**
 * @param {{
 *   id: string,
 *   userId: string,
 *   filename: string,
 *   url?: string | null,
 *   pathname?: string | null,
 *   originalName?: string | null,
 *   note?: string | null,
 *   source: string,
 *   createdAt: string,
 * }} item
 */
export async function insertGalleryItem(item) {
  await requireDb().collection("gallery_items").insertOne({
    _id: item.id,
    user_id: item.userId,
    filename: item.filename,
    url: item.url ?? null,
    pathname: item.pathname ?? null,
    original_name: item.originalName ?? null,
    note: item.note ?? null,
    source: item.source,
    created_at: new Date(item.createdAt),
  });
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function findGalleryItemForUser(id, userId) {
  const row = await requireDb().collection("gallery_items").findOne({
    _id: id,
    user_id: userId,
  });
  return mapGallery(row);
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function deleteGalleryItem(id, userId) {
  const item = await findGalleryItemForUser(id, userId);
  if (!item) return null;
  await requireDb().collection("gallery_items").deleteOne({ _id: id, user_id: userId });
  return item;
}
