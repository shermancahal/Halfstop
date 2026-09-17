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

/* ------------------------------------------------------------------ parsing */

/*
 * The three formats above, read back.
 *
 * This is the inverse of formatDD, formatDDM and formatDMS, and it lives
 * beside them so the two stay in step: anything the details panel prints can
 * be pasted into the search box and lands back on the same spot. That is the
 * test the suite actually makes - format, parse, compare - rather than a list
 * of strings somebody thought of.
 *
 * It also has to read what other things write, because the reason to type a
 * coordinate at all is usually that something else gave you one: a GPS screen,
 * a ranger over the radio, a text message, the margin of a paper quad. So the
 * punctuation is taken loosely - the degree sign is optional, minutes may be
 * an apostrophe or a prime or nothing, a comma is a separator and so is a
 * space - while the numbers are taken strictly.
 */

/*
 * The characters that get pasted in place of the ones a coordinate is written
 * with, normalised before any rule below reads them.
 *
 * Written as escapes, and the comments name them rather than showing them,
 * because this table is a list of confusables: a masculine ordinal and a
 * degree sign are the same shape at reading size, which is the whole reason
 * people paste one for the other, and a source file that displays them side by
 * side to prove a point is a source file nobody can proofread. The repo bans
 * stray non-ASCII in source for that reason, and this is the one place it
 * would be most tempting, and least useful, to make an exception.
 */
const LOOKALIKES = [
  // degree sign, masculine ordinal, ring above, ring operator
  [/[\u00B0\u00BA\u02DA\u2218]/g, ' '],
  // prime, right single quote, acute accent, backtick, apostrophe
  [/[\u2032\u2019\u00B4\u0060\u0027]/g, ' '],
  // double prime, right and left double quote, quotation mark
  [/[\u2033\u201D\u201C\u0022]/g, ' '],
  // minus sign, en dash, em dash: a minus that is not a hyphen
  [/[\u2212\u2013\u2014]/g, '-'],
  // separators that turn up between a pair and mean nothing else here
  [/[;/|]/g, ' '],
];

/**
 * A coordinate a person typed, or null if this is not one.
 *
 * Accepts decimal degrees, degrees and decimal minutes, and degrees / minutes
 * / seconds, with the hemisphere as a letter on either side of its number or
 * as a sign on the degrees.
 *
 * Which number is the latitude:
 *
 *   - A letter settles it. N and S mark a latitude, E and W a longitude,
 *     whichever order they arrive in, so "W84 N35" is read the same as
 *     "N35 W84".
 *   - With no letters, latitude comes first. That is the convention, and it
 *     is the order every format above prints.
 *   - Unless it cannot: a first number past 90 is not a latitude, so
 *     "-84.28, 35.96" is read as longitude first and says so. The caller is
 *     expected to show what it resolved to rather than act on it, because
 *     this is the one rule here that is a guess.
 *
 * @param {string} text
 * @returns {{lon: number, lat: number, swapped: boolean}|null}
 */
