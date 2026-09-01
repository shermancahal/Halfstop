/**
 * Reading a road route out of Valhalla, and saying what it does not cover.
 *
 * The trip planner next door is deliberately not a router: great-circle miles
 * bent by a winding factor, no network needed, right about the shape of a trip
 * and wrong about any single leg. That stays, because trips get re-planned at a
 * trailhead with no signal. This is the other half - when there IS a signal,
 * ask a real router and draw what it says.
 *
 * Everything here is pure. It takes a response and gives back geometry and
 * numbers; the fetching, the drawing and the caching are the caller's.
 *
 * What the service actually returns was measured rather than remembered, and
 * two of the measurements changed the design:
 *
 *   - The shape is an encoded polyline at precision SIX, not the precision
 *     five that Google's format and most tutorials use. Decoded at five, the
 *     first point of a Virginia route is 367 degrees north. There is no error:
 *     you get coordinates, they are ten times too big, and the line is drawn
 *     somewhere off the planet.
 *   - There is no snap distance in the response. `trip.locations[]` carries
 *     type, lat, lon, side_of_street and original_index - and the lat/lon are
 *     the ones that were SENT, echoed back unchanged. So how far a stop is from
 *     the road it routed to has to be measured here, against the shape.
 */

import { haversine } from './geo.js';

const METRES_PER_MILE = 1609.344;

/**
 * Valhalla's encoded polyline.
 *
 * The same algorithm as Google's, at a different scale. `precision` is the
 * number of decimal places the integers represent: six for Valhalla, five for
 * the format most examples show. Wrong by one and every coordinate is out by a
 * factor of ten, which draws a line rather than failing.
 *
 * @returns {number[][]} positions in GeoJSON order, [lon, lat]
 */
export function decodePolyline(encoded, precision = 6) {
  const text = String(encoded || '');
  const factor = 10 ** precision;
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < text.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= text.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= text.length);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/**
 * How far each stop is from the road the router actually reached.
 *
 * A stop is the end of one leg and the start of the next, so the point the
 * driving reaches is a shape endpoint. The gap between that and where the pin
 * was dropped is the bit you walk - and for a pin by a waterfall it is the
 * whole reason the stop is not on the drive.
 *
 * Measured rather than asked for, because the response does not say. A pin well
 * off the network does not fail: Valhalla snaps it to the nearest road it can
 * reach and routes there, reporting "Found route between points" as if nothing
 * had happened. Silence is the failure mode this exists to break.
 */
export function offRoadMetres(stops, legs) {
  return stops.map((stop, index) => {
    const reached = index === 0
      ? legs[0]?.coordinates?.[0]
      : legs[index - 1]?.coordinates?.[legs[index - 1].coordinates.length - 1];
    if (!reached || !stop?.position) return null;
    return haversine(stop.position, reached);
  });
}

/**
 * The distance past which a stop is somewhere you walk to.
 *
 * Stated as a setting rather than buried as a constant, like every other
 * assumption the planner makes, because it is a judgement and not a
 * measurement. A quarter of a mile is about five minutes on foot: below that
 * you have parked, above it you have gone somewhere.
 *
 * It is deliberately NOT calibrated from snap distances. The first attempt was
 * going to be, and the probe that would have set it snapped a point picked as
 * "on US 58" by 472 metres - so a threshold chosen to sit under real snapping
 * would have called an ordinary lay-by a hike. The question this answers is
 * "is this a walk worth telling someone about", which is about the walk.
 */
export const WALK_IN_METRES = 0.25 * METRES_PER_MILE;

/** A comfortable walking pace over rough ground, in miles per hour. */
export const WALK_MPH = 2.5;

/**
 * Turn one Valhalla response into legs, totals and what the driving misses.
 *
 * @param {object} json     the parsed response
 * @param {Array}  stops    the stops that were asked for, in order
 * @param {object} options  `walkInMetres` to move the walk-in threshold
 */
export function readRoute(json, stops = [], { walkInMetres = WALK_IN_METRES } = {}) {
  const trip = json?.trip;
  if (!trip || !Array.isArray(trip.legs) || !trip.legs.length) {
    return {
      ok: false,
      // Valhalla puts a sentence in the body for a refusal as well as for a
      // success, and it is a better thing to show than "routing failed".
      message: json?.error || trip?.status_message || 'No route came back.',
      legs: [],
      totals: { miles: 0, minutes: 0 },
      stops: stops.map(() => ({ offRoadMetres: null, walkIn: false })),
    };
  }

  const legs = trip.legs.map((leg, index) => ({
    from: index,
    to: index + 1,
    miles: Number(leg?.summary?.length) || 0,
    minutes: (Number(leg?.summary?.time) || 0) / 60,
    coordinates: decodePolyline(leg?.shape),
    hasToll: Boolean(leg?.summary?.has_toll),
    hasFerry: Boolean(leg?.summary?.has_ferry),
    hasHighway: Boolean(leg?.summary?.has_highway),
  }));

  const gaps = offRoadMetres(stops, legs);

  return {
    ok: true,
    message: trip.status_message || '',
    legs,
    totals: {
      miles: Number(trip?.summary?.length) || legs.reduce((sum, leg) => sum + leg.miles, 0),
      minutes: (Number(trip?.summary?.time) || 0) / 60,
    },
    stops: gaps.map((metres) => {
      const walkIn = Number.isFinite(metres) && metres > walkInMetres;
      return {
        offRoadMetres: metres,
        walkIn,
        /*
         * The walk is reported and deliberately not added to the drive.
         *
         * It is not driving time, and rolling it into the total would say the
         * car goes somewhere it does not. Kept as its own number so the plan
         * can show it without pretending it is part of the leg.
         */
        walkMinutes: walkIn ? (metres / METRES_PER_MILE / WALK_MPH) * 60 : 0,
      };
    }),
  };
}

/** Every leg's geometry as one GeoJSON feature collection, for drawing. */
export function routeGeoJSON(route) {
  return {
    type: 'FeatureCollection',
    features: (route?.legs || [])
      .filter((leg) => leg.coordinates.length > 1)
      .map((leg) => ({
        type: 'Feature',
        properties: { from: leg.from, to: leg.to, miles: leg.miles, minutes: leg.minutes },
        geometry: { type: 'LineString', coordinates: leg.coordinates },
      })),
  };
}
