import pg from "pg";

/** @type {pg.Pool | null} */
let pool = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'upload',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gallery_user_created
  ON gallery_items(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (lower(email));
`;

/**
 * @param {string} databaseUrl
 */
export async function openPostgres(databaseUrl) {
  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 5),
    ssl: process.env.PG_SSL === "0" ? false : undefined,
  });
  await pool.query(SCHEMA);
  return pool;
}

export async function closePostgres() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function requirePool() {
  if (!pool) throw new Error("Database has not been opened yet");
  return pool;
}

/**
 * @param {string} email
 */
export async function findUserByEmail(email) {
  const { rows } = await requirePool().query(
    "SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1",
    [email.trim()]
  );
  return rows[0] || undefined;
}

/**
 * @param {string} id
 */
export async function findUserById(id) {
  const { rows } = await requirePool().query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
  return rows[0] || undefined;
}

/**
 * @param {{ id: string, email: string, name: string, passwordHash: string, createdAt: string }} user
 */
export async function insertUser(user) {
  await requirePool().query(
    `INSERT INTO users (id, email, name, password_hash, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      user.id,
      user.email.trim().toLowerCase(),
      user.name,
      user.passwordHash,
      user.createdAt,
    ]
  );
}

/**
 * @param {string} userId
 */
export async function listGalleryForUser(userId) {
  const { rows } = await requirePool().query(
    `SELECT id, filename, original_name AS "originalName", note, source, created_at AS "createdAt"
     FROM gallery_items
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(normalizeGalleryRow);
}

/**
 * @param {string} userId
 */
export async function countGalleryForUser(userId) {
  const { rows } = await requirePool().query(
    "SELECT COUNT(*)::int AS count FROM gallery_items WHERE user_id = $1",
    [userId]
  );
  return Number(rows[0]?.count || 0);
}

/**
 * @param {string} userId
 * @param {number} limit
 */
export async function listOldestGalleryForUser(userId, limit) {
  const { rows } = await requirePool().query(
    `SELECT id, filename, original_name AS "originalName", note, source, created_at AS "createdAt"
     FROM gallery_items
     WHERE user_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [userId, limit]
  );
  return rows.map(normalizeGalleryRow);
}

/**
 * @param {{ id: string, userId: string, filename: string, originalName?: string | null, note?: string | null, source: string, createdAt: string }} item
 */
export async function insertGalleryItem(item) {
  await requirePool().query(
    `INSERT INTO gallery_items
       (id, user_id, filename, original_name, note, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      item.id,
      item.userId,
      item.filename,
      item.originalName ?? null,
      item.note ?? null,
      item.source,
      item.createdAt,
    ]
  );
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function findGalleryItemForUser(id, userId) {
  const { rows } = await requirePool().query(
    `SELECT id, filename, original_name AS "originalName", note, source, created_at AS "createdAt"
     FROM gallery_items
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [id, userId]
  );
  return rows[0] ? normalizeGalleryRow(rows[0]) : undefined;
}

/**
 * @param {string} id
 * @param {string} userId
 */
export async function deleteGalleryItem(id, userId) {
  const item = await findGalleryItemForUser(id, userId);
  if (!item) return null;
  await requirePool().query("DELETE FROM gallery_items WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
  return item;
}

/**
 * @param {Record<string, unknown>} row
 */
function normalizeGalleryRow(row) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.originalName ?? row.original_name ?? null,
    note: row.note ?? null,
    source: row.source,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.createdAt || row.created_at),
  };
}
