// OpenStreetMap -> photo_spots documents.
//
// OSM tags say what a place *is*, not whether it photographs well: a viewpoint
// can be a parking-lot overlook and an attraction can be a historic marker on a
// pole. So every category carries a baseline `quality` that reflects how often
// it is worth shooting, curated spots outrank all of it (see
// data/curated/), and coverage is thin outside dense cities. Check a city with
// `npm run seed:osm -- --city "Atlanta" --dry-run` before you trust it.
//
// Data is ODbL: attribute OpenStreetMap contributors anywhere you show it, and
// read the share-alike terms before you publish a derived database.
import { isValidLatLng, parseDirection } from './geo.mjs';

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/**
 * One rule per category. `selectors` are Overpass filter expressions; `quality`
 * is the 0-100 baseline before curation.
 */
export const SPOT_RULES = [
  {
    category: 'viewpoint',
    quality: 70,
    selectors: ['nwr["tourism"="viewpoint"]'],
  },
  {
    category: 'mural',
    quality: 65,
    // artwork_type is the documented way to separate murals from statues.
    selectors: ['nwr["tourism"="artwork"]["artwork_type"~"^(mural|graffiti|street_art)$"]'],
  },
  {
    category: 'artwork',
    quality: 55,
    selectors: ['nwr["tourism"="artwork"]["artwork_type"~"^(sculpture|statue|installation|mosaic|relief)$"]'],
  },
  {
    category: 'peak',
    quality: 70,
    // The literal "top of a mountain". `ele` is usually on it too, which is
    // what makes a summit worth the walk.
    selectors: ['nwr["natural"="peak"]'],
  },
  {
    category: 'waterfall',
    quality: 70,
    selectors: ['nwr["waterway"="waterfall"]'],
  },
  {
    category: 'cliff',
    quality: 60,
    // Mapped as a way along the edge; `out center` gives us a point on it.
    selectors: ['nwr["natural"="cliff"]'],
  },
  {
    category: 'beach',
    quality: 60,
    selectors: ['nwr["natural"="beach"]'],
  },
  {
    category: 'pier',
    quality: 60,
    selectors: ['nwr["man_made"="pier"]'],
  },
  {
    category: 'bridge',
    quality: 55,
    // man_made=bridge is the structure itself, not every road that crosses
    // something — highway bridges are tagged on the way and stay out of this.
    selectors: ['nwr["man_made"="bridge"]'],
  },
  {
    category: 'garden',
    quality: 55,
    selectors: ['nwr["leisure"="garden"]["garden:type"!~"residential"]'],
  },
  {
    category: 'park',
    quality: 50,
    selectors: ['nwr["leisure"="park"]'],
  },
  {
    // Broad and noisy by design: it is the catch-all, so it ranks last.
    category: 'attraction',
    quality: 40,
    selectors: ['nwr["tourism"="attraction"]'],
  },
];

export const CATEGORIES = SPOT_RULES.map(rule => rule.category);

// Categories where an unnamed element is still a fine photo spot. An unnamed
// mural is normal; an unnamed "attraction" is almost always noise.
const KEEP_UNNAMED = new Set(['mural', 'artwork', 'viewpoint', 'waterfall', 'peak', 'cliff']);

const CATEGORY_LABEL = {
  viewpoint: 'Viewpoint', mural: 'Mural', artwork: 'Public artwork',
  peak: 'Summit', waterfall: 'Waterfall', cliff: 'Clifftop',
  beach: 'Beach', pier: 'Pier', bridge: 'Bridge',
  garden: 'Garden', park: 'Park', attraction: 'Attraction',
};

/**
 * Build an Overpass QL query for one area.
 *
 * Exactly one of these must be given:
 *   areaName  "Atlanta"                      (administrative boundary by name)
 *   bbox      [south, west, north, east]
 *   around    { lat, lng, radiusKm }
 */
