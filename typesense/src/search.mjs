// searchNearby(lat, lng, opts) — the one thing the rest of the repo imports.
//
// This is an *optional* branch of the product: the pose agent coaches fine with
// no location at all. So nothing here asks for a location, and
// findNearbySpots() never throws — a search that fails degrades to "no spots",
// which the agent can answer around, rather than breaking a live call.
import { COLLECTION, ConfigError, isMissing, searchClient } from './client.mjs';
import { bearingDeg, compass, compassWord, distanceKm, humanDistance, isValidLatLng } from './geo.mjs';
import { ATTRIBUTION, CATEGORIES } from './osm.mjs';

export { COLLECTION, CATEGORIES };

/** Errors from this module carry a machine-readable `code`. */
export class SpotSearchError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'SpotSearchError';
    this.code = code; // bad_input | not_seeded | unavailable
  }
}

const DEFAULT_RADIUS_KM = 3;
const MAX_RADIUS_KM = 40;
const DEFAULT_LIMIT = 5;

let shared;
/** Lazily built shared read client, so importing this module costs nothing. */
function defaultClient() {
  shared ??= searchClient();
  return shared;
}

/** Reset the cached client. Tests and long-running processes that rotate keys. */
export function resetClient() {
  shared = undefined;
}

function escapeFilterValue(value) {
  // Typesense filter syntax uses backticks to quote values containing commas.
  return '`' + String(value).replace(/`/g, '') + '`';
}

function buildFilters({ lat, lng, radiusKm, categories, curatedOnly, minQuality, city, excludeIndoor, bestTime }) {
  const filters = [`location:(${lat}, ${lng}, ${radiusKm} km)`];

  if (categories?.length) {
    const known = categories.filter(c => CATEGORIES.includes(c) || c === 'curated');
    if (known.length) filters.push(`category:[${known.map(escapeFilterValue).join(', ')}]`);
  }
  if (curatedOnly) filters.push('source:=curated');
  if (Number.isFinite(minQuality)) filters.push(`quality:>=${Math.round(minQuality)}`);
  if (city) filters.push(`city:=${escapeFilterValue(city)}`);
  if (excludeIndoor) filters.push('indoor:!=true');
  if (bestTime) filters.push(`best_time:=${escapeFilterValue(bestTime)}`);

  return filters.join(' && ');
}

function toSpot(hit, lat, lng) {
  const doc = hit.document ?? hit;
  const [spotLat, spotLng] = doc.location ?? [];

  // Typesense reports the distance when we sort by the geopoint; fall back to
  // computing it when a text match drove the ranking instead.
  const metres = hit.geo_distance_meters?.location;
  const km = Number.isFinite(metres) ? metres / 1000 : distanceKm(lat, lng, spotLat, spotLng);

  // Under ~20 m the caller is already standing on it, and a bearing computed
  // over that distance is noise. Say so rather than inventing a direction.
  const underfoot = km < 0.02;
  const bearing = underfoot ? undefined : bearingDeg(lat, lng, spotLat, spotLng);

  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    tags: doc.tags ?? [],
    lat: spotLat,
    lng: spotLng,
    city: doc.city,
    distance_km: Math.round(km * 100) / 100,
    distance_text: underfoot ? 'right here' : humanDistance(km),
    heading: compass(bearing),
    heading_text: compassWord(bearing),
    faces: doc.direction === undefined ? undefined : compassWord(doc.direction),
    best_time: doc.best_time,
    tips: doc.tips ?? [],
    indoor: doc.indoor ?? false,
    source: doc.source,
    quality: doc.quality,
    website: doc.website,
    image: doc.image,
    maps_url: `https://www.google.com/maps/search/?api=1&query=${spotLat},${spotLng}`,
  };
}

/**
 * Photo spots near a point, nearest first.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {object} [opts]
 * @param {number}   [opts.radiusKm=3]      Where to start looking.
 * @param {number}   [opts.maxRadiusKm=40]  Ceiling when expanding.
 * @param {boolean}  [opts.expand=true]     Widen the radius while nothing is found.
 * @param {number}   [opts.limit=5]
 * @param {string}   [opts.query]           Free text ("mural", "skyline"). Omit to rank purely by distance.
 * @param {string[]} [opts.categories]      Any of CATEGORIES.
 * @param {boolean}  [opts.curatedOnly]     Hand-picked spots only.
 * @param {number}   [opts.minQuality]
 * @param {string}   [opts.city]
 * @param {boolean}  [opts.excludeIndoor]
 * @param {string}   [opts.bestTime]        e.g. "golden hour".
 * @param {object}   [opts.client]          Override the shared client.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{spots: object[], radius_km: number, found: number, attribution: string}>}
 * @throws {ConfigError|SpotSearchError} Only on bad input or an unreachable/unseeded server. An
 *         empty area is a normal result with `spots: []`.
 */
