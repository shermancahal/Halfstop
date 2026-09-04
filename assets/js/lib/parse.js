/**
 * One entry point for every map file the site accepts, plus the statistics the
 * viewer and the catalogue both display.
 */

import { iconForSymbol, iconForTitle, PIN_ICONS } from './pin-icons.js';
import { parseGPX, looksLikeGPX } from './gpx.js';
import { parseKML, looksLikeKML } from './kml.js';
import { extractKMLFromKMZ } from './kmz.js';
import {
  cumulativeDistances, elevationChange, elevationRange, eachPosition,
  emptyBounds, extendBounds, geojsonBounds, lineLength,
} from './geo.js';

export const SUPPORTED_EXTENSIONS = ['.gpx', '.kml', '.kmz', '.geojson', '.json'];

function extensionOf(filename) {
  const match = /\.[a-z0-9]+$/i.exec(String(filename || ''));
  return match ? match[0].toLowerCase() : '';
}

/** Positions of a feature, flattened — line geometries only. */
function linePositions(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  if (geometry.type === 'GeometryCollection') return (geometry.geometries || []).flatMap(linePositions);
  return [];
}

function timesOf(properties) {
  const times = properties?.coordTimes;
  if (!times) return null;
  const flat = Array.isArray(times[0]) ? times.flat() : times;
  const valid = flat.filter((t) => Number.isFinite(t));
  return valid.length >= 2 ? valid : null;
}

/** Per-feature measurements, written back onto feature.properties. */
/*
 * A web address inside free text.
 *
 * Not a general URL grammar - a deliberately narrow one, because this runs
 * over prose somebody typed in the field and a false positive turns a note
 * into a broken link. It wants a scheme, or a bare host that begins www.,
 * and it stops before the punctuation that ends a sentence rather than
 * swallowing it: "see https://example.org/x." is a link to /x, not to /x.
 *
 * Closing brackets go the same way, so a URL written in parentheses does not
 * take the bracket with it. A URL that genuinely ends in one is rare enough,
 * and wrong in the harmless direction: the link still opens the site.
 */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_JUNK = /[.,;:!?)\]}>'"]+$/;

/**
 * Every web address in a piece of text, as written and as followed.
 *
 * Both, because they differ: "www.nps.gov" is written without a scheme and
 * cannot be followed without one. A renderer needs the written form to find
 * its place in the sentence and to show what the writer typed; a link needs
 * the other. `at` is where the written form starts.
 */
export function findLinkSpans(text) {
  const found = [];
  for (const match of String(text || '').matchAll(URL_PATTERN)) {
    const written = match[0].replace(TRAILING_JUNK, '');
    // "https://" and "www." on their own are not addresses.
    if (!/[^:/.]/.test(written.replace(/^https?:\/\//, '').replace(/^www\./, ''))) continue;
    found.push({
      text: written,
      href: written.toLowerCase().startsWith('www.') ? `https://${written}` : written,
      at: match.index,
    });
  }
  return found;
}

/** Every web address in a piece of text, in the order they appear. */
export function findLinks(text) {
  return findLinkSpans(text).map((span) => span.href);
}

/** The first web address in a piece of text, or null. */
export function findLink(text) {
  return findLinks(text)[0] || null;
}

/**
 * The same text with one address cut out of it, tidied up after.
 *
 * "Write-up at https://example.org/x, worth a read." with the address removed
 * is "Write-up at, worth a read.", so the words left dangling round the hole
 * are trimmed too: a preposition with nothing after it, the space doubled
 * where the address was, an empty pair of brackets. What is left of a note
 * that was nothing but an address is nothing, not a stray comma.
 */
export function withoutSpan(text, span) {
  const value = String(text || '');
  if (!span) return value;
  const tidied = `${value.slice(0, span.at)}${value.slice(span.at + span.text.length)}`
    .replace(/([([{<])\s*([)\]}>])/g, '')
    .replace(/\b(?:at|on|see|via|from)\s*(?=[,.;:]|$)/gi, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.;:)\]}>]+\s*/, '')
    .trim();
  // Punctuation on its own is not a note.
  return /[\p{L}\p{N}]/u.test(tidied) ? tidied : '';
}

/**
 * A web address typed into a note becomes the pin's link, and leaves the note.
 *
 * A note is for what the place is like; a bare address in the middle of one is
 * neither read comfortably nor tapped comfortably, and every file format has
 * somewhere better to put it. So it moves - and because it moves, the words
 * left dangling round the hole are tidied after it.
 *
 * Only when the pin has no link already: a <link> the file carried is the one
 * its writer meant, and a URL further down the prose is an aside.
 *
 * Only the first, too. A note listing three sources is a note about three
 * sources, not a pin with three links; the rest stay where they are and stay
 * clickable where they are shown.
 */
