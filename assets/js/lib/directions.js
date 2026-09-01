/**
 * Handing a destination to whichever navigation app somebody already trusts.
 *
 * This app does not navigate and is not trying to. Turn-by-turn is Apple's and
 * Google's ground, fought with their traffic data and their voice guidance, and
 * the interesting question here was never "how do I get there". So the drive is
 * planned and drawn here and then handed over, which is what GaiaGPS does too.
 *
 * The three do not agree about what a link may carry, and the differences are
 * not cosmetic:
 *
 *   - Google takes a whole trip - origin, destination and intermediate
 *     waypoints - as a route to look at and then start.
 *   - Apple Maps takes one destination. Its URL scheme has no multi-stop form.
 *   - Waze takes one destination, and answers a link carrying several with an
 *     error rather than ignoring the extras.
 *
 * So a stop can go to any of the three, and only Google is offered the trip.
 * Everything here builds a string; opening it is the caller's business.
 */

/*
 * Every one of these wants lat,lon and this codebase stores lon,lat.
 *
 * GeoJSON order is [lon, lat] and every navigation URL on earth is the other
 * way round, so this is the one conversion in the file and it happens once.
 * Getting it backwards sends somebody to the Indian Ocean and nothing reports
 * an error - the link opens, the app accepts it, the pin is simply wrong.
 */
const latLon = (position) => `${Number(position[1]).toFixed(6)},${Number(position[0]).toFixed(6)}`;

/** One destination, in Apple Maps. `dirflg=d` asks for driving. */
export function appleMapsURL(position) {
  return `https://maps.apple.com/?daddr=${encodeURIComponent(latLon(position))}&dirflg=d`;
}

/** One destination, in Google Maps. */
export function googleMapsURL(position) {
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving'
    + `&destination=${encodeURIComponent(latLon(position))}`;
}

/** One destination, in Waze. */
export function wazeURL(position) {
  return `https://waze.com/ul?ll=${encodeURIComponent(latLon(position))}&navigate=yes`;
}

/**
 * How many intermediate stops a Google Maps URL may carry.
 *
 * Their URL API documents waypoints as a pipe-separated list without promising
 * a length, and the commonly reported ceiling is nine intermediates. Rather
 * than discover the limit as a broken link, this caps at nine and the caller is
 * expected to say so - a trip quietly missing its last four stops is worse than
 * a trip that says it was too long to send whole.
 */
export const GOOGLE_WAYPOINT_LIMIT = 9;

/**
 * A whole trip, in Google Maps. Google only, because it is the only one of the
 * three whose links carry intermediate stops at all.
 *
 * @returns {{url: string, sent: number, dropped: number}} what the link covers,
 *   so the caller can be honest about a trip too long to fit in one.
 */
export function googleTripURL(stops) {
  const positions = (stops || []).map((stop) => stop?.position).filter(Boolean);
  if (positions.length < 2) return null;

  const origin = positions[0];
  const destination = positions[positions.length - 1];
  const middle = positions.slice(1, -1);
  const carried = middle.slice(0, GOOGLE_WAYPOINT_LIMIT);

  const parts = [
    'https://www.google.com/maps/dir/?api=1&travelmode=driving',
    `origin=${encodeURIComponent(latLon(origin))}`,
    `destination=${encodeURIComponent(latLon(destination))}`,
  ];
  if (carried.length) {
    parts.push(`waypoints=${carried.map((p) => encodeURIComponent(latLon(p))).join('%7C')}`);
  }

  return {
    url: parts.join('&'),
    sent: carried.length + 2,
    dropped: middle.length - carried.length,
  };
}

/**
 * The three, for one stop, in the order somebody is likely to want them.
 *
 * All three are offered rather than sniffed for, because there is no reliable
 * way to ask a browser whether an app is installed - and a link to an app
 * somebody does not have simply opens that service's website, which is a far
 * better outcome than a button this guessed wrong about and hid.
 */
export function directionsFor(position) {
  if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) return [];
  return [
    { id: 'apple', label: 'Apple Maps', url: appleMapsURL(position) },
    { id: 'google', label: 'Google Maps', url: googleMapsURL(position) },
    { id: 'waze', label: 'Waze', url: wazeURL(position) },
  ];
}
