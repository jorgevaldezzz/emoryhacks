import { checkPoseVisibility } from './compare.mjs';

/** Build a reference-pose comparison flow with injected local inference and coaching. */
export function createPoseMatcher({ extractPose, comparePose, onResult = () => {}, intervalMs = 12_000, now = Date.now }) {
  if (typeof extractPose !== 'function') throw new TypeError('extractPose is required.');
  if (typeof comparePose !== 'function') throw new TypeError('comparePose is required.');
  let reference = null;
  /** @type {Promise<object> | null} */
  let inFlight = null;
  let timer = null;

  async function setReference(image) {
    const pose = await extractPose(image);
    const visibility = checkPoseVisibility(pose, pose);
    if (visibility.status === 'person_not_visible') throw new Error('MediaPipe could not detect a clear pose in the reference photo.');
    if (visibility.status === 'insufficient_visibility') {
      throw new Error('MediaPipe found a person but too few reference joints are visible. Choose a full-body pose photo.');
    }
    reference = pose;
    return { ok: true, status: 'reference_ready', message: 'Reference pose is ready.' };
  }

  async function check(image) {
    if (!reference) return { ok: false, status: 'reference_missing', feedback: 'Choose a reference photo before checking your pose.' };
    // Overlapping silent-look + guide_pose used to return check_in_progress →
    // the agent spoke nothing for the whole Grok wait. Share one in-flight
    // comparison so every waiter gets the real adjust/matched result.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const current = await extractPose(image);
      const visibility = checkPoseVisibility(reference, current);
      const comparison = visibility.status === 'pose_visible'
        ? await comparePose({ reference, current })
        : visibility;
      const result = {
        ...comparison,
        landmarks: current?.landmarks ?? {},
        checkedAt: new Date(now()).toISOString(),
      };
      await onResult(result);
      return result;
    })().finally(() => { inFlight = null; });
    return inFlight;
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
