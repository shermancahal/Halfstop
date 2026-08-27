/**
 * Everything the details panel needs to say about a single point:
 * coordinate formats, UTM, sun times, distance and bearing, and — when a
 * Mapbox token is configured — the nearest town and a street address.
 *
 * All of it except the geocoder is offline arithmetic, which matters: the
 * details panel is most useful exactly where there is no signal.
 */

import { MAPBOX_TOKEN } from '../config.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/* ------------------------------------------------------------------ formats */

/** Decimal degrees, at ~1 m precision. */
export function formatDD([lon, lat]) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** Degrees / minutes / seconds, the form printed on most paper maps. */
export function formatDMS([lon, lat]) {
  const part = (value, positive, negative) => {
    const hemisphere = value >= 0 ? positive : negative;
    const abs = Math.abs(value);
    const degrees = Math.floor(abs);
    const minutesFull = (abs - degrees) * 60;
    const minutes = Math.floor(minutesFull);
    const seconds = (minutesFull - minutes) * 60;
    return `${degrees}°${String(minutes).padStart(2, '0')}'${seconds.toFixed(1).padStart(4, '0')}"${hemisphere}`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

/** Degrees and decimal minutes — what most handheld GPS units display. */
export function formatDDM([lon, lat]) {
  const part = (value, positive, negative) => {
    const hemisphere = value >= 0 ? positive : negative;
    const abs = Math.abs(value);
    const degrees = Math.floor(abs);
    return `${degrees}° ${((abs - degrees) * 60).toFixed(3)}'${hemisphere}`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

/**
 * WGS84 to UTM.
 *
 * Included because UTM is what land management agencies, search and rescue,
 * and most paper quad margins actually use — reading a lat/long to a ranger
 * over a radio is not the same conversation as reading a UTM grid reference.
 *
 * Standard Transverse Mercator series; accurate to well under a metre in the
 * middle latitudes this app is used in.
 */
export function toUTM([lon, lat]) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 84) return null;

  const a = 6378137.0;              // WGS84 semi-major axis
  const f = 1 / 298.257223563;      // flattening
  const k0 = 0.9996;                // UTM scale factor
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const zone = Math.floor((lon + 180) / 6) + 1;
  const lonOrigin = (zone - 1) * 6 - 180 + 3;

  const latRad = lat * RAD;
  const lonRad = (lon - lonOrigin) * RAD;

  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
  const T = Math.tan(latRad) ** 2;
  const C = ep2 * Math.cos(latRad) ** 2;
  const A = Math.cos(latRad) * lonRad;

  const M = a * (
    (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latRad
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latRad)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latRad)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * latRad)
  );

  const easting = k0 * N * (
    A + ((1 - T + C) * A ** 3) / 6
    + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120
  ) + 500000;

  let northing = k0 * (M + N * Math.tan(latRad) * (
    A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24
    + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720
  ));
  if (lat < 0) northing += 10000000;  // false northing in the southern hemisphere

  return {
    zone,
    band: latitudeBand(lat),
    easting: Math.round(easting),
    northing: Math.round(northing),
    toString() {
      return `${this.zone}${this.band} ${this.easting}E ${this.northing}N`;
    },
  };
}

/** MGRS latitude band letter. I and O are skipped, as they read as 1 and 0. */
function latitudeBand(lat) {
  const bands = 'CDEFGHJKLMNPQRSTUVWX';
  const index = Math.floor((lat + 80) / 8);
  return bands[Math.max(0, Math.min(bands.length - 1, index))];
}

/* ------------------------------------------------------------------ geometry */

