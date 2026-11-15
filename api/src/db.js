/**
 * Cloud MongoDB (mongoose) for user accounts + gallery metadata.
 *
 * Set MONGODB_URI (MongoDB Atlas or any MongoDB). Tests may pass a memory-server URI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { Image, User } from "./models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(ROOT, "uploads");

export function databaseMode() {
  return "mongodb";
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

  const dbName = process.env.MONGODB_DB?.trim() || undefined;
  await mongoose.connect(connectionString, dbName ? { dbName } : undefined);
}

export async function closeDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * @param {import('mongoose').Document | Record<string, unknown> | null | undefined} row
 */
function mapUser(row) {
  if (!row) return undefined;
  const doc = typeof row.toObject === "function" ? row.toObject() : row;
  return {
    id: String(doc._id),
    email: doc.email,
    name: doc.username || doc.name,
    username: doc.username || doc.name,
    password_hash: doc.passwordHash || doc.password_hash,
    created_at:
      doc.createdAt instanceof Date
        ? doc.createdAt.toISOString()
        : doc.createdAt || doc.created_at,
  };
}

/**
 * @param {import('mongoose').Document | Record<string, unknown> | null | undefined} row
 */
function mapGallery(row) {
  if (!row) return undefined;
  const doc = typeof row.toObject === "function" ? row.toObject() : row;
  return {
    id: String(doc._id),
    filename: doc.filename || null,
    url: doc.url || null,
    storageKey: doc.storageKey || null,
    pathname: doc.storageKey || null,
    originalName: doc.originalName ?? null,
    note: doc.note ?? null,
    source: doc.source || "upload",
    kind: doc.kind || "reference",
    chertCode: doc.chertCode || null,
    createdAt:
      doc.createdAt instanceof Date
        ? doc.createdAt.toISOString()
        : String(doc.createdAt || doc.created_at || ""),
  };
}

/**
 * @param {string} email
 */
export async function findUserByEmail(email) {
  const row = await User.findOne({ email: email.trim().toLowerCase() });
  return mapUser(row);
}

/**
 * @param {string} id
 */
export async function findUserById(id) {
  if (!mongoose.isValidObjectId(id)) return undefined;
  const row = await User.findById(id);
  return mapUser(row);
}

/**
 * @param {string} username
 */
export async function findUserByUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) return undefined;
  const row = await User.findOne({ username: normalized });
  return mapUser(row);
}

/**
 * @param {{ email: string, name: string, passwordHash: string }} user
 */
export async function insertUser(user) {
  const username = String(user.name || "").trim().toLowerCase();
  const created = await User.create({
    email: user.email.trim().toLowerCase(),
    username,
    name: username,
    passwordHash: user.passwordHash,
  });
  return mapUser(created);
}

/**
 * @param {string} userId
 */
export async function listGalleryForUser(userId) {
  if (!mongoose.isValidObjectId(userId)) return [];
  const rows = await Image.find({ userId }).sort({ createdAt: -1 });
  return rows.map(mapGallery);
}

/**
 * @param {string} userId
 */
export async function countGalleryForUser(userId) {
  if (!mongoose.isValidObjectId(userId)) return 0;
  return Image.countDocuments({ userId });
}

/**
 * @param {string} userId
 * @param {number} limit
 */
export async function listOldestGalleryForUser(userId, limit) {
  if (!mongoose.isValidObjectId(userId)) return [];
  const rows = await Image.find({ userId }).sort({ createdAt: 1 }).limit(limit);
  return rows.map(mapGallery);
}

/**
 * @param {{
 *   userId: string,
 *   filename?: string | null,
 *   url?: string | null,
 *   storageKey?: string | null,
 *   originalName?: string | null,
 *   note?: string | null,
 *   source: string,
 *   kind?: string,
 *   chertCode?: string | null,
 * }} item
 */
export async function insertGalleryItem(item) {
  const created = await Image.create({
    userId: item.userId,
    filename: item.filename ?? null,
    url: item.url ?? null,
    storageKey: item.storageKey ?? null,
    originalName: item.originalName ?? null,
    note: item.note ?? null,
    source: item.source,
    kind: item.kind || (item.source === "chert" ? "result" : "reference"),
    chertCode: item.chertCode ?? null,
  });
  return mapGallery(created);
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function findGalleryItemForUser(id, userId) {
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(userId)) {
    return undefined;
  }
  const row = await Image.findOne({ _id: id, userId });
  return mapGallery(row);
}

/**
 * Filtering on userId means someone else's id returns null, not their data.
 * @param {string} id
 * @param {string} userId
 */
export async function deleteGalleryItem(id, userId) {
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(userId)) {
    return null;
  }
  const row = await Image.findOneAndDelete({ _id: id, userId });
  return mapGallery(row) || null;
}

/**
 * @param {string} code
 */
export async function findGalleryByChertCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return undefined;
  const row = await Image.findOne({ chertCode: normalized });
  return mapGallery(row);
}
