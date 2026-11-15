// The shared vocabulary between "what is in this photo" and "what is in the index".
//
// A vision model can describe a background a thousand ways; photo_spots knows a
// dozen categories. This file is the translation table, and it is deliberately
// short — every extra scene is one more thing the model can be wrong about, and
// one more way for a mountain photo to come back with a parking lot.
import { CATEGORIES } from './osm.mjs';

/**
 * One entry per background we can act on.
 *   look       how to recognise it — this goes into the vision prompt verbatim
 *   label      a noun phrase the agent can say ("the reference is a mountain")
 *   categories spot categories that photograph like this, best first
 *   terms      free text for the Typesense match, in case the categories are empty here
 */
export const SCENES = {
  mountain: {
    look: 'a summit, ridge, cliff or mountain range behind the subject',
    label: 'a mountain',
    categories: ['peak', 'cliff', 'viewpoint'],
    terms: 'summit peak ridge overlook mountain',
  },
  skyline: {
    look: 'a city skyline, downtown towers, or a high view over rooftops',
    label: 'a city skyline',
    categories: ['viewpoint', 'bridge'],
    terms: 'skyline downtown rooftop overlook',
  },
  water: {
    look: 'open water — a lake, river, harbour or waterfront',
    label: 'open water',
    categories: ['pier', 'beach', 'viewpoint'],
    terms: 'water lake river harbour dock waterfront',
  },
  beach: {
    look: 'sand, surf or a shoreline',
    label: 'a beach',
    categories: ['beach', 'pier'],
    terms: 'beach sand shoreline boardwalk',
  },
  waterfall: {
    look: 'falling water, a cascade or rapids',
    label: 'a waterfall',
    categories: ['waterfall'],
    terms: 'waterfall falls cascade creek',
  },
  forest: {
    look: 'trees, woods or dense greenery',
    label: 'forest',
    categories: ['park', 'garden', 'viewpoint'],
    terms: 'forest woods trees trail greenery',
  },
  garden: {
    look: 'planted flowers, hedges, a greenhouse or a botanical garden',
    label: 'a garden',
    categories: ['garden', 'park'],
    terms: 'garden flowers botanical greenhouse',
  },
  park: {
    look: 'open grass with scattered trees',
    label: 'a park',
    categories: ['park', 'garden'],
    terms: 'park lawn green space',
  },
  mural: {
    look: 'a painted wall, street art or graffiti',
    label: 'a mural',
    categories: ['mural', 'artwork'],
    terms: 'mural street art graffiti painted wall',
  },
  architecture: {
    look: 'a notable building, facade, columns, arches or a staircase',
    label: 'architecture',
    categories: ['attraction', 'artwork', 'bridge'],
    terms: 'architecture building facade monument columns',
  },
  street: {
    look: 'an ordinary street, alley, storefronts or parked cars',
    label: 'a street',
    categories: ['mural', 'artwork', 'attraction'],
    terms: 'street alley storefront urban',
  },
  bridge: {
    look: 'a bridge, overpass or railing',
    label: 'a bridge',
    categories: ['bridge', 'viewpoint'],
    terms: 'bridge overpass railing',
  },
  interior: {
    look: 'indoors — a room, cafe, office or hallway',
    label: 'indoors',
    categories: ['attraction', 'artwork'],
    terms: 'museum gallery atrium indoor',
  },
  plain: {
    look: 'a blank wall, curtain or studio backdrop with nothing behind the subject',
    label: 'a plain wall',
    // Nothing in the index is "a blank wall", so this one searches on words
    // alone rather than pinning the category filter to something wrong.
    categories: [],
    terms: 'wall plain backdrop',
  },
};