export function adoptNoteLink(props) {
  if (!props || props.link) return props;
  const note = props.description || props.notes || '';
  const [span] = findLinkSpans(note);
  if (!span) return props;
  props.link = span.href;
  props.description = withoutSpan(note, span);
  return props;
}

export function measureFeature(feature) {
  const geometry = feature.geometry;
  const kind = feature.properties?.kind;
  const measurements = { distance: null, ascent: null, descent: null, elevation: null, duration: null };

  if (kind !== 'waypoint' && geometry) {
    const segments = geometry.type === 'MultiLineString'
      ? geometry.coordinates
      : [linePositions(geometry)].filter((s) => s.length);

    let distance = 0;
    let ascent = 0;
    let descent = 0;
    for (const segment of segments) {
      distance += lineLength(segment);
      const change = elevationChange(segment);
      ascent += change.ascent;
      descent += change.descent;
    }
    if (segments.length) {
      measurements.distance = distance;
      const all = segments.flat();
      const range = elevationRange(all);
      if (range) { measurements.ascent = ascent; measurements.descent = descent; measurements.elevation = range; }
    }

    const times = timesOf(feature.properties);
    if (times) measurements.duration = (times[times.length - 1] - times[0]) / 1000;
  }

  Object.assign(feature.properties, {
    distance_m: measurements.distance,
    ascent_m: measurements.ascent,
    descent_m: measurements.descent,
    elevation_min_m: measurements.elevation?.min ?? null,
    elevation_max_m: measurements.elevation?.max ?? null,
    duration_s: measurements.duration,
  });
  return measurements;
}

/** Aggregate stats for a whole document. */
export function summarize(geojson) {
  const stats = {
    featureCount: 0, trackCount: 0, routeCount: 0, waypointCount: 0, areaCount: 0,
    distance_m: 0, ascent_m: 0, descent_m: 0,
    elevation_min_m: null, elevation_max_m: null,
    duration_s: 0, startTime: null, endTime: null,
  };

  for (const feature of geojson.features || []) {
    if (!feature.properties) feature.properties = {};
    /*
     * GPX <sym> and KML IconStyle are the only styling most files carry for
     * points; translate them once here so every consumer sees a resolved icon.
     *
     * The pin's own name is asked first, because an exporter that stamps every
     * point with the same generic symbol - which GaiaGPS does - leaves the
     * title as the only thing that says what the place is.
     */
    if (!feature.properties.icon && feature.properties.kind === 'waypoint') {
      const resolved = iconForTitle(feature.properties.name)
        || iconForSymbol(feature.properties.symbol)
        || iconForSymbol(feature.properties.iconHref)
        || iconForSymbol(feature.properties.type);
      if (resolved) feature.properties.icon = resolved;
    }
    adoptNoteLink(feature.properties);
    const measurements = measureFeature(feature);
    stats.featureCount++;

    const kind = feature.properties.kind;
    if (kind === 'waypoint') stats.waypointCount++;
    else if (kind === 'route') stats.routeCount++;
    else if (kind === 'area') stats.areaCount++;
    else stats.trackCount++;

    if (measurements.distance) stats.distance_m += measurements.distance;
    if (measurements.ascent) stats.ascent_m += measurements.ascent;
    if (measurements.descent) stats.descent_m += measurements.descent;
    if (measurements.duration) stats.duration_s += measurements.duration;

    if (measurements.elevation) {
      stats.elevation_min_m = stats.elevation_min_m === null
        ? measurements.elevation.min : Math.min(stats.elevation_min_m, measurements.elevation.min);
      stats.elevation_max_m = stats.elevation_max_m === null
        ? measurements.elevation.max : Math.max(stats.elevation_max_m, measurements.elevation.max);
    }

    const times = timesOf(feature.properties);
    if (times) {
      const first = times[0];
      const last = times[times.length - 1];
      stats.startTime = stats.startTime === null ? first : Math.min(stats.startTime, first);
      stats.endTime = stats.endTime === null ? last : Math.max(stats.endTime, last);
    }
  }
  return stats;
}

const KNOWN_PIN_IDS = new Set(PIN_ICONS.map((icon) => icon.id));

/**
 * Read what another app called things, into what this one calls them.
 *
 * GeoJSON has no vocabulary for a waypoint's name, note, colour or symbol, so
 * every exporter invents one. GaiaGPS writes `title`, `notes`, `icon` and a
 * colour; the simplestyle convention Mapbox and GitHub render writes
 * `marker-color`, `marker-symbol` and `description`; GPX-shaped exports carry
 * `desc`, `cmt` and `sym`. The name was already translated; the rest arrived
 * as dead properties, so a folder of Gaia pins came across as untitled-looking
 * dots with their notes and colours silently left in the file.
 *
 * `icon` is the awkward one: here it means a resolved pin id, and in Gaia's
 * export it is Gaia's own symbol name (or a URL to one). Anything that is not
 * one of this app's ids is treated as a symbol to be looked up by name, which
 * is how a GPX <sym> is handled - "fire-lookout" resolves the same way "Fire
 * Lookout" does.
 */
