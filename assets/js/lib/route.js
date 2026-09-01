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
import { ROUTING } from '../config.js';

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

/**
 * The route as drawable geometry: the drive, and the bits you walk.
 *
 * The walk stubs are the point of passing `stops` in. A pin by a waterfall gets
 * routed to the nearest road Valhalla can reach, and the gap between that road
 * and the pin is invisible in the response - so if it is not drawn, the map
 * shows a line stopping at a road with the pin floating beside it and no
 * explanation. Drawn dashed and marked `walk`, it says what it is.
 *
 * Never in the same solid stroke as the drive, because that would assert the
 * car goes there.
 */
export function routeGeoJSON(route, stops = []) {
  const features = (route?.legs || [])
    .filter((leg) => leg.coordinates?.length > 1)
    .map((leg) => ({
      type: 'Feature',
      properties: {
        from: leg.from, to: leg.to, miles: leg.miles, minutes: leg.minutes, walk: false,
      },
      geometry: { type: 'LineString', coordinates: leg.coordinates },
    }));

  (route?.stops || []).forEach((stop, index) => {
    if (!stop?.walkIn) return;
    const from = stops[index]?.position;
    const legs = route.legs || [];
    const reached = index === 0
      ? legs[0]?.coordinates?.[0]
      : legs[index - 1]?.coordinates?.[legs[index - 1].coordinates.length - 1];
    if (!from || !reached) return;
    features.push({
      type: 'Feature',
      properties: { stop: index, walk: true, metres: stop.offRoadMetres, minutes: stop.walkMinutes },
      geometry: { type: 'LineString', coordinates: [reached, from] },
    });
  });

  return { type: 'FeatureCollection', features };
}


/* ------------------------------------------------------------------ asking */

/**
 * The request body, which is the whole of what Valhalla needs.
 *
 * One request for the whole trip rather than one per leg. That is not a
 * micro-optimisation: the published limit is one request per second, so an
 * eight-stop trip asked leg by leg would take eight seconds and spend the
 * budget of eight other people's routes. Valhalla returns a leg per pair from
 * a single call, which is exactly what the planner wants anyway.
 */
export function routeBody(stops, { costing = 'auto', units = 'miles', costingOptions = null } = {}) {
  return {
    locations: stops.map((stop) => ({
      lat: stop.position[1],
      lon: stop.position[0],
      // Every stop is somewhere you get out, so none of them is a via point.
      type: 'break',
    })),
    costing,
    /*
     * Omitted rather than sent empty when there are none.
     *
     * A car route has to be byte-for-byte the request it was before vehicle
     * profiles existed: an empty costing_options is a different request, and a
     * different request is a different cache entry at the far end for no gain.
     */
    ...(costingOptions ? { costing_options: costingOptions } : {}),
    directions_options: { units },
  };
}

/*
 * One request at a time, and never faster than the limit.
 *
 * A promise chain rather than a timer: each call waits for the one before it
 * and then for whatever is left of the interval, so a person dragging a stop
 * around cannot outrun the queue no matter how fast they drag. Module-level
 * because the limit belongs to the service, not to any one map or panel.
 */
let queue = Promise.resolve();
let lastAt = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `job` when the service is next willing to hear from us. */
export function throttled(job, { minIntervalMs = ROUTING.minIntervalMs } = {}) {
  const run = queue.then(async () => {
    const since = Date.now() - lastAt;
    if (since < minIntervalMs) await wait(minIntervalMs - since);
    lastAt = Date.now();
    return job();
  });
  // The queue must not stop at the first failure, so it carries on from a
  // settled promise while the caller still sees the rejection.
  queue = run.then(() => {}, () => {});
  return run;
}

/**
 * Ask for a route and read the answer.
 *
 * A plain GET with the request in the query string, because that is a
 * CORS-simple request: no custom headers, so no preflight. Valhalla's docs
 * suggest published apps send an X-Client-Id, but that is not a simple header
 * and would make every request depend on the service answering an OPTIONS it
 * may not - a failure that is total and looks exactly like the router being
 * down. The identification the FOSSGIS terms actually require is the browser's
 * own User-Agent and Referer, which a browser sends and a page cannot forge.
 */
export async function fetchRoute(stops, {
  url = ROUTING.url,
  costing = 'auto',
  costingOptions = null,
  units = 'miles',
  walkInMetres = WALK_IN_METRES,
  signal,
  fetcher = fetch,
} = {}) {
  if (!Array.isArray(stops) || stops.length < 2) {
    return {
      ok: false,
      message: 'A route needs at least two stops.',
      legs: [],
      totals: { miles: 0, minutes: 0 },
      stops: (stops || []).map(() => ({ offRoadMetres: null, walkIn: false, walkMinutes: 0 })),
    };
  }

  const body = routeBody(stops, { costing, units, costingOptions });
  const target = `${url}?json=${encodeURIComponent(JSON.stringify(body))}`;

  const response = await throttled(() => fetcher(target, { signal }));
  /*
   * Valhalla answers a refusal with a JSON body and a 400, so the body is read
   * either way - "No path could be found for input" is a far better thing to
   * put on screen than the status code that carried it.
   */
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!json) {
    return {
      ok: false,
      message: `The routing service answered ${response.status} with nothing readable.`,
      legs: [],
      totals: { miles: 0, minutes: 0 },
      stops: stops.map(() => ({ offRoadMetres: null, walkIn: false, walkMinutes: 0 })),
    };
  }
  return readRoute(json, stops, { walkInMetres });
}
