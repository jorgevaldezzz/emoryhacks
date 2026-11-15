// Persistent JSON-lines bridge to Google's local MediaPipe Pose Landmarker.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DEFAULT_PYTHON = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../pose-agent/mediapipe/.venv/bin/python');
const WORKER = new URL('../../pose-agent/mediapipe/pose_sidecar.py', import.meta.url);

export class MediaPipePoseWorker {
  constructor({ python = process.env.POSE_PYTHON || DEFAULT_PYTHON, spawnImpl = spawn } = {}) {
    this.child = spawnImpl(python, ['-u', fileURLToPath(WORKER)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(os.tmpdir(), 'chert-emory-matplotlib-cache'),
      },
    });
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.#onLine(line));
    this.child.stderr.on('data', chunk => process.stderr.write(`[mediapipe] ${chunk}`));
    this.child.once('error', error => this.#fail(error));
    this.child.once('exit', (code, signal) => this.#fail(new Error(`MediaPipe worker exited (${code ?? signal})`)));
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return this.#fail(new Error(`Invalid MediaPipe response: ${line.slice(0, 200)}`)); }
    if (message.ready !== undefined) {
      if (message.ready) this.resolveReady();
      else this.rejectReady(new Error(message.error || 'MediaPipe failed to initialize.'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.pose);
    else pending.reject(new Error(message.error || 'MediaPipe pose detection failed.'));
  }

  #fail(error) {
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async detect(image) {
    await this.ready;
    if (typeof image !== 'string' || !image) throw new TypeError('MediaPipe image must be a data URL or base64 string.');
    const encoded = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
    const id = randomUUID();
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ id, image: encoded })}\n`);
    return response;
  }

  async close() {
    this.child.stdin.end();
    this.lines.close();
  }
}
