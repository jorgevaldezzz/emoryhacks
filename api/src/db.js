/**
 * Database facade.
 *
 * - Local / tests: SQLite (default) — set DATA_DIR / SQLITE_PATH as before.
 * - Cloud: Postgres — set DATABASE_URL (Neon, Supabase, Railway, RDS, …).
 *
 * Passwords are never stored here as plaintext; see auth.js (bcrypt).
 * Typesense is NOT used for accounts or gallery data.
 */

import * as sqlite from "./db-sqlite.js";
import * as postgres from "./db-postgres.js";

/** @type {'sqlite' | 'postgres' | null} */
let mode = null;

export const DATA_DIR = sqlite.DATA_DIR;
export const UPLOAD_DIR = sqlite.UPLOAD_DIR;

export function databaseMode() {
  return mode || (process.env.DATABASE_URL?.trim() ? "postgres" : "sqlite");
}

export async function openDb() {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    mode = "postgres";
    await postgres.openPostgres(url);
    // Still ensure a local uploads dir exists for non-S3 fallback.
    const fs = await import("node:fs");
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    return;
  }
  mode = "sqlite";
  sqlite.openSqlite();
}

export async function closeDb() {
  if (mode === "postgres") {
    await postgres.closePostgres();
  } else if (mode === "sqlite") {
    sqlite.closeSqlite();
  }
  mode = null;
}

function backend() {
  if (mode === "postgres") return postgres;
  if (mode === "sqlite") return sqlite;
  throw new Error("Database has not been opened yet");
}

/** @param {string} email */
export function findUserByEmail(email) {
  return backend().findUserByEmail(email);
}

/** @param {string} id */
export function findUserById(id) {
  return backend().findUserById(id);
}

/** @param {{ id: string, email: string, name: string, passwordHash: string, createdAt: string }} user */
export function insertUser(user) {
  return backend().insertUser(user);
}

/** @param {string} userId */
export function listGalleryForUser(userId) {
  return backend().listGalleryForUser(userId);
}

/** @param {string} userId */
export function countGalleryForUser(userId) {
  return backend().countGalleryForUser(userId);
}

/**
 * @param {string} userId
 * @param {number} limit
 */
export function listOldestGalleryForUser(userId, limit) {
  return backend().listOldestGalleryForUser(userId, limit);
}

/** @param {{ id: string, userId: string, filename: string, originalName?: string | null, note?: string | null, source: string, createdAt: string }} item */
export function insertGalleryItem(item) {
  return backend().insertGalleryItem(item);
}

/**
 * @param {string} id
 * @param {string} userId
 */
export function findGalleryItemForUser(id, userId) {
  return backend().findGalleryItemForUser(id, userId);
}

/**
 * @param {string} id
 * @param {string} userId
 */
export function deleteGalleryItem(id, userId) {
  return backend().deleteGalleryItem(id, userId);
}
