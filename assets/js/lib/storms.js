/**
 * Severe weather warnings, and which way the storm is going.
 *
 * The radar overlay draws where rain *is*. The question that actually decides
 * whether you keep driving is where it will be in twenty minutes, and a single
 * radar image cannot answer that — you would need two frames and a correlation
 * between them.
 *
 * The National Weather Service already did that work. Every severe
 * thunderstorm and tornado warning carries a storm motion vector computed by
 * the forecast office from consecutive radar volume scans, published in the
 * alert's parameters. So instead of differencing radar images in a browser,
 * this reads the number the meteorologist already put there.
 *
 * The limit is worth stating plainly: only *warned* storms carry a motion
 * vector. Ordinary rain has none, and the honest answer for a green blob on
 * the radar with no warning behind it is that we do not know.
 *
 * api.weather.gov. Free, no key, US only, US government work.
 */

const ALERTS_ROOT = 'https://api.weather.gov/alerts/active';

/** Warnings worth drawing a track for. Watches cover whole counties for hours. */
const TRACKED = /tornado warning|severe thunderstorm warning|flash flood warning|special marine warning/i;

const SEVERITY_ORDER = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];

/**
 * Pull the storm motion out of an NWS alert.
 *
 * The field looks like:
 *
 *   2026-05-21T23:54:00-00:00...storm...245DEG...41KT...LAT...LON 3821 8654
 *
 * The bearing is stated the way meteorology always states a direction — the
 * one the storm is coming FROM, the same convention as wind. A reader who
 * wants an arrow wants the opposite, so both are returned under names that
 * cannot be confused, and the panel says "from the southwest, heading
 * northeast" rather than making anyone hold the convention in their head.
 *
 * @returns {{fromDegrees: number, headingDegrees: number, knots: number,
 *            mph: number, observed: Date|null}|null}
 */
export function parseStormMotion(text = '') {
  const bearing = /(\d{1,3})\s*DEG/i.exec(text);
  const speed = /(\d{1,3})\s*KT/i.exec(text);
  if (!bearing || !speed) return null;

  const fromDegrees = Number(bearing[1]) % 360;
  const knots = Number(speed[1]);
  const stamp = /^(\d{4}-\d{2}-\d{2}T[\d:]+[^.\s]*)/.exec(text);
  const observed = stamp ? new Date(stamp[1]) : null;

  return {
    fromDegrees,
    headingDegrees: (fromDegrees + 180) % 360,
    knots,
    mph: Math.round(knots * 1.15078),
    observed: observed && Number.isFinite(observed.valueOf()) ? observed : null,
  };
}

/** "northeast at 47 mph", or '' when there is no vector. */
export function describeMotion(motion) {
  if (!motion) return '';
  const points = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const heading = points[Math.round(motion.headingDegrees / 45) % 8];
  return `${heading} at ${motion.mph} mph`;
}

/** Where the storm reaches in `minutes`, following the published vector. */
export function projectedPositions(motion, minutes = [15, 30, 45, 60]) {
  if (!motion) return [];
  const kmPerMinute = motion.knots * 1.852 / 60;
  return minutes.map((after) => ({ after, km: kmPerMinute * after }));
}

async function fetchJSON(url) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/geo+json' } });
    if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, reason: error.message || 'the request failed' };
  }
}

/**
 * Active warnings covering a point, newest and most severe first.
 *
 * @returns {Promise<{ok: true, alerts: object[]}|{ok: false, reason: string}>}
 */
export async function activeAlerts([lon, lat]) {
  const url = `${ALERTS_ROOT}?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
  const result = await fetchJSON(url);

  if (!result.ok) {
    if (result.status === 404) {
      return { ok: false, reason: 'the National Weather Service only covers the United States' };
    }
    return { ok: false, reason: result.reason };
  }

  const alerts = (result.data?.features || []).map((feature) => {
    const properties = feature.properties || {};
    // Alert parameters are arrays, always — a single value is an array of one.
    const parameter = (name) => (properties.parameters?.[name] || [])[0] || '';
    const motion = parseStormMotion(parameter('eventMotionDescription'));

    return {
      id: properties.id || '',
      event: properties.event || 'Alert',
      severity: properties.severity || 'Unknown',
      urgency: properties.urgency || '',
      headline: properties.headline || '',
      description: properties.description || '',
      instruction: properties.instruction || '',
      sent: properties.sent || '',
      expires: properties.expires || '',
      areaDescription: properties.areaDesc || '',
      tracked: TRACKED.test(properties.event || ''),
      motion,
      geometry: feature.geometry || null,
    };
  });

  alerts.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity || String(b.sent).localeCompare(String(a.sent));
  });

  return { ok: true, alerts };
}

/**
 * Warning shapes and motion arrows as GeoJSON, ready for a map source.
 *
 * The arrow starts at the warned area's centre rather than the LAT/LON in the
 * motion text: that coordinate is where the radar found the storm core at the
 * scan time, which can be minutes stale and several miles behind the polygon
 * the office actually drew.
 *
 * @param destination (position, bearing, km) => position — passed in so this
 *        stays free of a geometry dependency and testable on its own.
 */
export function alertsToGeoJSON(alerts, destination, { minutes = 30 } = {}) {
  const features = [];

  for (const alert of alerts) {
    if (alert.geometry) {
      features.push({
        type: 'Feature',
        properties: { kind: 'area', event: alert.event, severity: alert.severity, tracked: alert.tracked },
        geometry: alert.geometry,
      });
    }

    if (!alert.motion || !alert.geometry) continue;
    const centre = centroid(alert.geometry);
    if (!centre) continue;

    const km = alert.motion.knots * 1.852 / 60 * minutes;
    const tip = destination(centre, alert.motion.headingDegrees, km);

    features.push({
      type: 'Feature',
      properties: {
        kind: 'motion',
        event: alert.event,
        label: `${describeMotion(alert.motion)} · ${minutes} min`,
        bearing: alert.motion.headingDegrees,
      },
      geometry: { type: 'LineString', coordinates: [centre, tip] },
    });

    // A separate point at the tip carries the arrowhead, which a line cannot:
    // GL rotates a symbol to a bearing but will not put one only at the end.
    features.push({
      type: 'Feature',
      properties: { kind: 'head', event: alert.event, bearing: alert.motion.headingDegrees },
      geometry: { type: 'Point', coordinates: tip },
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Average of a polygon's outer ring — good enough to hang an arrow from.
 *
 * A GeoJSON ring closes by repeating its first coordinate, and averaging that
 * vertex twice pulls the result toward whichever corner the ring happens to
 * start at. On a warning polygon that is a couple of miles of error in the
 * arrow's origin, so the closing vertex is dropped.
 */
export function centroid(geometry) {
  const rings = geometry?.type === 'Polygon' ? [geometry.coordinates[0]]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates.map((polygon) => polygon[0])
      : [];

  let lon = 0;
  let lat = 0;
  let count = 0;
  for (const ring of rings) {
    const points = ring || [];
    const first = points[0];
    const last = points[points.length - 1];
    const closed = points.length > 2 && first && last
      && first[0] === last[0] && first[1] === last[1];

    for (const [x, y] of closed ? points.slice(0, -1) : points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      lon += x;
      lat += y;
      count += 1;
    }
  }
  return count ? [lon / count, lat / count] : null;
}
