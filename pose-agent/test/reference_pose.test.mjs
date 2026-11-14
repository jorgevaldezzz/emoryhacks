import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadReferenceImage, mimeForImagePath, resolveReferenceImagePath } from '../reference_pose.mjs';

describe('mimeForImagePath', () => {
  it('maps common extensions', () => {
    assert.equal(mimeForImagePath('/tmp/a.png'), 'image/png');
    assert.equal(mimeForImagePath('/tmp/a.webp'), 'image/webp');
    assert.equal(mimeForImagePath('/tmp/a.JPG'), 'image/jpeg');
  });
});

describe('resolveReferenceImagePath', () => {
  it('prefers an explicit env path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pose-ref-env-'));
    const file = path.join(dir, 'target.png');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const resolved = await resolveReferenceImagePath(file, path.join(dir, 'unused'));
      assert.equal(resolved, file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('picks the first image in reference-images when env is empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pose-ref-dir-'));
    await writeFile(path.join(dir, 'b-pose.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(path.join(dir, 'a-pose.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(dir, 'notes.txt'), 'ignore');
    try {
      const resolved = await resolveReferenceImagePath('', dir);
      assert.equal(resolved, path.join(dir, 'a-pose.png'));
      const loaded = await loadReferenceImage('', dir);
      assert.ok(loaded);
      assert.equal(loaded.mime, 'image/png');
      assert.match(loaded.dataUrl, /^data:image\/png;base64,/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing is configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pose-ref-empty-'));
    try {
      assert.equal(await resolveReferenceImagePath('', dir), null);
      assert.equal(await loadReferenceImage('', dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