function adoptForeignProperties(props) {
  const text = (...candidates) => {
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  if (!props.name) props.name = text(props.title, props.Name, props.label) || 'Untitled feature';
  if (!props.description) {
    const found = text(props.notes, props.desc, props.Description, props.comment, props.cmt);
    if (found) props.description = found;
  }
  if (!props.color) {
    // Gaia writes marker_color; simplestyle writes marker-color. Both, then.
    const found = text(props.marker_color, props['marker-color'], props.colour, props.stroke);
    if (/^#?[0-9a-f]{3,8}$/i.test(found)) props.color = found.startsWith('#') ? found : `#${found}`;
  }
  if (!props.link) {
    // Gaia attaches its photos as a list of URLs to its own site. The first
    // one becomes the pin's link, which is what the photo importer follows.
    const photo = Array.isArray(props.photos) ? props.photos.find((entry) => entry?.fullsize_url || entry?.web_url) : null;
    const found = text(props.url, props.link_url, photo?.fullsize_url, photo?.web_url);
    if (found) props.link = found;
  }
  if (!Number.isFinite(props.time)) {
    const stamp = Date.parse(text(props.time_created, props.created, props.timestamp));
    if (Number.isFinite(stamp)) props.time = stamp;
  }
  if (!props.symbol) {
    const found = text(props.sym, props['marker-symbol']);
    if (found) props.symbol = found;
  }
  if (typeof props.icon === 'string' && props.icon && !KNOWN_PIN_IDS.has(props.icon)) {
    // A URL names its symbol in the last path segment: .../fire-lookout.png
    const bare = props.icon.split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ');
    if (!props.symbol) props.symbol = bare;
    delete props.icon;
  }
}

/** Normalize a plain GeoJSON file into the same document shape as GPX/KML. */
function fromGeoJSON(text) {
  const parsed = JSON.parse(text);
  const features = parsed.type === 'FeatureCollection' ? (parsed.features || [])
    : parsed.type === 'Feature' ? [parsed]
      : parsed.type ? [{ type: 'Feature', geometry: parsed, properties: {} }]
        : [];

  const bounds = emptyBounds();
  features.forEach((feature, index) => {
    if (!feature.properties) feature.properties = {};
    if (feature.id === undefined) feature.id = `geojson-${index}`;
    if (!feature.properties.kind) {
      const type = feature.geometry?.type || '';
      feature.properties.kind = type.includes('Point') ? 'waypoint'
        : type.includes('Polygon') ? 'area' : 'track';
    }
    adoptForeignProperties(feature.properties);
    // Gaia puts the elevation in a property and leaves the coordinate flat;
    // everything downstream reads the third coordinate.
    const point = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
    if (point && point.length === 2 && Number.isFinite(feature.properties.elevation)) {
      point.push(feature.properties.elevation);
    }
    eachPosition(feature.geometry, (pos) => extendBounds(bounds, pos));
  });

  return {
    format: 'geojson',
    name: parsed.name || '',
    description: parsed.description || '',
    time: null,
    geojson: { type: 'FeatureCollection', features },
    bbox: bounds,
  };
}

/**
 * Parse a map file.
 *
 * @param {string|ArrayBuffer} input  file text, or an ArrayBuffer for .kmz
 * @param {string} filename           used to pick a parser; content sniffing is the fallback
 * @returns {Promise<object>} { format, name, description, geojson, bbox, stats }
 */
export async function parseMapFile(input, filename = '') {
  const extension = extensionOf(filename);
  let document;

  if (extension === '.kmz' || input instanceof ArrayBuffer) {
    const buffer = input instanceof ArrayBuffer ? input : new TextEncoder().encode(input).buffer;
    document = parseKML(await extractKMLFromKMZ(buffer));
  } else {
    const text = String(input);
    if (extension === '.gpx') document = parseGPX(text);
    else if (extension === '.kml') document = parseKML(text);
    else if (extension === '.geojson' || extension === '.json') document = fromGeoJSON(text);
    else if (looksLikeGPX(text)) document = parseGPX(text);
    else if (looksLikeKML(text)) document = parseKML(text);
    else if (text.trim().startsWith('{')) document = fromGeoJSON(text);
    else throw new Error(`Unrecognised map file "${filename || 'upload'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }

  document.stats = summarize(document.geojson);
  if (!document.bbox || !document.bbox.every(Number.isFinite)) {
    document.bbox = geojsonBounds(document.geojson);
  }
  if (!document.name) document.name = filename.replace(/\.[^.]+$/, '') || 'Untitled map';
  return document;
}

export { cumulativeDistances, linePositions };