/** Fixed background families used by the website's location recommender. */
export const BACKGROUND_GROUPS = {
  park_skatepark_beltline_water: {
    label: 'Park, skatepark, BeltLine & water',
    tags: ['park', 'skatepark', 'beltline', 'water'],
    categories: ['park', 'viewpoint', 'beach', 'pier'],
    terms: 'park',
    look: 'a park, skatepark, BeltLine trail, or water setting',
  },
  campus_architecture_marble: {
    label: 'Campus, architecture & marble',
    tags: ['campus', 'architecture', 'marble'],
    categories: ['attraction', 'artwork', 'bridge', 'viewpoint'],
    terms: 'architecture',
    look: 'a campus, notable architecture, or marble building',
  },
  historic_sweet_auburn_landmark: {
    label: 'Historic Sweet Auburn landmarks',
    tags: ['historic', 'sweet auburn', 'landmark'],
    categories: ['attraction', 'artwork', 'viewpoint'],
    terms: 'historic',
    look: 'a historic place, Sweet Auburn, or a landmark',
  },
  garden_greenery_ticketed: {
    label: 'Garden, greenery & ticketed places',
    tags: ['garden', 'greenery', 'ticketed'],
    categories: ['garden', 'park'],
    terms: 'garden',
    look: 'a garden or lush greenery, especially a ticketed attraction',
  },
};

export const BACKGROUND_GROUP_KEYS = Object.keys(BACKGROUND_GROUPS);

export function normalizeBackgroundGroup(key) {
  const normalized = String(key ?? '').trim().toLowerCase();
  return BACKGROUND_GROUP_KEYS.includes(normalized) ? normalized : 'unknown';
}

/** The keys a vision model is allowed to answer with. */
export const SCENE_KEYS = Object.keys(SCENES);

/** What we call a background we could not place. Never filters, never pretends. */
export const UNKNOWN_SCENE = 'unknown';

/** The scene entry for a key, or undefined. `unknown` is not a scene. */
export function sceneFor(key) {
  return typeof key === 'string' ? SCENES[key] : undefined;
}

/** A noun phrase for a key, e.g. "a mountain". Safe to say out loud. */
export function sceneLabel(key) {
  const group = BACKGROUND_GROUPS[normalizeBackgroundGroup(key)];
  return group?.label ?? sceneFor(key)?.label ?? 'something we could not place';
}

/** Only keys we know; anything else becomes `unknown`. */
export function normalizeSceneKey(key) {
  const lower = String(key ?? '').trim().toLowerCase();
  return SCENE_KEYS.includes(lower) ? lower : UNKNOWN_SCENE;
}

// Tags come back from a model, so they are untrusted text headed for a query
// string. Keep them short, wordlike and few.
function cleanTerms(tags = []) {
  return (Array.isArray(tags) ? tags : [])
    .map(tag => String(tag).toLowerCase().replace(/[^a-z0-9' -]/g, ' ').trim())
    .filter(tag => tag.length > 1 && tag.length <= 24)
    .slice(0, 6);
}

/**
 * Turn a scene profile into the options searchNearby takes.
 *
 * @param {{scene?: string, tags?: string[]}} profile
 * @param {{relax?: boolean}} [options] `relax` drops the category filter and
 *        keeps only the words — the second pass when the first found nothing.
 * @returns {{categories: string[], query: string}}
 */
export function searchOptionsFor(profile = {}, { relax = false } = {}) {
  const groupKey = normalizeBackgroundGroup(profile.group);
  const group = BACKGROUND_GROUPS[groupKey];
  if (group) {
    return {
      categories: relax ? [] : group.categories.filter(c => CATEGORIES.includes(c)),
      query: group.terms,
    };
  }

  const key = normalizeSceneKey(profile.scene);
  const scene = sceneFor(key);

  // The model's own words first: "red brick" beats "mural" when both are true.
  const words = [...cleanTerms(profile.tags), ...(scene ? scene.terms.split(' ') : [])];
  const query = [...new Set(words)].join(' ').trim();

  const categories = relax ? [] : (scene?.categories ?? []).filter(c => CATEGORIES.includes(c));
  return { categories, query };
}

/** The scene list as prompt lines, so the prompt and this table cannot drift apart. */
export function sceneVocabulary() {
  return SCENE_KEYS.map(key => `- ${key}: ${SCENES[key].look}`).join('\n');
}
