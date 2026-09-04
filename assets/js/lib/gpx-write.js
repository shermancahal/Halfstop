/**
 * GeoJSON -> GPX 1.1.
 *
 * The counterpart to lib/gpx.js, so anything organised in the browser can leave
 * again in the format the rest of the GPS world reads — GaiaGPS, Garmin,
 * CalTopo. Round-tripping through lib/gpx.js is covered by the test suite.
 */

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** Drop control characters XML 1.0 cannot represent, whatever the source. */
function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function tag(name, value, indent) {
  const text = clean(value);
  return text ? `${indent}<${name}>${xml(text)}</${name}>\n` : '';
}

function coord(position) {
  return `lat="${Number(position[1]).toFixed(7)}" lon="${Number(position[0]).toFixed(7)}"`;
}

function elevation(position, indent) {
  return Number.isFinite(position?.[2]) ? `${indent}<ele>${position[2].toFixed(2)}</ele>\n` : '';
}

function timeAt(times, index, indent) {
  const value = Array.isArray(times) ? times[index] : null;
  if (!Number.isFinite(value)) return '';
  return `${indent}<time>${new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>\n`;
}

function lineSegments(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') return (geometry.geometries || []).flatMap(lineSegments);
  return [];
}

function pointPositions(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'MultiPoint') return geometry.coordinates;
  return [];
}

function writeWaypoint(feature, position) {
  const props = feature.properties || {};
  let out = `  <wpt ${coord(position)}>\n`;
  out += elevation(position, '    ');
  out += timeAt([props.time], 0, '    ');
  out += tag('name', props.name, '    ');
  out += tag('desc', props.description, '    ');
  out += tag('sym', props.symbol, '    ');
  out += tag('type', props.type, '    ');
  // <link> carries its wording in a child element, not an attribute, so a
  // reader on the other side sees "NPS page" rather than a bare URL.
  if (props.link) {
    out += props.linkLabel
      ? `    <link href="${xml(props.link)}"><text>${xml(props.linkLabel)}</text></link>\n`
      : `    <link href="${xml(props.link)}"/>\n`;
  }
  out += '  </wpt>\n';
  return out;
}

function writeTrack(feature) {
  const props = feature.properties || {};
  const segments = lineSegments(feature.geometry);
  if (!segments.length) return '';

  // coordTimes is per-segment for multi-segment tracks and flat for single ones.
  const times = props.coordTimes;
  const perSegment = Array.isArray(times) && Array.isArray(times[0]);

  let out = '  <trk>\n';
  out += tag('name', props.name, '    ');
  out += tag('desc', props.description, '    ');
  out += tag('type', props.type, '    ');
  segments.forEach((positions, segmentIndex) => {
    const segmentTimes = perSegment ? times[segmentIndex] : (segments.length === 1 ? times : null);
    out += '    <trkseg>\n';
    positions.forEach((position, i) => {
      const inner = elevation(position, '        ') + timeAt(segmentTimes, i, '        ');
      out += inner
        ? `      <trkpt ${coord(position)}>\n${inner}      </trkpt>\n`
        : `      <trkpt ${coord(position)}/>\n`;
    });
    out += '    </trkseg>\n';
  });
  out += '  </trk>\n';
  return out;
}

/**
 * Serialize a FeatureCollection as a GPX 1.1 document.
 *
 * @param {object} geojson  FeatureCollection
 * @param {object} [meta]   { name, description, time }
 * @returns {string} GPX document text
 */
export function toGPX(geojson, meta = {}) {
  const features = geojson?.type === 'FeatureCollection' ? (geojson.features || [])
    : geojson?.type === 'Feature' ? [geojson] : [];

  let body = '';
  // GPX requires wpt before rte before trk, so emit in that order regardless of
  // how the collection happens to be arranged.
  for (const feature of features) {
    for (const position of pointPositions(feature.geometry)) body += writeWaypoint(feature, position);
  }
  for (const feature of features) {
    if (pointPositions(feature.geometry).length) continue;
    body += writeTrack(feature);
  }

  const stamp = Number.isFinite(meta.time) ? new Date(meta.time) : new Date();
  let header = '<?xml version="1.0" encoding="UTF-8"?>\n';
  header += '<gpx version="1.1" creator="Halfstop"\n';
  header += '     xmlns="http://www.topografix.com/GPX/1/1"\n';
  header += '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n';
  header += '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
  header += '  <metadata>\n';
  header += tag('name', meta.name, '    ');
  header += tag('desc', meta.description, '    ');
  header += `    <time>${stamp.toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>\n`;
  header += '  </metadata>\n';

  return `${header}${body}</gpx>\n`;
}
