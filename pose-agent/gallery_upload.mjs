/**
 * Push a Chert snap into the IMPhotogenic gallery API (hosted separately).
 *
 * Env:
 *   GALLERY_API_URL          e.g. https://api.yourdomain.com
 *   GALLERY_INGEST_SECRET    shared with the API server
 *   GALLERY_USER_EMAIL       account that owns the gallery (must already exist)
 */

/**
 * @param {{
 *   bytes: Buffer,
 *   mimeType?: string,
 *   name?: string,
 *   note?: string,
 *   email?: string,
 *   apiUrl?: string,
 *   ingestSecret?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ ok: boolean, skipped?: boolean, item?: object, message: string }>}
 */
export async function uploadCaptureToGallery(options) {
  const apiUrl = (options.apiUrl ?? process.env.GALLERY_API_URL ?? "").replace(/\/$/, "");
  const ingestSecret = options.ingestSecret ?? process.env.GALLERY_INGEST_SECRET;
  const email = options.email ?? process.env.GALLERY_USER_EMAIL;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!apiUrl) {
    return { ok: false, skipped: true, message: "GALLERY_API_URL is not set; snap stays local only." };
  }
  if (!ingestSecret) {
    return { ok: false, skipped: true, message: "GALLERY_INGEST_SECRET is not set; snap stays local only." };
  }
  if (!email) {
    return { ok: false, skipped: true, message: "GALLERY_USER_EMAIL is not set; snap stays local only." };
  }
  if (!options.bytes?.length) {
    return { ok: false, message: "No image bytes to upload." };
  }

  const res = await fetchImpl(`${apiUrl}/api/gallery/chert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ingest-Secret": ingestSecret,
    },
    body: JSON.stringify({
      email,
      imageBase64: options.bytes.toString("base64"),
      mimeType: options.mimeType || "image/png",
      name: options.name || `chert-${Date.now()}.png`,
      note: options.note || "Chert upload",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body?.error === "string" ? body.error : res.statusText;
    return { ok: false, message: `Gallery upload failed (${res.status}): ${detail}` };
  }
  return { ok: true, item: body.item, message: "Capture added to gallery." };
}
