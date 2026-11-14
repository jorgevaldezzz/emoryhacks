// Send the captured pose photo back over iMessage (Chert text).
import { randomUUID } from 'node:crypto';

const MESSAGING_BASE = process.env.CHERT_MESSAGING_BASE_URL || 'https://console.trychert.com';
const APP_BASE = process.env.CHERT_APP_BASE_URL || 'https://app.trychert.com';

/**
 * @typedef {{ ok: boolean, channel: 'imessage-media' | 'shared-text' | 'none', message: string, messageId?: string }} SendResult
 */

/**
 * @returns {string | undefined}
 */
export function photoRecipient() {
  const value = process.env.PHOTO_RECIPIENT?.trim();
  return value || undefined;
}

/**
 * Upload a PNG and send it as an iMessage attachment via POST /api/v1/send.
 * @param {{ bytes: Buffer, caption?: string, phone?: string, apiKey?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<SendResult>}
 */
export async function sendPhotoMedia(options) {
  const apiKey = options.apiKey ?? process.env.CHERT_SIGNING_SECRET ?? process.env.CHERT_MESSAGING_API_KEY;
  const phone = options.phone ?? photoRecipient();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!apiKey) {
    return { ok: false, channel: 'none', message: 'CHERT_SIGNING_SECRET is not set; cannot send the photo over iMessage.' };
  }
  if (!phone) {
    return { ok: false, channel: 'none', message: 'PHOTO_RECIPIENT is not set; cannot send the photo over iMessage.' };
  }

  const filename = `pose-${Date.now()}.png`;
  const created = await fetchImpl(`${MESSAGING_BASE}/api/v1/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename,
      content_type: 'image/png',
      size_bytes: options.bytes.length,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const createdBody = await created.json().catch(() => ({}));
  if (!created.ok) {
    const detail = typeof createdBody?.error?.message === 'string' ? createdBody.error.message : created.statusText;
    throw new Error(`attachment create failed (${created.status}): ${detail}`);
  }
  const attachmentId = createdBody.attachment_id;
  const uploadUrl = createdBody.upload_url;
  if (typeof attachmentId !== 'string' || typeof uploadUrl !== 'string') {
    throw new Error('attachment create returned an incomplete upload slot');
  }

  const uploaded = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'image/png',
      'Content-Length': String(options.bytes.length),
    },
    body: options.bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!uploaded.ok) {
    throw new Error(`attachment upload failed (${uploaded.status}): ${uploaded.statusText}`);
  }

  const caption = (options.caption ?? 'Here is the pose photo I just took.').slice(0, 4000);
  const sent = await fetchImpl(`${MESSAGING_BASE}/api/v1/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone,
      body: caption,
      attachments: [attachmentId],
      idempotency_key: `pose-photo-${randomUUID()}`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const sentBody = await sent.json().catch(() => ({}));
  if (!sent.ok || sentBody?.status === 'failed') {
    const detail = typeof sentBody?.reason === 'string'
      ? sentBody.reason
      : (typeof sentBody?.error?.message === 'string' ? sentBody.error.message : sent.statusText);
    throw new Error(`imessage send failed (${sent.status}): ${detail}`);
  }
  return {
    ok: true,
    channel: 'imessage-media',
    message: 'Photo sent over iMessage.',
    messageId: typeof sentBody.message_id === 'string' ? sentBody.message_id : undefined,
  };
}

/**
 * Shared-line text fallback when media credentials are unavailable.
 * @param {{ text: string, recipient?: string, lineId?: string, apiKey?: string, projectId?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<SendResult>}
 */
export async function sendSharedText(options) {
  const apiKey = options.apiKey ?? process.env.CHERT_API_KEY;
  const projectId = options.projectId ?? process.env.CHERT_PROJECT_ID;
  const lineId = options.lineId ?? process.env.CHERT_LINE_ID;
  const recipient = options.recipient ?? photoRecipient();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!apiKey || !projectId || !lineId) {
    return {
      ok: false,
      channel: 'none',
      message: 'Shared-text send needs CHERT_API_KEY, CHERT_PROJECT_ID, and CHERT_LINE_ID.',
    };
  }
  if (!recipient) {
    return { ok: false, channel: 'none', message: 'PHOTO_RECIPIENT is not set; cannot send a text.' };
  }

  const sent = await fetchImpl(`${APP_BASE}/api/v1/shared-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Chert-Project-Id': projectId,
      'Idempotency-Key': `pose-text-${randomUUID()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      line_id: lineId,
      recipient,
      text: options.text.slice(0, 4000),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const sentBody = await sent.json().catch(() => ({}));
  if (!sent.ok) {
    const detail = typeof sentBody?.error?.message === 'string' ? sentBody.error.message : sent.statusText;
    throw new Error(`shared-message send failed (${sent.status}): ${detail}`);
  }
  return {
    ok: true,
    channel: 'shared-text',
    message: 'Text sent over iMessage.',
    messageId: typeof sentBody?.id === 'string' ? sentBody.id : undefined,
  };
}

/**
 * Prefer sending the PNG as an iMessage attachment; fall back to Shared text.
 * @param {{ bytes: Buffer, caption?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<SendResult>}
 */
export async function sendPhotoOverText(options) {
  const media = await sendPhotoMedia(options);
  if (media.ok) return media;

  const caption = options.caption ?? 'I took your pose photo on the FaceTime call.';
  const text = await sendSharedText({
    text: `${caption} (image attach needs CHERT_SIGNING_SECRET; photo is saved on the agent as captures/last.png)`,
    fetchImpl: options.fetchImpl,
  });
  if (text.ok) return text;

  return {
    ok: false,
    channel: 'none',
    message: `${media.message} ${text.message}`.trim(),
  };
}