export function parseCoordinate(text) {
  let clean = String(text ?? '').trim();
  if (!clean) return null;
  for (const [pattern, replacement] of LOOKALIKES) clean = clean.replace(pattern, replacement);
  clean = clean.toUpperCase();

  /*
   * Anything that is not a number, a hemisphere letter or a separator makes
   * this not a coordinate. Without this check "Mount Elbert 14440" parses:
   * the letters are ignored, the number survives, and a search for a peak
   * quietly offers a point in the Gulf of Guinea.
   */
  if (/[^0-9NSEW.,\-+\s]/.test(clean)) return null;

  const tokens = clean.match(/-?\d+(?:\.\d+)?|[NSEW]|,/g);
  if (!tokens) return null;

  /*
   * Numbers gather into groups; a letter or a comma closes one.
   *
   * A letter before its numbers ("N 35 57") is a prefix and waits for them; a
   * letter after ("35 57 N") closes the group it follows. Both forms are in
   * circulation and neither is worth refusing.
   */
  const groups = [];
  let numbers = [];
  let pending = '';          // a letter seen before its numbers
  const close = (letter) => {
    if (!numbers.length) return true;
    if (groups.length === 2) return false;
    groups.push({ numbers, letter: letter || pending });
    numbers = [];
    pending = '';
    return true;
  };

  for (const token of tokens) {
    if (token === ',') {
      if (!close('')) return null;
    } else if (/[NSEW]/.test(token)) {
      if (!numbers.length) {
        if (pending) return null;   // two letters with no number between them
        pending = token;
      } else if (pending) {
        /*
         * This group already had its letter in front of it, so this one
         * belongs to the group after it: "N35.96 W84.28" is two prefixed
         * numbers, not one suffixed number followed by a stray W.
         */
        const next = token;
        if (!close('')) return null;
        pending = next;
      } else if (!close(token)) {
        return null;
      }
    } else {
      numbers.push(Number(token));
    }
  }
  if (!close('')) return null;

  /*
   * One long run of numbers and nothing to break it up: split it down the
   * middle, and only when the middle is unambiguous. Six numbers are two
   * DMS coordinates and four are two DDM ones; five are not anything.
   */
  if (groups.length === 1) {
    const flat = groups[0].numbers;
    if (!flat.length || flat.length % 2 || groups[0].letter) return null;
    groups.length = 0;
    groups.push({ numbers: flat.slice(0, flat.length / 2), letter: '' });
    groups.push({ numbers: flat.slice(flat.length / 2), letter: '' });
  }
  if (groups.length !== 2) return null;

  const values = groups.map(toDegrees);
  if (values.some((value) => value === null)) return null;

  return orient(values[0], values[1], groups[0].letter, groups[1].letter);
}

/** Degrees, minutes and seconds collapsed to one signed number. */
function toDegrees({ numbers, letter }) {
  if (!numbers.length || numbers.length > 3) return null;
  const [degrees, minutes = 0, seconds = 0] = numbers;
  if (!numbers.every(Number.isFinite)) return null;

  /*
   * A sign and a letter together is not a coordinate anybody meant. "-35 S"
   * is either 35 south written twice or 35 north written wrong, and picking
   * one of those for somebody navigating by it is not a choice this should
   * make.
   */
  if (letter && degrees < 0) return null;
  // Only the degrees carry the sign; "35 -57" is a typo, not a minute.
  if (minutes < 0 || seconds < 0) return null;
  // 60 minutes is the next degree, and every device that emits these knows it.
  if (minutes >= 60 || seconds >= 60) return null;
  // Minutes have to be whole before there can be seconds, for the same reason.
  if (numbers.length === 3 && !Number.isInteger(minutes)) return null;
  if (numbers.length > 1 && !Number.isInteger(degrees)) return null;

  const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  const sign = degrees < 0 || letter === 'S' || letter === 'W' ? -1 : 1;
  return { value: magnitude * sign, axis: letter === 'N' || letter === 'S' ? 'lat' : letter === 'E' || letter === 'W' ? 'lon' : '' };
}

/** Which of the two is the latitude, and is the pair on the globe at all. */
function orient(first, second, firstLetter, secondLetter) {
  let lat;
  let lon;
  let swapped = false;

  if (first.axis && second.axis) {
    if (first.axis === second.axis) return null;   // two latitudes is not a place
    lat = first.axis === 'lat' ? first.value : second.value;
    lon = first.axis === 'lon' ? first.value : second.value;
    swapped = first.axis === 'lon';
  } else if (first.axis || second.axis) {
    // One letter is enough: it names one axis and the other is the other.
    const known = first.axis ? first : second;
    const other = first.axis ? second : first;
    lat = known.axis === 'lat' ? known.value : other.value;
    lon = known.axis === 'lon' ? known.value : other.value;
    swapped = known === second ? known.axis === 'lat' : known.axis === 'lon';
  } else if (Math.abs(first.value) > 90 && Math.abs(second.value) <= 90) {
    lat = second.value;
    lon = first.value;
    swapped = true;
  } else {
    lat = first.value;
    lon = second.value;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat, swapped };
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
