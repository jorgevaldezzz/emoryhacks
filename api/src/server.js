import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "./db.js";
import { errorHandler } from "./middleware.js";
import { getGalleryImage } from "./storage.js";
import authRoutes from "./routes/auth.js";
import galleryRoutes from "./routes/gallery.js";

const PORT = Number(process.env.PORT || 8787);

function corsOrigins() {
  const raw = process.env.CORS_ORIGIN || "*";
  if (raw.trim() === "*") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: corsOrigins(),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "12mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "imphotogenic-api" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/gallery", galleryRoutes);

  // Gallery image bytes are stored in MongoDB with their metadata.
  app.get("/uploads/:id", async (req, res, next) => {
    try {
      const item = await getGalleryImage(req.params.id);
      if (!item) {
        return res.status(404).json({ error: "Not found" });
      }
      const bytes = Buffer.isBuffer(item.image)
        ? item.image
        : Buffer.from(item.image.buffer).subarray(0, item.image.position);
      res.type(item.mimeType).set("Cache-Control", "private, max-age=3600").send(bytes);
    } catch (err) {
      next(err);
    }
  });

  app.use(errorHandler);
  return app;
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  const here = fileURLToPath(import.meta.url);
  return entry === here;
}

if (isMain()) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    console.error("[api] Set JWT_SECRET (min 16 characters) before starting.");
    process.exit(1);
  }

  openDb()
    .then(() => {
      const app = createApp();
      const server = app.listen(PORT, () => {
        console.log(`[api] listening on http://0.0.0.0:${PORT}`);
      });

      async function shutdown() {
        server.close(async () => {
          await closeDb();
          process.exit(0);
        });
      }

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[api] MongoDB connection failed:", err.message);
      process.exit(1);
    });
}
