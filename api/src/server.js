import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb, UPLOAD_DIR, databaseMode } from "./db.js";
import { errorHandler } from "./middleware.js";
import { openImageObject } from "./object-store.js";
import { galleryMaxItems } from "./storage.js";
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

export async function createApp() {
  await openDb();

  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: corsOrigins(),
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "imphotogenic-api",
      database: databaseMode(),
      storage: "local",
      galleryMaxItems: galleryMaxItems(),
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/gallery", galleryRoutes);

  app.get("/uploads/:filename", (req, res, next) => {
    try {
      const opened = openImageObject(req.params.filename);
      if (!opened) {
        return res.status(404).json({ error: "Not found" });
      }
      res.setHeader("Content-Type", opened.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      opened.stream.pipe(res);
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
  if (!process.env.MONGODB_URI?.trim()) {
    console.error("[api] Set MONGODB_URI to your MongoDB Atlas connection string.");
    process.exit(1);
  }

  const app = await createApp();
  const server = app.listen(PORT, () => {
    console.log(`[api] listening on http://0.0.0.0:${PORT}`);
    console.log(`[api] database=${databaseMode()} storage=local`);
    console.log(`[api] uploads → ${path.resolve(UPLOAD_DIR)}`);
  });

  function shutdown() {
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
