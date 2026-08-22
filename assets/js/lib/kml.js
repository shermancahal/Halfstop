/**
 * KML -> GeoJSON.
 *
 * Covers what GaiaGPS and Google Earth actually emit: Placemarks with Point,
 * LineString, Polygon, MultiGeometry and gx:Track geometry; Folder nesting;
 * shared <Style>/<StyleMap> lookups via styleUrl; and ExtendedData tables.
 */

import {
  parseXML, childNamed, childrenNamed, childText, findDescendant, findDescendants, textOf, numberOf,
} from './xml.js';
import { emptyBounds, extendBounds, eachPosition } from './geo.js';

/** KML colours are aabbggrr — the reverse of CSS, with alpha first. */
function kmlColor(raw) {
  const value = String(raw || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{8}$/.test(value) && !/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const padded = value.length === 6 ? `ff${value}` : value;
  const bb = padded.slice(2, 4);
  const gg = padded.slice(4, 6);
  const rr = padded.slice(6, 8);
  return `#${(rr + gg + bb).toLowerCase()}`;
}

function kmlOpacity(raw) {
  const value = String(raw || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{8}$/.test(value)) return null;
  return parseInt(value.slice(0, 2), 16) / 255;
}

/**
 * `<coordinates>` is whitespace-separated "lon,lat[,ele]" tuples. Real files use
 * every combination of newlines, tabs and stray spaces, hence the loose split.
 */
function parseCoordinates(text) {
  const positions = [];
  for (const chunk of String(text || '').trim().split(/\s+/)) {
    if (!chunk) continue;
    const parts = chunk.split(',');
    const lon = numberOf(parts[0]);
    const lat = numberOf(parts[1]);
    if (lon === null || lat === null) continue;
    const ele = numberOf(parts[2]);
    positions.push(ele === null ? [lon, lat] : [lon, lat, ele]);
  }
  return positions;
}

/** Collect every <Style> and <StyleMap> in the document, keyed by '#id'. */
function collectStyles(root) {
  const styles = new Map();

  for (const style of findDescendants(root, 'style')) {
    const id = style.attrs.id;
    if (!id) continue;
    const line = childNamed(style, 'linestyle');
    const poly = childNamed(style, 'polystyle');
    const icon = childNamed(style, 'iconstyle');
    styles.set(`#${id}`, {
      color: kmlColor(childText(line, 'color')) || kmlColor(childText(icon, 'color')),
      opacity: kmlOpacity(childText(line, 'color')),
      width: numberOf(childText(line, 'width')),
      fill: kmlColor(childText(poly, 'color')),
      fillOpacity: kmlOpacity(childText(poly, 'color')),
      icon: textOf(findDescendant(icon, 'href')) || null,
    });
  }

  // A StyleMap points at concrete styles per highlight state; the normal pair is
  // what renders by default, so resolve to it.
  for (const map of findDescendants(root, 'stylemap')) {
    const id = map.attrs.id;
    if (!id) continue;
    let target = null;
    for (const pair of childrenNamed(map, 'pair')) {
      const key = childText(pair, 'key');
      const url = childText(pair, 'styleurl');
      if (!url) continue;
      if (key === 'normal') { target = url; break; }
      if (!target) target = url;
    }
    const resolved = target ? styles.get(target.startsWith('#') ? target : `#${target}`) : null;
    if (resolved) styles.set(`#${id}`, resolved);
  }

  return styles;
}

function extendedData(placemark) {
  const node = childNamed(placemark, 'extendeddata');
  if (!node) return null;
  const out = {};
  for (const data of childrenNamed(node, 'data')) {
    const key = data.attrs.name;
    if (key) out[key] = childText(data, 'value');
  }
  for (const schema of childrenNamed(node, 'schemadata')) {
    for (const field of childrenNamed(schema, 'simpledata')) {
      if (field.attrs.name) out[field.attrs.name] = textOf(field);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** gx:Track interleaves <when> timestamps with <gx:coord> "lon lat ele" triples. */
function parseGxTrack(node) {
  const positions = [];
  const times = [];
  for (const coord of childrenNamed(node, 'coord')) {
    const parts = textOf(coord).split(/\s+/);
    const lon = numberOf(parts[0]);
    const lat = numberOf(parts[1]);
    if (lon === null || lat === null) continue;
    const ele = numberOf(parts[2]);
    positions.push(ele === null ? [lon, lat] : [lon, lat, ele]);
  }
  for (const when of childrenNamed(node, 'when')) {
    const ms = Date.parse(textOf(when));
    times.push(Number.isFinite(ms) ? ms : null);
  }
  return { positions, times: times.length === positions.length ? times : null };
}

function geometryOf(node) {
  switch (node.name) {
    case 'point': {
      const positions = parseCoordinates(childText(node, 'coordinates'));
      return positions.length ? { geometry: { type: 'Point', coordinates: positions[0] } } : null;
    }
    case 'linestring':
    case 'linearring': {
      const positions = parseCoordinates(childText(node, 'coordinates'));
      return positions.length >= 2 ? { geometry: { type: 'LineString', coordinates: positions } } : null;
    }
    case 'polygon': {
      const rings = [];
      const outer = findDescendant(childNamed(node, 'outerboundaryis'), 'linearring');
      const outerRing = parseCoordinates(childText(outer, 'coordinates'));
      if (outerRing.length < 3) return null;
      rings.push(closeRing(outerRing));
      for (const inner of childrenNamed(node, 'innerboundaryis')) {
        const ring = parseCoordinates(childText(findDescendant(inner, 'linearring'), 'coordinates'));
        if (ring.length >= 3) rings.push(closeRing(ring));
      }
      return { geometry: { type: 'Polygon', coordinates: rings } };
    }
    case 'track': {
      const { positions, times } = parseGxTrack(node);
      return positions.length >= 2
        ? { geometry: { type: 'LineString', coordinates: positions }, coordTimes: times }
        : null;
    }
    case 'multigeometry': {
      const parts = [];
      let coordTimes = null;
      for (const child of node.children) {
        const result = geometryOf(child);
        if (result) { parts.push(result.geometry); if (result.coordTimes) coordTimes = result.coordTimes; }
      }
      if (!parts.length) return null;
      if (parts.length === 1) return { geometry: parts[0], coordTimes };
      const allSame = parts.every((p) => p.type === parts[0].type);
      if (allSame && parts[0].type === 'LineString') {
        return { geometry: { type: 'MultiLineString', coordinates: parts.map((p) => p.coordinates) }, coordTimes };
      }
      if (allSame && parts[0].type === 'Point') {
        return { geometry: { type: 'MultiPoint', coordinates: parts.map((p) => p.coordinates) } };
      }
      if (allSame && parts[0].type === 'Polygon') {
        return { geometry: { type: 'MultiPolygon', coordinates: parts.map((p) => p.coordinates) } };
      }
      return { geometry: { type: 'GeometryCollection', geometries: parts }, coordTimes };
    }
    default:
      return null;
  }
}

function closeRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, first];
  return ring;
}

const KIND_BY_GEOMETRY = {
  Point: 'waypoint', MultiPoint: 'waypoint',
  LineString: 'track', MultiLineString: 'track',
  Polygon: 'area', MultiPolygon: 'area',
  GeometryCollection: 'track',
};

export function parseKML(source) {
  const doc = parseXML(source);
  const kml = childNamed(doc, 'kml') || doc;
  const styles = collectStyles(kml);

  const features = [];
  const bounds = emptyBounds();
  let seq = 0;

  // Walk containers ourselves rather than flattening, so each Placemark keeps the
  // Folder path it came from — GaiaGPS uses folders to group a trip's layers.
  const walk = (node, folders) => {
    for (const child of node.children) {
      if (child.name === 'placemark') {
        addPlacemark(child, folders);
      } else if (child.name === 'folder' || child.name === 'document') {
        const label = childText(child, 'name');
        walk(child, label ? [...folders, label] : folders);
      } else if (child.children.length) {
        walk(child, folders);
      }
    }
  };

  const addPlacemark = (placemark, folders) => {
    let result = null;
    for (const child of placemark.children) {
      result = geometryOf(child);
      if (result) break;
    }
    if (!result) return;

    const styleUrl = childText(placemark, 'styleurl');
    const inline = childNamed(placemark, 'style');
    const shared = styleUrl ? styles.get(styleUrl.startsWith('#') ? styleUrl : `#${styleUrl}`) : null;
    const inlineStyle = inline
      ? {
        color: kmlColor(childText(childNamed(inline, 'linestyle'), 'color')),
        width: numberOf(childText(childNamed(inline, 'linestyle'), 'width')),
        fill: kmlColor(childText(childNamed(inline, 'polystyle'), 'color')),
      }
      : null;
    const style = { ...(shared || {}), ...Object.fromEntries(Object.entries(inlineStyle || {}).filter(([, v]) => v != null)) };

    const timestamp = textOf(findDescendant(placemark, 'when'));
    const geometry = result.geometry;

    const feature = {
      type: 'Feature',
      id: `kml-${seq++}`,
      geometry,
      properties: {
        kind: KIND_BY_GEOMETRY[geometry.type] || 'track',
        name: childText(placemark, 'name') || 'Untitled feature',
        description: stripHTML(childText(placemark, 'description')),
        descriptionHTML: childText(placemark, 'description') || '',
        folder: folders.length ? folders.join(' / ') : '',
        color: style.color || null,
        fill: style.fill || null,
        width: style.width || null,
        icon: style.icon || null,
        symbol: '',
        link: null,
        time: timestamp ? Date.parse(timestamp) || null : null,
        coordTimes: result.coordTimes || null,
        data: extendedData(placemark),
      },
    };
    features.push(feature);
    eachPosition(geometry, (pos) => extendBounds(bounds, pos));
  };

  walk(kml, []);

  const documentNode = childNamed(kml, 'document') || kml;
  return {
    format: 'kml',
    name: childText(documentNode, 'name') || '',
    description: stripHTML(childText(documentNode, 'description')),
    time: null,
    geojson: { type: 'FeatureCollection', features },
    bbox: bounds,
  };
}

/** KML descriptions are frequently HTML blobs; keep a plain-text version for lists. */
function stripHTML(value) {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}

export function looksLikeKML(text) {
  return /<kml[\s>]/i.test(text.slice(0, 4096));
}
