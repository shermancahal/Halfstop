/**
 * GPX 1.0/1.1 -> GeoJSON.
 *
 * Beyond the base schema this understands the extension blocks that actually
 * show up in GaiaGPS and Garmin exports: track colours (gpx_style and
 * gpxx:DisplayColor) and per-point timestamps, which the elevation profile and
 * the trip stats both rely on.
 */

import {
  parseXML, childNamed, childrenNamed, childText, findDescendant, findDescendants, textOf, numberOf,
} from './xml.js';
import { emptyBounds, extendBounds, eachPosition } from './geo.js';

/** Garmin's named display colours, mapped to hex so the viewer can use them directly. */
const GARMIN_COLORS = {
  black: '#1b1b1b', darkred: '#8b1a1a', darkgreen: '#1f6f3d', darkyellow: '#9a7d0a',
  darkblue: '#1c3f94', darkmagenta: '#7b2a7b', darkcyan: '#146b74', lightgray: '#b8bcc2',
  darkgray: '#6a6f76', red: '#d9432f', green: '#2e9e50', yellow: '#e0a71b',
  blue: '#2f6fd0', magenta: '#b83fb8', cyan: '#22a6b3', white: '#ffffff', transparent: null,
};

function normalizeColor(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const named = GARMIN_COLORS[value.toLowerCase()];
  if (named !== undefined) return named;
  const hex = value.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(0, 6).toLowerCase()}`; // rrggbbaa
  if (/^[0-9a-fA-F]{3}$/.test(hex)) return `#${hex.split('').map((c) => c + c).join('').toLowerCase()}`;
  return null;
}

/** Colour hints live in several competing extension namespaces; take the first that parses. */
function colorFromExtensions(node) {
  const extensions = childNamed(node, 'extensions');
  if (!extensions) return null;
  for (const tag of ['displaycolor', 'color', 'linecolor']) {
    const found = findDescendant(extensions, tag);
    const color = normalizeColor(textOf(found));
    if (color) return color;
  }
  return null;
}

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pointFrom(node) {
  const lon = numberOf(node.attrs.lon);
  const lat = numberOf(node.attrs.lat);
  if (lat === null || lon === null) return null;
  const ele = numberOf(childText(node, 'ele'));
  return {
    position: ele === null ? [lon, lat] : [lon, lat, ele],
    time: parseTime(childText(node, 'time')),
  };
}

function linkOf(node) {
  const link = childNamed(node, 'link');
  if (link?.attrs?.href) return link.attrs.href;
  const url = childText(node, 'url');
  return url || null;
}

/*
 * What the file calls its link.
 *
 * GPX puts the wording in <link><text>, and the older <urlname> beside <url>.
 * Kept because it is the writer's own name for where the link goes - "NPS
 * page", "trip report" - and a reader is better served by that than by a
 * generic label the app invented.
 */
function linkTextOf(node) {
  const link = childNamed(node, 'link');
  const text = (link && childText(link, 'text')) || childText(node, 'urlname');
  return text || null;
}

function describe(node) {
  // GPX splits prose across desc/cmt; prefer desc but fall back so nothing is lost.
  return childText(node, 'desc') || childText(node, 'cmt') || '';
}

export function parseGPX(source) {
  const doc = parseXML(source);
  const gpx = childNamed(doc, 'gpx') || doc;
  const metadata = childNamed(gpx, 'metadata');

  const features = [];
  const bounds = emptyBounds();
  let seq = 0;

  const push = (geometry, properties) => {
    features.push({ type: 'Feature', id: `gpx-${seq++}`, geometry, properties });
    eachPosition(geometry, (pos) => extendBounds(bounds, pos));
  };

  for (const trk of childrenNamed(gpx, 'trk')) {
    const segments = [];
    const times = [];
    for (const seg of childrenNamed(trk, 'trkseg')) {
      const positions = [];
      const segTimes = [];
      for (const pt of childrenNamed(seg, 'trkpt')) {
        const point = pointFrom(pt);
        if (!point) continue;
        positions.push(point.position);
        segTimes.push(point.time);
      }
      if (positions.length >= 2) { segments.push(positions); times.push(segTimes); }
    }
    if (!segments.length) continue;

    const multi = segments.length > 1;
    push(
      multi
        ? { type: 'MultiLineString', coordinates: segments }
        : { type: 'LineString', coordinates: segments[0] },
      {
        kind: 'track',
        name: childText(trk, 'name') || 'Untitled track',
        description: describe(trk),
        type: childText(trk, 'type') || '',
        color: colorFromExtensions(trk),
        link: linkOf(trk),
        linkLabel: linkTextOf(trk),
        coordTimes: multi ? times : times[0],
      },
    );
  }

  for (const rte of childrenNamed(gpx, 'rte')) {
    const positions = [];
    for (const pt of childrenNamed(rte, 'rtept')) {
      const point = pointFrom(pt);
      if (point) positions.push(point.position);
    }
    if (positions.length < 2) continue;
    push({ type: 'LineString', coordinates: positions }, {
      kind: 'route',
      name: childText(rte, 'name') || 'Untitled route',
      description: describe(rte),
      type: childText(rte, 'type') || '',
      color: colorFromExtensions(rte),
      link: linkOf(rte),
      linkLabel: linkTextOf(rte),
      coordTimes: null,
    });
  }

  for (const wpt of childrenNamed(gpx, 'wpt')) {
    const point = pointFrom(wpt);
    if (!point) continue;
    push({ type: 'Point', coordinates: point.position }, {
      kind: 'waypoint',
      name: childText(wpt, 'name') || 'Untitled waypoint',
      description: describe(wpt),
      symbol: childText(wpt, 'sym') || '',
      type: childText(wpt, 'type') || '',
      color: colorFromExtensions(wpt),
      link: linkOf(wpt),
      linkLabel: linkTextOf(wpt),
      time: point.time,
    });
  }

  // Some exporters put nothing in <metadata>; fall back to the first track's name
  // so the file still gets a human label in the catalogue and the layer list.
  const firstNamed = features.find((f) => f.properties.kind !== 'waypoint');
  const name = childText(metadata, 'name')
    || textOf(findDescendant(gpx, 'name'))
    || firstNamed?.properties.name
    || '';

  return {
    format: 'gpx',
    name,
    description: childText(metadata, 'desc') || '',
    time: parseTime(childText(metadata, 'time')),
    geojson: { type: 'FeatureCollection', features },
    bbox: bounds,
  };
}

/** True when the text looks like GPX, used to sniff files with unhelpful extensions. */
export function looksLikeGPX(text) {
  return /<gpx[\s>]/i.test(text.slice(0, 4096)) || findDescendants(parseXML(text.slice(0, 4096)), 'gpx').length > 0;
}
