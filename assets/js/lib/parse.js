/**
 * One entry point for every map file the site accepts, plus the statistics the
 * viewer and the catalogue both display.
 */

import { iconForSymbol } from './pin-icons.js';
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
    // GPX <sym> and KML IconStyle are the only styling most files carry for
    // points; translate them once here so every consumer sees a resolved icon.
    if (!feature.properties.icon && feature.properties.kind === 'waypoint') {
      const resolved = iconForSymbol(feature.properties.symbol)
        || iconForSymbol(feature.properties.iconHref)
        || iconForSymbol(feature.properties.type);
      if (resolved) feature.properties.icon = resolved;
    }
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
    if (!feature.properties.name) {
      feature.properties.name = feature.properties.title || feature.properties.Name || 'Untitled feature';
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
