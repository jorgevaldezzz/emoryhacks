import { getPublicUser, verifyToken } from "./auth.js";

/**
 * Attach req.user / req.userId from Bearer token or httpOnly cookie.
 * Identity comes from the token only — never from a client-supplied userId.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const cookieToken = req.cookies?.token;
  const token = match?.[1] || cookieToken;

  if (!token) {
    return res.status(401).json({ error: "not logged in" });
  }
  try {
    const payload = verifyToken(token);
    const userId = String(payload.sub);
    const user = await getPublicUser(userId);
    if (!user) {
      return res.status(401).json({ error: "User no longer exists" });
    }
    req.user = user;
    req.userId = user.id;
    return next();
  } catch {
    return res.status(401).json({ error: "not logged in" });
  }
}

/**
 * Shared-secret gate for the Chert agent ingest route.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireIngestSecret(req, res, next) {
  const expected = process.env.GALLERY_INGEST_SECRET;
  if (!expected || expected.length < 16) {
    return res.status(503).json({
      error: "Gallery ingest is not configured (set GALLERY_INGEST_SECRET)",
    });
  }
  const auth = req.headers.authorization || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = req.headers["x-ingest-secret"] || (bearer ? bearer[1] : null);
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Invalid ingest secret" });
  }
  return next();
}

/**
 * Express error handler.
 * @param {Error & { status?: number }} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
export function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error("[api]", err);
  }
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message || "Request failed",
  });
}