export function buildOverpassQuery({ areaName, bbox, around, categories = CATEGORIES, timeout = 120 } = {}) {
  const rules = SPOT_RULES.filter(rule => categories.includes(rule.category));
  if (rules.length === 0) throw new Error(`No known categories in: ${categories.join(', ')}`);

  const given = [areaName, bbox, around].filter(Boolean).length;
  if (given !== 1) throw new Error('Pass exactly one of areaName, bbox or around.');

  let scope, preamble = '';
  if (areaName) {
    // Quotes inside a name would break out of the Overpass string literal.
    const safe = String(areaName).replace(/["\\]/g, '');
    preamble = `area["name"="${safe}"]["boundary"="administrative"]->.a;\n`;
    scope = '(area.a)';
  } else if (bbox) {
    const [s, w, n, e] = bbox.map(Number);
    if (![s, w, n, e].every(Number.isFinite)) throw new Error('bbox must be four numbers: south,west,north,east');
    scope = `(${s},${w},${n},${e})`;
  } else {
    const { lat, lng, radiusKm = 5 } = around;
    if (!isValidLatLng(Number(lat), Number(lng))) throw new Error('around needs a valid lat and lng');
    scope = `(around:${Math.round(Number(radiusKm) * 1000)},${lat},${lng})`;
  }

  const body = rules
    .flatMap(rule => rule.selectors)
    .map(selector => `  ${selector}${scope};`)
    .join('\n');

  return `[out:json][timeout:${timeout}];\n${preamble}(\n${body}\n);\nout center tags;`;
}

/** Which rule claims this element? First match wins, so order SPOT_RULES best-first. */
export function classify(tags = {}) {
  const artworkType = tags.artwork_type;
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.tourism === 'artwork') {
    if (/^(mural|graffiti|street_art)$/.test(artworkType ?? '')) return 'mural';
    return 'artwork';
  }
  if (tags.natural === 'peak') return 'peak';
  if (tags.waterway === 'waterfall') return 'waterfall';
  if (tags.natural === 'cliff') return 'cliff';
  if (tags.natural === 'beach') return 'beach';
  if (tags.man_made === 'pier') return 'pier';
  if (tags.man_made === 'bridge') return 'bridge';
  if (tags.leisure === 'garden') return 'garden';
  if (tags.leisure === 'park') return 'park';
  if (tags.tourism === 'attraction') return 'attraction';
  return undefined;
}

function qualityFor(category, tags) {
  const base = SPOT_RULES.find(rule => rule.category === category)?.quality ?? 40;
  let score = base;
  // Weak signals that someone cared enough to describe the place.
  if (tags.wikidata || tags.wikipedia) score += 10;
  if (tags.image || tags['image:url']) score += 5;
  if (tags.name) score += 5;
  if (tags.access === 'private' || tags.access === 'no') score -= 25;
  if (tags.indoor === 'yes') score -= 5;
  return Math.max(0, Math.min(100, score));
}

function collectTags(tags) {
  const out = new Set();
  for (const key of ['tourism', 'leisure', 'natural', 'man_made', 'waterway', 'artwork_type', 'historic', 'attraction']) {
    const value = tags[key];
    if (value && /^[\w:-]+$/.test(value)) out.add(value);
  }
  if (tags.wikidata) out.add('wikidata');
  return [...out];
}

function firstUrl(tags) {
  for (const key of ['website', 'contact:website', 'url']) {
    const value = tags[key];
    if (typeof value === 'string' && /^https?:\/\//.test(value)) return value.split(';')[0];
  }
  return undefined;
}

/**
 * One Overpass element -> one photo_spots document, or null when it is not
 * usable (no coordinates, no category, or unnamed noise).
 */
export function normalizeElement(element, { city, now = Date.now() } = {}) {
  if (!element || typeof element !== 'object') return null;
  const tags = element.tags ?? {};

  const lat = Number(element.lat ?? element.center?.lat);
  const lng = Number(element.lon ?? element.center?.lon);
  if (!isValidLatLng(lat, lng)) return null;

  const category = classify(tags);
  if (!category) return null;

  const name = tags.name ?? tags['name:en'] ?? tags.artist_name;
  if (!name && !KEEP_UNNAMED.has(category)) return null;

  const street = tags['addr:street'];
  const displayName =
    name ?? (street ? `${CATEGORY_LABEL[category]} on ${street}` : `Unnamed ${CATEGORY_LABEL[category].toLowerCase()}`);

  const doc = {
    id: `osm-${element.type}-${element.id}`,
    name: displayName,
    category,
    location: [lat, lng],
    source: 'osm',
    osm_id: `${element.type}/${element.id}`,
    quality: qualityFor(category, tags),
    updated_at: Math.floor(now / 1000),
  };

  const description = tags.description ?? tags.inscription ?? tags['description:en'];
  if (description) doc.description = String(description).slice(0, 500);

  const spotTags = collectTags(tags);
  if (spotTags.length) doc.tags = spotTags;

  // `direction` on a viewpoint is which way the view faces: the useful bit for
  // matching a sunset or a skyline shot.
  const direction = parseDirection(tags.direction ?? tags['camera:direction'] ?? tags['viewpoint:direction']);
  if (direction !== undefined) doc.direction = Math.round(direction);

  const cityTag = tags['addr:city'] ?? city;
  if (cityTag) doc.city = String(cityTag);

  if (tags.indoor === 'yes') doc.indoor = true;

  const website = firstUrl(tags);
  if (website) doc.website = website;
  const image = tags.image ?? tags['image:url'];
  if (typeof image === 'string' && /^https?:\/\//.test(image)) doc.image = image.split(';')[0];

  return doc;
}

/**
 * Normalize a whole Overpass response. Drops unusable elements and keeps the
 * highest-quality document when a place is mapped more than once (a node
 * inside its own way, say) at effectively the same point.
 */
export function normalizeElements(elements = [], options = {}) {
  const byKey = new Map();
  let skipped = 0;

  for (const element of elements) {
    const doc = normalizeElement(element, options);
    if (!doc) {
      skipped += 1;
      continue;
    }
    // ~11 m of precision: close enough to be the same physical place.
    const key = `${doc.category}:${doc.name.toLowerCase()}:${doc.location[0].toFixed(4)},${doc.location[1].toFixed(4)}`;
    const existing = byKey.get(key);
    if (!existing || doc.quality > existing.quality) byKey.set(key, doc);
  }

  return { docs: [...byKey.values()], skipped, duplicates: elements.length - skipped - byKey.size };
}

/** POST a query to Overpass and return the parsed elements. */
export async function fetchOverpass(query, { url = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter', signal } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass asks for a contactable agent; it rate-limits anonymous floods.
      'User-Agent': 'emoryhacks-photo-spots/1.0 (https://github.com/Stylinx/emoryhacks)',
    },
    body: new URLSearchParams({ data: query }),
    signal,
  });

  if (response.status === 429 || response.status === 504) {
    throw new Error(
      `Overpass is rate limiting or overloaded (HTTP ${response.status}). Wait a minute and retry, or set OVERPASS_URL to another instance.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Overpass returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const body = await response.json();
  if (!Array.isArray(body.elements)) throw new Error('Overpass response had no elements array.');
  return body.elements;
}
