// "Make my background look like this photo."
//
// The website takes a reference photo from the caller; the agent can grab a
// frame of what is behind them right now. This module puts the two together:
//
//   reference + current frame -> one vision call -> two scene profiles
//     backgrounds already alike?  -> say so, search nothing
//     backgrounds differ?         -> search photo_spots for the reference scene
//
// Same contract as findNearbySpots: matchReferencePhoto never throws and never
// rejects. This is an optional branch of the product, and a live FaceTime call
// should not end because a photo could not be read.
import { ConfigError } from './client.mjs';
import { searchOptionsFor, sceneLabel } from './scene.mjs';
import { searchNearby, SpotSearchError, summarizeForVoice } from './search.mjs';
import { compareBackgrounds, VisionError } from './vision.mjs';

/**
 * Above this, the caller is already somewhere that looks like the reference.
 * Deliberately generous: sending someone across town to a near-identical
 * background is worse advice than telling them to stay put.
 */
export const DEFAULT_THRESHOLD = 0.65;

/**
 * Spots whose background photographs like a given scene. Throws, like
 * searchNearby. `relax` drops the category filter and keeps the words, which is
 * what we fall back to when the categories found nothing.
 */
export async function spotsLikeScene(profile, lat, lng, { relax = false, ...opts } = {}) {
  const { categories, query } = searchOptionsFor(profile, { relax });
  return searchNearby(lat, lng, {
    ...opts,
    query: query || undefined,
    categories: categories.length ? categories : undefined,
  });
}

function reasonFor(error) {
  if (error instanceof SpotSearchError || error instanceof VisionError) return error.code;
  if (error instanceof ConfigError) return 'not_configured';
  return 'unavailable';
}

/**
 * Compare the caller's background to a reference photo, and find somewhere
 * nearby that matches when it does not.
 *
 * @param {object} args
 * @param {*} args.reference      The photo sent from the website. data: URL, https: URL or bytes.
 * @param {*} [args.current]      A frame of the caller now. Omit to skip the comparison and
 *                                just find spots that look like the reference.
 * @param {number} [args.lat]     Omit and you still get the comparison, without spots.
 * @param {number} [args.lng]
 * @param {number} [args.threshold=0.65]
 * @param {boolean} [args.relax=true]   Retry without the category filter when nothing is found.
 * @param {Function} [args.compare]     Injected in tests; defaults to compareBackgrounds.
 * @param {...*} [args.opts]      Anything searchNearby takes: radiusKm, limit, curatedOnly, signal…
 * @returns {Promise<object>} Never rejects. `ok: false` carries a `reason` and a sayable `message`.
 */
export async function matchReferencePhoto({
  reference,
  current,
  lat,
  lng,
  threshold = DEFAULT_THRESHOLD,
  relax = true,
  compare = compareBackgrounds,
  env,
  fetchImpl,
  ...opts
} = {}) {
  if (!reference) {
    return {
      ok: false,
      reason: 'no_reference',
      matches: false,
      spots: [],
      message: 'No reference photo yet. Ask the caller to send the look they are going for.',
    };
  }

  let seen;
  try {
    seen = await compare({ reference, current, env, fetchImpl, signal: opts.signal });
  } catch (error) {
    return {
      ok: false,
      reason: reasonFor(error),
      matches: false,
      spots: [],
      // The agent says the message; the cause is for our logs, not the caller.
      message: 'I could not read that photo. Describe the background you want instead.',
      detail: error.message,
    };
  }

  const base = {
    ok: true,
    reference_scene: seen.reference.scene,
    reference_background: seen.reference.background,
    current_scene: seen.current?.scene,
    similarity: seen.similarity,
    spots: [],
  };

  // With no second photo there is nothing to compare, so we never claim a
  // match — we just look for places like the reference.
  const matches = seen.current !== undefined && seen.similarity >= threshold;
  if (matches) {
    return {
      ...base,
      matches: true,
      reason: 'already_matching',
      message: `Your background already looks like the reference — ${sceneLabel(seen.reference.scene)}. Stay where you are.`,
    };
  }

  const difference = seen.difference ?? differenceLine(seen);

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return {
      ...base,
      matches: false,
      reason: 'no_location',
      message: `${difference} Share a location and I can find somewhere nearby that matches.`,
    };
  }

  let found;
  try {
    found = await spotsLikeScene(seen.reference, lat, lng, opts);
    // The categories can be too narrow in a thinly-mapped city. Ask again on
    // the words alone before telling someone there is nothing out there.
    if (found.spots.length === 0 && relax) {
      found = await spotsLikeScene(seen.reference, lat, lng, { ...opts, relax: true });
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      reason: reasonFor(error),
      matches: false,
      message: `${difference} I cannot look up spots right now, so work with the light where you are.`,
      detail: error.message,
    };
  }

  if (found.spots.length === 0) {
    return {
      ...base,
      matches: false,
      reason: 'no_results',
      radius_km: found.radius_km,
      message: `${difference} Nothing like it is mapped within ${found.radius_km} km, so the next best thing is open shade or a plain wall at golden hour.`,
    };
  }

  return {
    ...base,
    matches: false,
    reason: 'found',
    spots: found.spots,
    radius_km: found.radius_km,
    attribution: found.attribution,
    message: `${difference} ${summarizeForVoice(found.spots)}`,
  };
}

/** Our own wording, for when the model gives no sentence of its own. */
function differenceLine({ reference, current }) {
  const wanted = sceneLabel(reference.scene);
  if (!current) return `The reference is ${wanted}.`;
  return `The reference is ${wanted}; your background is ${sceneLabel(current.scene)}.`;
}
