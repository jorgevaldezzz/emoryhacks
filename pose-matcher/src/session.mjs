import { comparePoses } from './compare.mjs';

/**
 * Build a reference-pose check flow.
 * `extractPose` turns an image data URL/base64 into landmarks.
 * `onResult` can forward compact results to a voice session.
 */
export function createPoseMatcher({ extractPose, onResult = () => {}, intervalMs = 12_000, now = Date.now }) {
  if (typeof extractPose !== 'function') throw new TypeError('extractPose is required.');
  let reference = null;
  let busy = false;
  let timer = null;

  function setReferencePose(pose) {
    if (!pose?.personVisible || !pose?.landmarks || Object.keys(pose.landmarks).length < 3) {
      throw new Error('No clear person pose found in the reference.');
    }
    reference = pose;
    return { ok: true, status: 'reference_ready', message: 'Reference pose is ready.' };
  }

  async function setReference(image) {
    const pose = await extractPose(image);
    return setReferencePose(pose);
  }

  async function check(image) {
    if (!reference) {
      return {
        ok: false,
        status: 'reference_missing',
        ready: false,
        feedback: 'Choose a reference photo before checking your pose.',
      };
    }
    if (busy) {
      return {
        ok: false,
        status: 'check_in_progress',
        ready: false,
        feedback: 'Wait a moment.',
      };
    }
    busy = true;
    try {
      const current = await extractPose(image);
      const result = { ...comparePoses(reference, current), checkedAt: new Date(now()).toISOString() };
      await onResult(result);
      return result;
    } finally {
      busy = false;
    }
  }

  function startPeriodic({ getImage, onError = () => {} }) {
    if (typeof getImage !== 'function') throw new TypeError('getImage is required.');
    stopPeriodic();
    timer = setInterval(async () => {
      try {
        const image = await getImage();
        if (image) await check(image);
      } catch (error) {
        onError(error);
      }
    }, intervalMs);
    return stopPeriodic;
  }

  function stopPeriodic() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    setReference,
    setReferencePose,
    check,
    startPeriodic,
    stopPeriodic,
    get hasReference() {
      return reference !== null;
    },
    get referencePose() {
      return reference;
    },
  };
}
