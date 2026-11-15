import { Router } from "express";
import multer from "multer";
import { findUserByEmail, findUserById, listGalleryForUser } from "../db.js";
import { requireAuth, requireIngestSecret } from "../middleware.js";
import { removeGalleryImage, saveGalleryImage } from "../storage.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const router = Router();

/**
 * @param {import('express').Request} req
 * @param {{ id?: string, _id?: string, originalName?: string | null, note?: string | null, source: string, createdAt: string }} item
 */
function withUrl(req, item) {
  const base = `${req.protocol}://${req.get("host")}`;
  return {
    ...item,
    url: `${base}/uploads/${encodeURIComponent(item.id || item._id)}`,
  };
}

/**
 * @param {import('express').Request} req
 * @returns {{ buffer: Buffer, mime: string, originalName: string | null } | null}
 */
function readImagePayload(req) {
  if (req.file?.buffer) {
    return {
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      originalName: req.file.originalname || req.body?.name || null,
    };
  }
  if (req.body?.imageBase64) {
    const raw = String(req.body.imageBase64);
    const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(raw);
    if (dataUrl) {
      return {
        buffer: Buffer.from(dataUrl[2], "base64"),
        mime: dataUrl[1],
        originalName: req.body.name || null,
      };
    }
    return {
      buffer: Buffer.from(raw, "base64"),
      mime: req.body.mimeType || "image/png",
      originalName: req.body.name || null,
    };
  }
  return null;
}

router.get("/", requireAuth, async (req, res) => {
  const items = (await listGalleryForUser(req.user.id)).map((item) =>
    withUrl(req, { ...item, id: item._id })
  );
  const owner = await findUserById(req.user.id);
  res.json({
    items,
    storage: {
      usedBytes: owner?.galleryBytes || 0,
      quotaBytes: owner?.galleryQuotaBytes,
    },
  });
});

router.post("/", requireAuth, upload.single("image"), async (req, res, next) => {
  try {
    const payload = readImagePayload(req);
    if (!payload) {
      return res.status(400).json({ error: "Provide an image file or imageBase64" });
    }

    const item = await saveGalleryImage({
      userId: req.user.id,
      buffer: payload.buffer,
      mime: payload.mime,
      originalName: payload.originalName,
      note: req.body?.note || null,
      source: req.body?.source || "upload",
    });
    res.status(201).json({ item: withUrl(req, item) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const removed = await removeGalleryImage(req.params.id, req.user.id);
    if (!removed) {
      return res.status(404).json({ error: "Gallery item not found" });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Chert / pose-agent ingest: associate a snapped PNG with a user gallery.
 * Auth: X-Ingest-Secret matching GALLERY_INGEST_SECRET.
 * Identify the account with `email` (preferred) or `userId`.
 */
router.post("/chert", requireIngestSecret, upload.single("image"), async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const userId = String(req.body?.userId || "").trim();

    let user = null;
    if (email) {
      user = await findUserByEmail(email);
      if (!user) {
        return res.status(404).json({
          error:
            "No account for that email. Sign up on the website first, then set GALLERY_USER_EMAIL on the agent.",
        });
      }
    } else if (userId) {
      user = await findUserById(userId);
      if (!user) {
        return res.status(404).json({ error: "No account for that userId" });
      }
    } else {
      return res.status(400).json({ error: "Provide email or userId for the gallery owner" });
    }

    const payload = readImagePayload(req);
    if (!payload) {
      return res.status(400).json({ error: "Provide capture image bytes" });
    }

    const item = await saveGalleryImage({
      userId: user.id,
      buffer: payload.buffer,
      mime: payload.mime || "image/png",
      originalName: payload.originalName || "chert-capture.png",
      note: req.body?.note || "Captured by Chert pose agent",
      source: "chert",
    });
    res.status(201).json({ item: withUrl(req, item) });
  } catch (err) {
    next(err);
  }
});

export default router;
