/**
 * Geometry helpers shared by the viewer and the catalog builder.
 * Positions are GeoJSON order throughout: [lon, lat] or [lon, lat, elevation_m].
 */

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export const M_TO_MI = 0.000621371192;
export const M_TO_KM = 0.001;
export const M_TO_FT = 3.280839895;

export function haversine(a, b) {
  const lat1 = a[1] * RAD;
  const lat2 = b[1] * RAD;
  const dLat = lat2 - lat1;
  const dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Ground distance along a position array, in metres. */
export function lineLength(positions) {
  let total = 0;
  for (let i = 1; i < positions.length; i++) total += haversine(positions[i - 1], positions[i]);
  return total;
}

/** Cumulative distance at each vertex, in metres. Same length as `positions`. */
export function cumulativeDistances(positions) {
  const out = new Array(positions.length);
  let total = 0;
  for (let i = 0; i < positions.length; i++) {
    if (i > 0) total += haversine(positions[i - 1], positions[i]);
    out[i] = total;
  }
  return out;
}

/**
 * Elevation gain/loss in metres.
 *
 * GPS elevation is noisy — summing every positive delta inflates gain badly
 * (a flat road can "climb" hundreds of feet). We only bank a run once it has
 * moved past `threshold` metres in one direction, which is the standard
 * hysteresis approach and lands close to what GaiaGPS reports.
 */
export function elevationChange(positions, threshold = 3) {
  let ascent = 0;
  let descent = 0;
  let anchor = null;
  let last = null;

  for (const pos of positions) {
    const ele = pos.length > 2 ? pos[2] : null;
    if (ele === null || ele === undefined || !Number.isFinite(ele)) continue;
    if (anchor === null) { anchor = ele; last = ele; continue; }
    last = ele;
    const delta = ele - anchor;
    if (delta >= threshold) { ascent += delta; anchor = ele; }
    else if (delta <= -threshold) { descent -= delta; anchor = ele; }
  }
  if (anchor !== null && last !== null) {
    const tail = last - anchor;
    if (tail > 0) ascent += tail; else descent -= tail;
  }
  return { ascent, descent };
}

export function elevationRange(positions) {
  let min = Infinity;
  let max = -Infinity;
  for (const pos of positions) {
    const ele = pos.length > 2 ? pos[2] : null;
    if (!Number.isFinite(ele)) continue;
    if (ele < min) min = ele;
    if (ele > max) max = ele;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/* ---------- bounds ---------- */

export function emptyBounds() {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function extendBounds(bounds, position) {
  if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) return bounds;
  if (position[0] < bounds[0]) bounds[0] = position[0];
  if (position[1] < bounds[1]) bounds[1] = position[1];
  if (position[0] > bounds[2]) bounds[2] = position[0];
  if (position[1] > bounds[3]) bounds[3] = position[1];
  return bounds;
}

export function boundsAreValid(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) &&
    bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
}

export function mergeBounds(a, b) {
  if (!boundsAreValid(a)) return boundsAreValid(b) ? [...b] : emptyBounds();
  if (!boundsAreValid(b)) return [...a];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Walk any GeoJSON geometry's positions. */
export function eachPosition(geometry, fn) {
  if (!geometry) return;
  const walk = (coords, depth) => {
    if (depth === 0) { fn(coords); return; }
    if (!Array.isArray(coords)) return;
    for (const item of coords) walk(item, depth - 1);
  };
  const depthByType = {
    Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3,
  };
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries || []) eachPosition(g, fn);
    return;
  }
  const depth = depthByType[geometry.type];
  if (depth === undefined) return;
  walk(geometry.coordinates, depth);
}

export function geojsonBounds(geojson) {
  const bounds = emptyBounds();
  const features = geojson?.type === 'FeatureCollection' ? geojson.features
    : geojson?.type === 'Feature' ? [geojson] : [];
  for (const feature of features) eachPosition(feature.geometry, (pos) => extendBounds(bounds, pos));
  return bounds;
}

/** Pad bounds by a fraction of their span so fitted views do not clip the line. */
export function padBounds(bounds, fraction = 0.08, minDegrees = 0.0015) {
  if (!boundsAreValid(bounds)) return bounds;
  const padX = Math.max((bounds[2] - bounds[0]) * fraction, minDegrees);
  const padY = Math.max((bounds[3] - bounds[1]) * fraction, minDegrees);
  return [bounds[0] - padX, bounds[1] - padY, bounds[2] + padX, bounds[3] + padY];
}

/* ---------- simplification ---------- */

/**
 * Ramer-Douglas-Peucker in projected-ish space. `tolerance` is in degrees, and
 * longitude is scaled by cos(lat) so the tolerance behaves the same north-south
 * and east-west. Used to keep elevation profiles and huge imported tracks light.
 */
export function simplify(positions, tolerance = 0.00002) {
  if (positions.length <= 2) return positions.slice();
  const midLat = positions[Math.floor(positions.length / 2)][1] * RAD;
  const kx = Math.max(Math.cos(midLat), 0.01);
  const sqTolerance = tolerance * tolerance;

  const sqSegmentDistance = (p, a, b) => {
    let x = a[0] * kx;
    let y = a[1];
    let dx = b[0] * kx - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] * kx - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0] * kx; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] * kx - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
  };

  const keep = new Uint8Array(positions.length);
  keep[0] = 1;
  keep[positions.length - 1] = 1;
  const stack = [[0, positions.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = sqTolerance;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegmentDistance(positions[i], positions[first], positions[last]);
      if (sq > maxSq) { maxSq = sq; index = i; }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return positions.filter((_, i) => keep[i]);
}

/* ---------- formatting ---------- */

export function formatDistance(metres, units = 'imperial') {
  if (!Number.isFinite(metres)) return '—';
  if (units === 'metric') {
    return metres < 1000 ? `${Math.round(metres)} m` : `${(metres * M_TO_KM).toFixed(metres < 100000 ? 1 : 0)} km`;
  }
  const miles = metres * M_TO_MI;
  if (miles < 0.1) return `${Math.round(metres * M_TO_FT)} ft`;
  return `${miles.toFixed(miles < 100 ? 1 : 0)} mi`;
}

export function formatElevation(metres, units = 'imperial') {
  if (!Number.isFinite(metres)) return '—';
  return units === 'metric'
    ? `${Math.round(metres).toLocaleString()} m`
    : `${Math.round(metres * M_TO_FT).toLocaleString()} ft`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
