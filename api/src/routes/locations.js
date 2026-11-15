import { Router } from "express";
import multer from "multer";
import { isValidLatLng } from "@emoryhacks/typesense/geo";
import { randomNearbySpots } from "@emoryhacks/typesense/match";
import { requireAuth } from "../middleware.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

async function recommendNearby({ lat, lng }) {
  return randomNearbySpots({ lat, lng, limit: 3 });
}

function imageUpload(req, res, next) {
  upload.single("image")(req, res, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Reference image is too large (max 8 MB)." });
    }
    return res.status(400).json({ error: "Could not read the uploaded reference image." });
  });
}

/**
 * Create the location router. The recommender is injectable so API tests can
 * verify auth, multipart parsing, and output handling without external calls.
 */
export function createLocationRouter({ recommend = recommendNearby } = {}) {
  const router = Router();

  router.post("/recommendations", requireAuth, imageUpload, async (req, res, next) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Attach a JPEG or PNG reference image as `image`." });
    }

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!isValidLatLng(lat, lng)) {
      return res.status(400).json({ error: "Provide valid latitude and longitude coordinates." });
    }

    try {
      const result = await recommend({ image: req.file.buffer, mimeType: req.file.mimetype, lat, lng });
      if (!result.ok) console.warn(`[locations] recommendations unavailable (${result.reason ?? "unknown"})`);

      // Do not send upstream errors or stack details back to the browser.
      const { detail: _detail, ...safeResult } = result;
      res.json(safeResult);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createLocationRouter();
