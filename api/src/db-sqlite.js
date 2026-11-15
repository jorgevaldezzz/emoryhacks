import { DatabaseSync } from "node:sqlite";
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

const DB_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(DATA_DIR, "imphotogenic.sqlite");

/** @type {DatabaseSync | null} */
let db = null;

export function openSqlite() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gallery_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'upload',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gallery_user_created
      ON gallery_items(user_id, created_at DESC);
  `);

  return db;
}

export function closeSqlite() {
  if (db) {
    db.close();
    db = null;
  }
}

function requireDb() {
  if (!db) throw new Error("Database has not been opened yet");
  return db;
}

/**
 * @param {string} email
 */
export async function findUserByEmail(email) {
  return requireDb()
    .prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
    .get(email.trim().toLowerCase());
}

/**
 * @param {string} id
 */
export async function findUserById(id) {
  return requireDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
}

/**
 * @param {{ id: string, email: string, name: string, passwordHash: string, createdAt: string }} user
 */
export async function insertUser(user) {
  requireDb()
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      user.email.trim().toLowerCase(),
      user.name,
      user.passwordHash,
      user.createdAt
    );
}

/**
 * @param {string} userId
 */
export async function listGalleryForUser(userId) {
  return requireDb()
    .prepare(
      `SELECT id, filename, original_name AS originalName, note, source, created_at AS createdAt
       FROM gallery_items
       WHERE user_id = ?
       ORDER BY created_at DESC`
    )
    .all(userId);
}

/**
 * @param {string} userId
 */
export async function countGalleryForUser(userId) {
  const row = requireDb()
    .prepare("SELECT COUNT(*) AS count FROM gallery_items WHERE user_id = ?")
    .get(userId);
  return Number(row?.count || 0);
}

/**
 * Oldest items first — used when pruning over the per-user gallery cap.
 * @param {string} userId
 * @param {number} limit
 */
export async function listOldestGalleryForUser(userId, limit) {
  return requireDb()
    .prepare(
      `SELECT id, filename, original_name AS originalName, note, source, created_at AS createdAt
       FROM gallery_items
       WHERE user_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(userId, limit);
}

/**
 * @param {{ id: string, userId: string, filename: string, originalName?: string | null, note?: string | null, source: string, createdAt: string }} item
 */
export async function insertGalleryItem(item) {
  requireDb()
    .prepare(
      `INSERT INTO gallery_items
         (id, user_id, filename, original_name, note, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.userId,
      item.filename,
      item.originalName ?? null,
      item.note ?? null,
      item.source,
      item.createdAt
    );
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function findGalleryItemForUser(id, userId) {
  return requireDb()
    .prepare(
      `SELECT id, filename, original_name AS originalName, note, source, created_at AS createdAt
       FROM gallery_items
       WHERE id = ? AND user_id = ?`
    )
    .get(id, userId);
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function deleteGalleryItem(id, userId) {
  const item = await findGalleryItemForUser(id, userId);
  if (!item) return null;
  requireDb()
    .prepare("DELETE FROM gallery_items WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return item;
}
