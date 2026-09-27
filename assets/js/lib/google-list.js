/**
 * A Google Maps saved list, from the CSV that Google Takeout writes for it.
 *
 * Takeout's Saved folder holds one CSV per list - Want to go, Favorites, and
 * any list somebody made - with a title, a note, a link and sometimes tags
 * and a comment for each place. What it leaves out is where the place is.
 * Some links carry the position anyway (a dropped pin, or a link with the
 * coordinates written into it); the rest are looked up by name, on a free
 * account in OpenStreetMap and on Premium in Mapbox, and every match is shown
 * to be checked before anything is saved. A name is not a place: "Starbucks"
 * matches thousands, and a list somebody built over years is not something to
 * guess about quietly.
 *
 * Pure apart from the search function it is handed, so the reading, the
 * pacing and the document it builds are all tested without a network.
 */

import { positionInGoogleLink, summarize } from './parse.js';

/**
 * Rows out of CSV text: quoted fields, doubled quotes, commas and line breaks
 * inside quotes, CRLF or LF, and the byte-order mark Excel leaves behind.
 */
export function parseCSV(text) {
  const source = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Where the header row is, and which column is which, or null for a CSV that is not a Google list. */
function columnsOf(rows) {
  for (let index = 0; index < Math.min(rows.length, 5); index += 1) {
    const names = rows[index].map((cell) => cell.trim().toLowerCase());
    const title = names.indexOf('title');
    const url = names.indexOf('url');
    if (title !== -1 && url !== -1) {
      return {
        header: index, title, url,
        note: names.indexOf('note'), tags: names.indexOf('tags'), comment: names.indexOf('comment'),
      };
    }
  }
  return null;
}

/** Whether this text is a Google Takeout saved list. */
export function looksLikeGoogleList(text) {
  return Boolean(columnsOf(parseCSV(String(text || '').slice(0, 4000))));
}

/**
 * The place a Google link names in its path, e.g. "Moab Brewery, 686 S Main
 * St, Moab, UT 84532" from /maps/place/Moab+Brewery,+686+S+Main+St,.../ - often
 * more to search for than the title alone.
 */
export function placeInGoogleLink(url) {
  const match = /\/maps\/place\/([^/?#]+)/.exec(String(url || ''));
  if (!match || match[1].startsWith('data=')) return '';
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return '';
  }
}

/**
 * The places on a list, each with a position if its link carried one and the
 * words to look it up by if not.
 *
 * @returns {{ name: string, places: Array<{ name, note, link, position, query, include }> }}
 */
export function readGoogleList(text, filename = '') {
  const rows = parseCSV(text);
  const columns = columnsOf(rows);
  if (!columns) throw new Error('This is not a Google Maps saved list: it has no Title and URL columns.');
  const cell = (row, column) => (column === -1 ? '' : String(row[column] || '').trim());

  const places = [];
  for (const row of rows.slice(columns.header + 1)) {
    const link = cell(row, columns.url);
    const fromLink = placeInGoogleLink(link);
    const name = cell(row, columns.title) || fromLink.split(',')[0].trim();
    // Takeout writes an empty row under the header; a row with nothing to go
    // on is not a place.
    if (!name && !link) continue;
    const note = [cell(row, columns.note), cell(row, columns.comment)].filter(Boolean).join('\n\n');
    const position = positionInGoogleLink(link);
    places.push({
      name: name || 'Unnamed place',
      note,
      tags: cell(row, columns.tags),
      link,
      position,
      // The link's own words when they say more than the title does - they
      // often carry the street and the town.
      query: fromLink.length > name.length && fromLink.toLowerCase().startsWith(name.toLowerCase()) ? fromLink : name,
      candidates: [],
      choice: -1,
      include: Boolean(position),
    });
  }
  return { name: String(filename).replace(/\.csv$/i, '').trim() || 'Google Maps list', places };
}

/*
 * How far apart OpenStreetMap lookups are spaced.
 *
 * Photon is a free service komoot runs for everybody, and a list of a hundred
 * places fired at it at once is the kind of use that gets a service
 * throttled for all of its users. Two a second is gentle, and a hundred-place
 * list still finishes inside a minute. Mapbox is paid for and built for
 * volume, and only waits long enough not to trip its own rate limit.
 */
export const LOOKUP_SPACING = { osm: 500, mapbox: 120 };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Look up every place that has no position, filling in its candidates.
 *
 * On Premium, Mapbox is asked first, through its permanent geocoding - the
 * only kind whose answers Mapbox allows to be kept, and keeping them is what
 * an import does. That has to be enabled on the Mapbox account. If Mapbox
 * refuses, it is not asked again for the rest of the list, and OpenStreetMap
 * answers instead; a place Mapbox does not find is tried in OpenStreetMap too.
 *
 * @param {Array} places                  from readGoogleList, changed in place
 * @param {object} options
 * @param {Function} options.search       searchPlaces from lib/place.js
 * @param {'osm'|'mapbox'} options.provider
 * @param {Function} [options.onProgress] (done, total)
 * @param {Function} [options.stopped]    true to stop early
 * @returns {Promise<{ mapboxRefused: boolean, stoppedEarly: boolean, looked: number }>}
 */
export async function lookupPlaces(places, {
  search, provider = 'osm', onProgress = () => {}, stopped = () => false,
  wait = sleep, now = () => Date.now(), spacing = LOOKUP_SPACING,
} = {}) {
  const pending = places.filter((place) => !place.position);
  const answers = new Map();
  const lastAsked = { osm: -Infinity, mapbox: -Infinity };
  let mapboxRefused = false;
  let stoppedEarly = false;
  let done = 0;

  const ask = async (query, which) => {
    const gap = lastAsked[which] + spacing[which] - now();
    if (gap > 0) await wait(gap);
    lastAsked[which] = now();
    const answer = await search(query, { provider: which, permanent: which === 'mapbox', anywhere: true, limit: 3 });
    return {
      ...answer,
      results: (answer?.results || []).map((result) => ({ ...result, provider: which })),
    };
  };

  onProgress(0, pending.length);
  for (const place of pending) {
    if (stopped()) { stoppedEarly = true; break; }
    const key = place.query.toLowerCase();
    if (!answers.has(key)) {
      let found = [];
      if (provider === 'mapbox' && !mapboxRefused) {
        const answer = await ask(place.query, 'mapbox');
        // A refusal (no permanent geocoding on the account, a bad token) is
        // the same for every place, so it is heard once. A busy answer is
        // not a refusal.
        if (!answer.ok && answer.status && answer.status !== 429) mapboxRefused = true;
        found = answer.ok ? answer.results : [];
      }
      if (!found.length) {
        const answer = await ask(place.query, 'osm');
        found = answer.ok ? answer.results : [];
      }
      answers.set(key, found);
    }
    place.candidates = answers.get(key);
    place.choice = place.candidates.length ? 0 : -1;
    place.include = place.candidates.length > 0;
    done += 1;
    onProgress(done, pending.length);
  }
  return { mapboxRefused, stoppedEarly, looked: done };
}

/** Where a place ends up: its link's position, or the candidate chosen for it. */
export function placedAt(place) {
  if (place.position) return { center: place.position, provider: 'google' };
  return place.candidates?.[place.choice] || null;
}

/**
 * The places kept, as a document the app opens like any file.
 *
 * Each waypoint keeps the name from the list, not the name the lookup found,
 * because the list's name is the one its owner chose; the match is recorded
 * as the address, with where it came from, so a wrong guess can be recognised
 * later rather than only in the review.
 */
export function listDocument(name, places) {
  const features = [];
  places.forEach((place, index) => {
    if (!place.include) return;
    const at = placedAt(place);
    if (!at?.center) return;
    const properties = { kind: 'waypoint', name: place.name };
    if (place.note) properties.description = place.note;
    if (place.link) properties.link = place.link;
    if (at.provider !== 'google') {
      const matched = [at.name, at.context].filter(Boolean).join(', ');
      if (matched) properties.address = matched;
      properties.located = at.provider === 'mapbox' ? 'Mapbox' : 'OpenStreetMap';
    }
    features.push({
      type: 'Feature',
      id: `google-list-${index}`,
      geometry: { type: 'Point', coordinates: [Number(at.center[0]), Number(at.center[1])] },
      properties,
    });
  });

  const lons = features.map((feature) => feature.geometry.coordinates[0]);
  const lats = features.map((feature) => feature.geometry.coordinates[1]);
  const geojson = { type: 'FeatureCollection', features };
  return {
    format: 'google-list',
    name,
    description: '',
    time: null,
    geojson,
    bbox: features.length ? [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] : null,
    stats: summarize(geojson),
  };
}