export function distanceBearing(from, to) {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const φ1 = lat1 * RAD;
  const φ2 = lat2 * RAD;
  const Δφ = φ2 - φ1;
  const Δλ = (lon2 - lon1) * RAD;

  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const distance = 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const bearing = (Math.atan2(y, x) * DEG + 360) % 360;

  return { distance, bearing };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassPoint(bearing) {
  return COMPASS[Math.round(((bearing % 360) / 22.5)) % 16];
}

/* ------------------------------------------------------------------ sun */

/**
 * Sunrise and sunset for a point and date, by the NOAA algorithm.
 *
 * Worth having offline: "how long until dark" is the question that decides
 * whether you push on to the next pass or make camp here.
 *
 * @returns {{sunrise: Date|null, sunset: Date|null, note: string}}
 */
export function sunTimes([lon, lat], date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000);

  const zenith = 90.833 * RAD;   // includes refraction and the sun's radius
  const latRad = lat * RAD;
  const declination = 23.45 * RAD * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);

  const cosHourAngle = (Math.cos(zenith) - Math.sin(latRad) * Math.sin(declination))
    / (Math.cos(latRad) * Math.cos(declination));

  if (cosHourAngle > 1) return { sunrise: null, sunset: null, note: 'The sun does not rise here today.' };
  if (cosHourAngle < -1) return { sunrise: null, sunset: null, note: 'The sun does not set here today.' };

  const hourAngle = Math.acos(cosHourAngle) * DEG;
  const solarNoon = 12 - lon / 15
    - 0.17 * Math.sin((4 * Math.PI * (dayOfYear - 80)) / 373)
    + 0.129 * Math.sin((2 * Math.PI * (dayOfYear - 8)) / 355);

  const toDate = (utcHours) => {
    const clamped = ((utcHours % 24) + 24) % 24;
    const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    result.setUTCMinutes(Math.round(clamped * 60));
    return result;
  };

  return {
    sunrise: toDate(solarNoon - hourAngle / 15),
    sunset: toDate(solarNoon + hourAngle / 15),
    note: '',
  };
}

/* ------------------------------------------------------------------ geocoding */

const geocodeCache = new Map();

/**
 * Nearest place and street address, via the Mapbox geocoder.
 *
 * Needs a token and a connection, so it is strictly an enhancement: everything
 * else in this module works with neither. Results are cached per rounded
 * coordinate, since panning around one pin should not spend a request each time.
 *
 * @returns {Promise<{place: string, address: string, context: string, regionCode: string,
 *   regionName: string}|null>}
 */
export async function reverseGeocode([lon, lat]) {
  if (!MAPBOX_TOKEN) return null;

  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  /*
   * No `types`, and no `limit`.
   *
   * This used to ask for `types=address,place,locality,region&limit=5`, and
   * every one of those requests came back 422. The v5 API allows a `limit`
   * above 1 only alongside a *single* `types` value — four types and a limit of
   * five is not a narrower query, it is an invalid one.
   *
   * It failed silently for as long as it existed. `reverseGeocode` returns null
   * on a bad response and every caller treats null as "no answer yet", so the
   * place name was simply absent and the route markers quietly fell back to the
   * generic design. What made it survive review is that the probe written to
   * check the geocoder used a single type — a legal URL that the app never
   * sends. Probing a convenient URL instead of the shipped one proves the
   * service is up and nothing about whether the app can talk to it.
   *
   * Asking for the whole hierarchy needs neither parameter, so there is no
   * combination left to get wrong.
   */
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json`
    + `?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      warnOnce(`[place] the geocoder refused the request: ${response.status} ${response.statusText}. `
        + 'Place names and state route markers will be unavailable.');
      return null;
    }
    const result = parsePlace(await response.json());
    geocodeCache.set(key, result);
    return result;
  } catch {
    // Offline, or the request was blocked. The panel simply omits the section.
    return null;
  }
}

/**
 * Places matching a typed query, nearest first.
 *
 * Forward geocoding, which is the other half of the same service — so it
 * carries the same conditions: a token, a connection, and nothing at all when
 * either is missing. Offline the box says so rather than sitting empty, which
 * is why this returns a reason and not just a list.
 *
 * `proximity` is what makes it useful on a map rather than a search engine:
 * "Elk Creek" matches a dozen places in the west, and the one you mean is the
 * one you are looking at. No `types`, because v5 rejects a limit above one
 * alongside more than a single type — see the comment in `reverseGeocode`, it
 * is the same trap and it fails just as silently.
 *
 * @returns {Promise<{ok: boolean, reason: string, results: Array}>}
 */
