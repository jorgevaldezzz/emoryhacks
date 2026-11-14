// Small geo helpers. Typesense does the filtering and the distance sort; these
// turn its hits into something an agent can say out loud ("about 400 metres
// north-east of you") and parse OSM's direction tags.

const EARTH_RADIUS_KM = 6371.0088;
const toRad = deg => (deg * Math.PI) / 180;
const toDeg = rad => (rad * 180) / Math.PI;

/** Great-circle distance in kilometres between two [lat, lng] points. */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees (0 = north) from the first point to the second. */
export function bearingDeg(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const SPOKEN = {
  N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast',
  E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast',
  S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest',
  W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest',
};

/** Degrees to a 16-point compass abbreviation, e.g. 225 -> "SW". */
export function compass(deg) {
  if (!Number.isFinite(deg)) return undefined;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Degrees to a word an agent can say, e.g. 225 -> "southwest". */
export function compassWord(deg) {
  const point = compass(deg);
  return point && SPOKEN[point];
}

/**
 * OSM writes `direction` as degrees ("230") or as a compass point ("SW").
 * Returns degrees, or undefined when it is neither.
 */
export function parseDirection(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return ((Math.round(asNumber) % 360) + 360) % 360;
  const index = COMPASS.indexOf(raw.toUpperCase());
  return index === -1 ? undefined : index * 22.5;
}

/** "250 m" / "1.4 km" — for reading a distance aloud. */
export function humanDistance(km) {
  if (!Number.isFinite(km)) return '';
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** True when lat/lng are real, finite, and in range. */
export function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0); // null island: almost always a bad parse
}