export async function searchNearby(lat, lng, opts = {}) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!isValidLatLng(latitude, longitude)) {
    throw new SpotSearchError('bad_input', `Not a usable coordinate: ${lat}, ${lng}`);
  }

  const {
    radiusKm = DEFAULT_RADIUS_KM,
    maxRadiusKm = MAX_RADIUS_KM,
    expand = true,
    limit = DEFAULT_LIMIT,
    query,
    client = defaultClient(),
    signal,
    ...filterOpts
  } = opts;

  // Try the asked-for radius first, then widen. A spot 8 km away is still worth
  // mentioning when the alternative is nothing at all, but we would rather have
  // the one across the street.
  const radii = [Math.max(0.1, Number(radiusKm) || DEFAULT_RADIUS_KM)];
  if (expand) {
    while (radii.at(-1) < maxRadiusKm) radii.push(Math.min(radii.at(-1) * 3, maxRadiusKm));
  }

  const text = query?.trim();
  const collection = client.collections(COLLECTION).documents();

  for (const radius of radii) {
    const params = {
      q: text || '*',
      query_by: 'name,description,tags,city',
      filter_by: buildFilters({ lat: latitude, lng: longitude, radiusKm: radius, ...filterOpts }),
      // Buckets matter here. Sorting on a raw _text_match puts a far-away
      // "Reynoldstown Mural" above a mural 130 m away, purely because the word
      // is in its name. Bucketing collapses near-equal matches into one tier,
      // so distance decides within a tier, which is what "find me a mural
      // nearby" actually means.
      sort_by: text
        ? `_text_match(buckets: 4):desc,location(${latitude}, ${longitude}):asc,quality:desc`
        : `location(${latitude}, ${longitude}):asc,quality:desc`,
      per_page: Math.min(50, Math.max(1, limit)),
      exclude_fields: 'updated_at',
    };

    let result;
    try {
      result = await collection.search(params, signal ? { abortSignal: signal } : {});
    } catch (error) {
      if (isMissing(error)) {
        throw new SpotSearchError(
          'not_seeded',
          `The "${COLLECTION}" collection does not exist. Run: npm run collection && npm run seed:osm -- --city "<your city>"`,
          { cause: error },
        );
      }
      throw new SpotSearchError('unavailable', `Typesense search failed: ${error.message}`, { cause: error });
    }

    const hits = result.hits ?? [];
    if (hits.length > 0 || radius === radii.at(-1)) {
      const spots = hits.map(hit => toSpot(hit, latitude, longitude));
      return {
        spots,
        radius_km: radius,
        found: result.found ?? hits.length,
        // Only claim OSM when an OSM row is actually in the answer; a purely
        // curated result is ours.
        attribution: spots.some(spot => spot.source === 'osm') ? ATTRIBUTION : '',
      };
    }
  }

  return { spots: [], radius_km: radii.at(-1), found: 0, attribution: '' };
}

/**
 * The shape to hand an LLM tool call. Never throws and never rejects: every
 * failure becomes an `ok: false` the agent can speak around, because this
 * feature is optional and a live FaceTime call should not end over it.
 *
 * @param {{lat: number, lng: number} & Record<string, unknown>} args
 */
export async function findNearbySpots(args = {}) {
  const { lat, lng, ...opts } = args;

  if (lat === undefined || lng === undefined) {
    return {
      ok: false,
      reason: 'no_location',
      spots: [],
      message: 'No location available. Ask the caller whether they want to share one before calling this again.',
    };
  }

  try {
    const { spots, radius_km, attribution } = await searchNearby(lat, lng, opts);
    if (spots.length === 0) {
      return {
        ok: true,
        reason: 'no_results',
        spots: [],
        radius_km,
        message: `Nothing mapped within ${radius_km} km. Coverage is thin outside dense cities, so fall back to general advice: open shade, a plain wall, or backlight at golden hour.`,
      };
    }
    return { ok: true, spots, radius_km, attribution, message: summarizeForVoice(spots) };
  } catch (error) {
    const code = error instanceof SpotSearchError ? error.code
      : error instanceof ConfigError ? 'not_configured'
      : 'unavailable';
    return {
      ok: false,
      reason: code,
      spots: [],
      // The agent says the message; the details are for our logs, not the caller.
      message: 'Spot search is unavailable right now. Carry on coaching the pose without it.',
      detail: error.message,
    };
  }
}

/** One or two sentences an agent can read out. Keeps replies short, as the call wants. */
export function summarizeForVoice(spots, count = 2) {
  const picked = spots.slice(0, Math.max(1, count));
  if (picked.length === 0) return 'No spots nearby.';
  const parts = picked.map(spot => {
    const facing = spot.faces ? `, facing ${spot.faces}` : '';
    const where = spot.heading_text ? `${spot.distance_text} ${spot.heading_text}` : spot.distance_text;
    return `${spot.name}, ${where}${facing}`;
  });
  return parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join('; ')}; and ${parts.at(-1)}.`;
}