export async function searchPlaces(query, { near = null, limit = 6, signal = null } = {}) {
  const text = String(query || '').trim();
  if (!text) return { ok: true, reason: '', results: [] };
  if (!MAPBOX_TOKEN) return { ok: false, reason: 'Search needs a Mapbox token.', results: [] };

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json`
    + `?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`
    + `&limit=${limit}&country=us&autocomplete=true`
    + (near ? `&proximity=${near[0].toFixed(3)},${near[1].toFixed(3)}` : '');

  try {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) {
      return { ok: false, reason: `The geocoder answered ${response.status}.`, results: [] };
    }
    return { ok: true, reason: '', results: parseSearch(await response.json()) };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { ok: false, reason: 'No answer — you may be offline.', results: [] };
  }
}

/**
 * Search results, flattened to what a list needs.
 *
 * Split from the request for the same reason `parsePlace` is: this half can be
 * tested without a network, and it is the half that decides what the list
 * says.
 */
export function parseSearch(data) {
  return (data?.features || []).map((feature) => {
    const types = feature.place_type || [];
    const context = (feature.context || [])
      .filter((entry) => /^(place|region|district)\./.test(String(entry.id || '')))
      .map((entry) => entry.text);

    return {
      id: feature.id || feature.place_name,
      name: feature.text || feature.place_name || '',
      // Everything after the first comma of the full name is where it is; the
      // context array says the same thing more reliably when it is present.
      context: context.join(', ') || (feature.place_name || '').split(',').slice(1).join(',').trim(),
      kind: PLACE_KINDS[types[0]] || (feature.properties?.category || '').split(',')[0] || 'Place',
      center: feature.center || feature.geometry?.coordinates || null,
      bbox: feature.bbox || null,
    };
  }).filter((entry) => Array.isArray(entry.center) && entry.center.length === 2);
}

/* What the geocoder's own type names are called in a list a person reads. */
const PLACE_KINDS = {
  poi: 'Place',
  place: 'Town',
  locality: 'Locality',
  neighborhood: 'Neighbourhood',
  address: 'Address',
  postcode: 'Postcode',
  region: 'State',
  district: 'County',
};

/** Said once rather than on every pan, which would be a wall of identical lines. */
const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * Pull a place, an address and a state out of a v5 reverse-geocode answer.
 *
 * Separate from the request because the two fail in different ways and only one
 * of them can be tested without a network: this is the half that decides which
 * state route marker the whole map draws, from a response shape that varies
 * with what actually exists at the point.
 *
 * The variation is the reason for `pick`. Mapbox returns the hierarchy two
 * ways — as sibling features in `features`, and as a `context` array hanging
 * off the most specific one — and which you get depends on the location. Out in
 * open country there may be no address feature at all and the state is only
 * ever in `context`. Reading just one of the two works everywhere the developer
 * happened to test and nowhere else.
 */
export function parsePlace(data) {
  const features = data?.features || [];

  const byType = (type) => features.find((feature) => (feature.place_type || []).includes(type));
  const inContext = (type) => {
    for (const feature of features) {
      const hit = (feature.context || []).find((entry) => String(entry.id || '').startsWith(`${type}.`));
      if (hit) return hit;
    }
    return null;
  };
  const pick = (type) => byType(type) || inContext(type);

  // A sibling feature carries its short code under `properties`; a context
  // entry carries it at the top level. Same field, two places.
  const shortCode = (entry) => entry?.properties?.short_code || entry?.short_code || '';

  const address = byType('address');
  const place = pick('place') || pick('locality');
  const region = pick('region');

  return {
    address: address?.place_name?.split(',')[0] || '',
    place: place?.text || '',
    context: [place?.text, region?.text].filter(Boolean).join(', '),
    // Two-letter state code, from Mapbox's ISO 3166-2 short code ("US-KY").
    // Route shields are per-state, and the road data does not reliably say
    // which state a road is in — where you are looking does.
    regionCode: shortCode(region).replace(/^US-/i, '').toUpperCase(),
    // The state's own name, so a panel that groups something by state can
    // write "Kentucky" without carrying a table of fifty codes to do it.
    regionName: region?.text || '',
  };
}
