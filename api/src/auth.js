import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import {
  findUserByEmail,
  findUserById,
  findUserByUsername,
  insertUser,
} from "./db.js";

const BCRYPT_ROUNDS = 12;

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET must be set to a string of at least 16 characters");
  }
  return secret;
}

/**
 * Hash a password with bcrypt (one-way). Passwords are never stored in plaintext.
 * @param {string} password
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * @param {string} password
 * @param {string} passwordHash
 */
export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

/**
 * @param {{ id: string, email: string }} user
 */
export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    jwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

/**
 * @param {string} token
 */
export function verifyToken(token) {
  return jwt.verify(token, jwtSecret());
}

/**
 * @param {{ email: string, password: string, name?: string, username?: string }} input
 */
export async function signup({ email, password, name, username }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    const err = new Error("A valid email is required");
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error("Password must be at least 6 characters");
    err.status = 400;
    throw err;
  }

  const displayName =
    String(username || name || "").trim().toLowerCase() || normalized.split("@")[0];
  if (displayName.length < 2) {
    const err = new Error("Username must be at least 2 characters");
    err.status = 400;
    throw err;
  }

  if (await findUserByEmail(normalized)) {
    const err = new Error("An account with that email already exists");
    err.status = 409;
    throw err;
  }
  if (await findUserByUsername(displayName)) {
    const err = new Error("That username is already taken");
    err.status = 409;
    throw err;
  }

  const passwordHash = await hashPassword(String(password));
  const user = {
    id: randomUUID(),
    email: normalized,
    name: displayName,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  try {
    await insertUser(user);
  } catch (err) {
    if (err && (err.code === 11000 || String(err.message || "").includes("duplicate"))) {
      const conflict = new Error("An account with that email or username already exists");
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
  return publicUser(user);
}

/**
 * @param {{ email: string, password: string }} input
 */
export async function login({ email, password }) {
  const normalized = String(email || "").trim().toLowerCase();
  const row = await findUserByEmail(normalized);
  if (!row) {
    const err = new Error("Invalid email or password");
    err.status = 401;
    throw err;
  }
  const ok = await verifyPassword(String(password || ""), row.password_hash);
  if (!ok) {
    const err = new Error("Invalid email or password");
    err.status = 401;
    throw err;
  }
  return publicUser(row);
}

/**
 * @param {string} userId
 */
export async function getPublicUser(userId) {
  const row = await findUserById(userId);
  return row ? publicUser(row) : null;
}

/**
 * @param {Record<string, unknown>} row
 */
export function publicUser(row) {
  const createdAt = row.createdAt || row.created_at;
  const username = row.username || row.name;
  return {
    id: row.id,
    email: row.email,
    name: username,
    username,
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };
}
