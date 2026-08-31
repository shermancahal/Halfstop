/**
 * What is near the drive, rather than near the screen.
 *
 * Every queried overlay in this app asks "what is in the current view", which
 * is the right question when you are looking at a place and the wrong one when
 * you are planning a route across four counties. The view is a rectangle; a
 * drive is a thin line through one, and most of what a viewport query returns
 * for a trip is nowhere near the road you will actually be on.
 *
 * So: distance from a point to the route, and a band either side of it. That
 * is the useful half of what a discovery app does - "what is within ten miles
 * of my way" - without needing anybody's curated database, because the
 * candidates come from the services this map already reads.
 *
 * On the geometry. Distances are measured to the straight legs between stops,
 * and the trip planner is explicit that those legs are not the road. A place
 * ten miles from the straight line might be twenty from the pavement, or two.
 * That is a real limitation and it is why the band is generous and adjustable
 * rather than precise: the question being answered is "is this roughly on my
 * way", which survives the approximation, and not "how far is the detour",
 * which does not.
 */

import { haversine, M_TO_MI } from './geo.js';

/* Metres per degree, near enough at the latitudes this map covers. Longitude
   shrinks with latitude, which is the only part that matters for a corridor
   running east-west. */
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;

/**
 * The closest point on one leg to a given point, and how far along it that is.
 *
 * Projected flat around the leg's own midpoint before the algebra, because
 * point-to-segment distance in raw degrees treats a degree of longitude as a
 * degree of latitude and is wrong by a third at these latitudes. The answer is
 * unprojected and measured with haversine, so the number handed back is a real
 * distance rather than a planar one.
 */
export function closestOnLeg(point, from, to) {
  const midLat = (from[1] + to[1]) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180) * M_PER_DEG_LON;
  const ky = M_PER_DEG_LAT;
  const at = (position) => [position[0] * kx, position[1] * ky];

  const [ax, ay] = at(from);
  const [bx, by] = at(to);
  const [px, py] = at(point);
  const dx = bx - ax;
  const dy = by - ay;

  // A leg with no length is a stop, not a segment: the nearest point is it.
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / span));

  const nearest = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  return { at: nearest, t, metres: haversine(point, nearest) };
}

/**
 * How far a point is from the whole route, and where along it that happens.
 *
 * `along` is metres travelled from the first stop to the nearest point, which
 * is what puts a list of finds in driving order rather than in order of
 * distance - the order you would actually meet them.
 */
export function distanceToRoute(point, stops) {
  if (!Array.isArray(stops) || stops.length === 0) return null;
  if (stops.length === 1) {
    return { metres: haversine(point, stops[0]), legIndex: 0, along: 0, t: 0 };
  }

  let best = null;
  let travelled = 0;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = stops[i];
    const to = stops[i + 1];
    const legLength = haversine(from, to);
    const hit = closestOnLeg(point, from, to);
    if (!best || hit.metres < best.metres) {
      best = { metres: hit.metres, legIndex: i, along: travelled + legLength * hit.t, t: hit.t };
    }
    travelled += legLength;
  }
  return best;
}

/**
 * A box around the route, wide enough to hold the whole corridor.
 *
 * This is what a service gets asked for. Querying the trip's own bounding box
 * would pull in everything in the rectangle the trip spans - for a route that
 * runs diagonally, most of that is hundreds of miles off the road - and these
 * services cap what they return, so the waste is not free: it is spent instead
 * of on places that are actually near the way.
 *
 * Still a rectangle, because that is what the services take. The corridor
 * filter afterwards is what makes the answer a corridor.
 */
export function routeBounds(stops, milesWithin = 10) {
  if (!Array.isArray(stops) || !stops.length) return null;
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  for (const [lon, lat] of stops) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  const metres = milesWithin / M_TO_MI;
  const padLat = metres / M_PER_DEG_LAT;
  // At the widest latitude the box reaches, so the pad is enough at both ends.
  const widest = Math.max(Math.abs(south), Math.abs(north));
  const padLon = metres / (Math.cos((widest * Math.PI) / 180) * M_PER_DEG_LON);
  return [west - padLon, south - padLat, east + padLon, north + padLat];
}

/**
 * Which candidates are near the route, in the order you would meet them.
 *
 * `position` says where a candidate is, so this works on whatever shape the
 * caller already has - a GeoJSON feature, a saved waypoint, a search result -
 * rather than forcing everything through one.
 */
export function alongRoute(candidates, stops, {
  milesWithin = 10,
  position = (one) => one?.geometry?.coordinates,
} = {}) {
  if (!Array.isArray(stops) || stops.length < 1) return [];
  const found = [];
  for (const candidate of candidates || []) {
    const at = position(candidate);
    if (!Array.isArray(at) || at.length < 2) continue;
    const hit = distanceToRoute(at, stops);
    if (!hit) continue;
    const miles = hit.metres * M_TO_MI;
    if (miles > milesWithin) continue;
    found.push({ ...hit, miles, along: hit.along, candidate });
  }
  // Driving order, and distance from the road as the tiebreak so two finds at
  // the same point on the route put the nearer one first.
  found.sort((a, b) => a.along - b.along || a.miles - b.miles);
  return found;
}
