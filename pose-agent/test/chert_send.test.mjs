import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sendPhotoMedia, sendPhotoOverText, sendSharedText } from '../chert_send.mjs';

describe('sendPhotoMedia', () => {
  it('uploads a PNG and sends it over /send', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls = [];
    const result = await sendPhotoMedia({
      bytes,
      phone: '+15551234567',
      apiKey: 'secret',
      caption: 'Pose photo',
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method, body: init.body });
        if (String(url).endsWith('/attachments')) {
          return {
            ok: true,
            json: async () => ({
              attachment_id: 'att_test',
              upload_url: 'https://console.trychert.com/api/v1/attachments/att_test/upload',
            }),
          };
        }
        if (String(url).includes('/upload')) {
          return { ok: true, statusText: 'OK' };
        }
        return {
          ok: true,
          json: async () => ({ status: 'sent', message_id: 'msg_1' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'imessage-media');
    assert.equal(result.messageId, 'msg_1');
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /\/attachments$/);
    assert.equal(calls[1].method, 'PUT');
    assert.match(calls[2].url, /\/send$/);
    assert.match(String(calls[2].body), /Pose photo/);
    assert.match(String(calls[2].body), /att_test/);
  });

  it('explains missing credentials without throwing', async () => {
    const result = await sendPhotoMedia({
      bytes: Buffer.from('x'),
      phone: undefined,
      apiKey: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.channel, 'none');
  });
});

describe('sendSharedText', () => {
  it('posts to shared-messages', async () => {
    const result = await sendSharedText({
      text: 'Photo taken',
      recipient: '+15551234567',
      lineId: 'line-1',
      apiKey: 'ftk_test',
      projectId: 'proj-1',
      fetchImpl: async (url, init = {}) => {
        assert.match(String(url), /shared-messages/);
        assert.equal(init.headers['X-Chert-Project-Id'], 'proj-1');
        return { ok: true, json: async () => ({ id: 'sm_1' }) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'shared-text');
  });
});

describe('sendPhotoOverText', () => {
  it('uses media when the messaging secret is available', async () => {
    const previous = {
      secret: process.env.CHERT_SIGNING_SECRET,
      recipient: process.env.PHOTO_RECIPIENT,
    };
    process.env.CHERT_SIGNING_SECRET = 'secret';
    process.env.PHOTO_RECIPIENT = '+15551234567';
    try {
      const result = await sendPhotoOverText({
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        caption: 'Here is the photo',
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/attachments')) {
            return {
              ok: true,
              json: async () => ({
                attachment_id: 'att_ok',
                upload_url: 'https://console.trychert.com/api/v1/attachments/att_ok/upload',
              }),
            };
          }
          if (String(url).includes('/upload')) return { ok: true, statusText: 'OK' };
          return { ok: true, json: async () => ({ status: 'sent', message_id: 'msg_ok' }) };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.channel, 'imessage-media');
    } finally {
      if (previous.secret === undefined) delete process.env.CHERT_SIGNING_SECRET;
      else process.env.CHERT_SIGNING_SECRET = previous.secret;
      if (previous.recipient === undefined) delete process.env.PHOTO_RECIPIENT;
      else process.env.PHOTO_RECIPIENT = previous.recipient;
    }
  });
});
