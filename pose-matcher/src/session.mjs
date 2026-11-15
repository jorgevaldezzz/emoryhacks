import { comparePoses } from './compare.mjs';

/**
 * Build an opt-in pose check flow. frameProvider returns an image data URL/base64;
 * onResult can forward the compact result to Chert's voice session. No camera is
 * sampled until check() is called, or startPeriodic() is explicitly enabled.
 */
export function createPoseMatcher({ extractPose, onResult = () => {}, intervalMs = 12_000, now = Date.now }) {
  if (typeof extractPose !== 'function') throw new TypeError('extractPose is required.');
  let reference = null;
  let busy = false;
  let timer = null;

  async function setReference(image) {
    const pose = await extractPose(image);
    if (!pose?.personVisible) throw new Error('No clear person pose found in the reference photo.');
    reference = pose;
    return { ok: true, status: 'reference_ready', message: 'Reference pose is ready.' };
  }

  async function check(image) {
    if (!reference) return { ok: false, status: 'reference_missing', feedback: 'Choose a reference photo before checking your pose.' };
    if (busy) return { ok: false, status: 'check_in_progress', feedback: 'I am checking the last photo. Please wait a moment.' };
    busy = true;
    try {
      const current = await extractPose(image);
      const result = {
        ...comparePoses(reference, current),
        landmarks: current?.landmarks ?? {},
        checkedAt: new Date(now()).toISOString(),
      };
      await onResult(result);
      return result;
    } finally { busy = false; }
  }

  function startPeriodic({ getImage, onError = () => {} }) {
    if (typeof getImage !== 'function') throw new TypeError('getImage is required.');
    stopPeriodic();
    timer = setInterval(async () => {
      try { const image = await getImage(); if (image) await check(image); }
      catch (error) { onError(error); }
    }, intervalMs);
    return stopPeriodic;
  }
  function stopPeriodic() { if (timer) clearInterval(timer); timer = null; }

  return { setReference, check, startPeriodic, stopPeriodic, get hasReference() { return reference !== null; } };
}
