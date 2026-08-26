/**
 * Where the sun and moon are, and when.
 *
 * This exists because the crude sunrise/sunset the details panel had was enough
 * to answer "how long until dark" and nothing else. A photographer needs more
 * and needs it precise: when blue hour starts, how long golden hour lasts, what
 * the moon will be doing and how much of it will be lit, and — the part a map
 * can answer that a table cannot — which way to point.
 *
 * Standard astronomical formulae (Meeus, via the Astronomy Answers
 * formulations). Accurate to roughly a minute for rise and set times and a
 * fraction of a degree for positions, which is far inside the error introduced
 * by the horizon actually having hills on it.
 *
 * Everything is pure arithmetic on a Date. No network, which matters: the
 * details panel is most useful exactly where there is no signal, and this is
 * the part of it that a photographer plans a whole evening around.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;

/** Obliquity of the ecliptic — the tilt that gives us seasons. */
const OBLIQUITY = 23.4397 * RAD;

/* ------------------------------------------------------------------ time */

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (julian) => new Date((julian + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

/* ------------------------------------------------------------------ frames */

function rightAscension(longitude, latitude) {
  return Math.atan2(
    Math.sin(longitude) * Math.cos(OBLIQUITY) - Math.tan(latitude) * Math.sin(OBLIQUITY),
    Math.cos(longitude),
  );
}

function declination(longitude, latitude) {
  return Math.asin(
    Math.sin(latitude) * Math.cos(OBLIQUITY)
    + Math.cos(latitude) * Math.sin(OBLIQUITY) * Math.sin(longitude),
  );
}

/**
 * Azimuth, measured clockwise from north.
 *
 * The underlying formula gives an angle from due south, which is the
 * astronomer's convention and the opposite of what anyone standing outside
 * with a compass wants. Converted here once, so nothing downstream has to
 * remember.
 */
function azimuthFromNorth(hourAngle, latitude, dec) {
  const fromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(dec) * Math.cos(latitude),
  );
  return (fromSouth / RAD + 180 + 360) % 360;
}

function altitude(hourAngle, latitude, dec) {
  return Math.asin(
    Math.sin(latitude) * Math.sin(dec)
    + Math.cos(latitude) * Math.cos(dec) * Math.cos(hourAngle),
  );
}

const siderealTime = (days, westLongitude) => RAD * (280.16 + 360.9856235 * days) - westLongitude;

/* ------------------------------------------------------------------ sun */

const solarMeanAnomaly = (days) => RAD * (357.5291 + 0.98560028 * days);

function eclipticLongitude(meanAnomaly) {
  // Equation of centre, then the longitude of perihelion.
  const centre = RAD * (1.9148 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)
    + 0.0003 * Math.sin(3 * meanAnomaly));
  return meanAnomaly + centre + RAD * 102.9372 + Math.PI;
}

function sunCoords(days) {
  const meanAnomaly = solarMeanAnomaly(days);
  const longitude = eclipticLongitude(meanAnomaly);
  return { dec: declination(longitude, 0), ra: rightAscension(longitude, 0) };
}

/**
 * Where the sun is right now.
 *
 * @returns {{azimuth: number, altitude: number}} degrees; azimuth from north.
 */
export function sunPosition(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const days = toDays(date);
  const coords = sunCoords(days);
  const hourAngle = siderealTime(days, westLongitude) - coords.ra;

  return {
    azimuth: azimuthFromNorth(hourAngle, latitude, coords.dec),
    altitude: altitude(hourAngle, latitude, coords.dec) / RAD,
  };
}

/* ---- rise and set ---- */

const J0 = 0.0009;

const julianCycle = (days, westLongitude) => Math.round(days - J0 - westLongitude / (2 * Math.PI));
const approxTransit = (angle, westLongitude, cycle) => J0 + (angle + westLongitude) / (2 * Math.PI) + cycle;
const solarTransitJ = (approx, meanAnomaly, longitude) =>
  J2000 + approx + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * longitude);

function hourAngleFor(elevation, latitude, dec) {
  return Math.acos(
    (Math.sin(elevation) - Math.sin(latitude) * Math.sin(dec))
    / (Math.cos(latitude) * Math.cos(dec)),
  );
}

/**
 * The elevations that define each phase of the day.
 *
 * -0.833° for the sun's own rise and set: half a degree for the disc's radius
 * plus about a third for atmospheric refraction, which lifts the sun into view
 * before it is geometrically up. The twilight definitions are conventions —
 * civil is when you can still read outside, nautical when the horizon is still
 * visible at sea, astronomical when the last of the sun's light leaves the sky.
 */
const ELEVATIONS = [
  { angle: -18, rise: 'astronomicalDawn', set: 'astronomicalDusk' },
  { angle: -12, rise: 'nauticalDawn', set: 'nauticalDusk' },
  { angle: -6, rise: 'civilDawn', set: 'civilDusk' },
  { angle: -4, rise: 'blueHourEnd', set: 'blueHourStart' },
  { angle: -0.833, rise: 'sunrise', set: 'sunset' },
  { angle: 6, rise: 'goldenHourEnd', set: 'goldenHourStart' },
];

/**
 * Every sun event for one day at one place.
 *
 * Times can be null: above the Arctic circle in June there is no sunrise
 * because the sun never sets, and no amount of arithmetic will produce one.
 * `polar` says which of those two situations you are in, so the caller can say
 * something true rather than printing dashes.
 *
 * @returns {{
 *   solarNoon: Date, nadir: Date, polar: ''|'day'|'night',
 *   sunrise: Date|null, sunset: Date|null, ...twilights
 * }}
 */
export function sunTimes(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const days = toDays(date);
  const cycle = julianCycle(days, westLongitude);

  const approx = approxTransit(0, westLongitude, cycle);
  const noonAnomaly = solarMeanAnomaly(approx);
  const noonLongitude = eclipticLongitude(noonAnomaly);
  const noonDec = declination(noonLongitude, 0);
  const noonJ = solarTransitJ(approx, noonAnomaly, noonLongitude);

  /**
   * Refine a time until the sun is actually at the elevation claimed.
   *
   * The closed-form solution and the position function are different
   * approximations of the same sky, and they disagree by about forty seconds —
   * enough that solving analytically for -0.833° and then asking where the sun
   * is at that moment gives -0.65°. Which is right hardly matters; that the
   * panel shows a sunrise time and a sun position that contradict each other
   * does.
   *
   * So the analytic answer is only a first guess, and Newton's method on the
   * position function finishes the job. The two now agree by construction, and
   * the elevations mean exactly what they say.
   */
  const refine = (guessJulian, targetElevation) => {
    let time = fromJulian(guessJulian).valueOf();

    for (let pass = 0; pass < 12; pass += 1) {
      const error = sunPosition(new Date(time), lat, lon).altitude - targetElevation;
      if (Math.abs(error) < 1e-5) break;

      const step = 30000;   // half a minute, for a numeric derivative
      const ahead = sunPosition(new Date(time + step), lat, lon).altitude - targetElevation;
      const slope = (ahead - error) / step;
      if (!Number.isFinite(slope) || slope === 0) break;

      const move = error / slope;
      // The sun crosses an elevation twice a day; a runaway step would walk to
      // the other crossing and converge on the wrong one.
      time -= Math.max(-6 * 3600000, Math.min(6 * 3600000, move));
    }

    const result = new Date(time);
    return Number.isFinite(result.valueOf()) ? result : null;
  };

  const result = {
    solarNoon: fromJulian(noonJ),
    nadir: fromJulian(noonJ - 0.5),
    polar: '',
  };

  for (const { angle, rise, set } of ELEVATIONS) {
    const w = hourAngleFor(angle * RAD, latitude, noonDec);
    if (Number.isNaN(w)) {
      // The sun stays above or below this elevation for the whole day.
      result[rise] = null;
      result[set] = null;
      continue;
    }

    const offset = w / (2 * Math.PI);
    result[rise] = refine(noonJ - offset, angle);
    result[set] = refine(noonJ + offset, angle);
  }

  if (!result.sunrise) {
    result.polar = altitude(0, latitude, noonDec) > 0 ? 'day' : 'night';
  }

  return result;
}

/* ------------------------------------------------------------------ moon */

/**
 * The moon's ecliptic position.
 *
 * A short series — the leading terms only. The moon's true motion needs
 * hundreds of terms to track to arc-seconds, but this holds it to a few
 * arc-minutes, which is far better than anyone can point a camera.
 */
function moonCoords(days) {
  const eclipticLon = RAD * (218.316 + 13.176396 * days);   // mean longitude
  const meanAnomaly = RAD * (134.963 + 13.064993 * days);   // mean anomaly
  const meanDistance = RAD * (93.272 + 13.229350 * days);   // argument of latitude

  const longitude = eclipticLon + RAD * 6.289 * Math.sin(meanAnomaly);
  const latitude = RAD * 5.128 * Math.sin(meanDistance);
  const distance = 385001 - 20905 * Math.cos(meanAnomaly);  // km

  return {
    ra: rightAscension(longitude, latitude),
    dec: declination(longitude, latitude),
    distance,
  };
}

/**
 * Where the moon is right now.
 *
 * The altitude is corrected for refraction near the horizon, the same reason
 * the sun appears to rise early: near the horizon the atmosphere bends light
 * enough to matter, higher up it does not.
 */
export function moonPosition(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const days = toDays(date);
  const coords = moonCoords(days);
  const hourAngle = siderealTime(days, westLongitude) - coords.ra;

  let h = altitude(hourAngle, latitude, coords.dec);
  h += RAD * 0.017 / Math.tan(h + RAD * 10.26 / (h / RAD + 5.10));

  return {
    azimuth: azimuthFromNorth(hourAngle, latitude, coords.dec),
    altitude: h / RAD,
    distance: coords.distance,
  };
}

const PHASE_NAMES = [
  'New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent',
];

/**
 * How much of the moon is lit, and which way it is heading.
 *
 * `phase` runs 0 to 1 from new moon through full and back. `fraction` is how
 * much of the disc is lit — those are different numbers, and the one people
 * mean by "percent" is the fraction. Waxing or waning is the half of the cycle,
 * which is what tells you whether tonight will be brighter than last night.
 *
 * @returns {{phase: number, fraction: number, waxing: boolean, name: string, angle: number}}
 */
export function moonIllumination(date = new Date()) {
  const days = toDays(date);
  const sun = sunCoords(days);
  const moon = moonCoords(days);
  const sunDistance = 149598000;   // km, near enough for this

  const elongation = Math.acos(
    Math.sin(sun.dec) * Math.sin(moon.dec)
    + Math.cos(sun.dec) * Math.cos(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  const inclination = Math.atan2(
    sunDistance * Math.sin(elongation),
    moon.distance - sunDistance * Math.cos(elongation),
  );
  const angle = Math.atan2(
    Math.cos(sun.dec) * Math.sin(sun.ra - moon.ra),
    Math.sin(sun.dec) * Math.cos(moon.dec)
    - Math.cos(sun.dec) * Math.sin(moon.dec) * Math.cos(sun.ra - moon.ra),
  );

  const phase = 0.5 + 0.5 * inclination * (angle < 0 ? -1 : 1) / Math.PI;
  const fraction = (1 + Math.cos(inclination)) / 2;

  return {
    phase,
    fraction,
    waxing: phase < 0.5,
    name: PHASE_NAMES[Math.round(phase * 8) % 8],
    angle,
  };
}

/**
 * Moonrise and moonset for one local day.
 *
 * Found by walking the day in hourly steps and looking for the altitude
 * crossing zero, then refining each crossing by fitting a parabola through
 * three samples. The moon moves fast enough — about half a degree an hour —
 * that a closed-form solution like the sun's does not exist, and it can rise
 * twice in a day or not at all.
 *
 * @returns {{rise: Date|null, set: Date|null, alwaysUp: boolean, alwaysDown: boolean}}
 */
export function moonTimes(date, lat, lon) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const hoursToDate = (hours) => new Date(start.valueOf() + hours * 3600000);
  const heightAt = (hours) => moonPosition(hoursToDate(hours), lat, lon).altitude;

  let previous = heightAt(0);
  let rise = null;
  let set = null;

  for (let hour = 1; hour <= 24; hour += 2) {
    const middle = heightAt(hour);
    const next = heightAt(hour + 1);

    // Fit y = ax² + bx + c through the three samples and solve for the roots.
    const a = (previous + next) / 2 - middle;
    const b = (next - previous) / 2;
    const xe = -b / (2 * a);
    const ye = (a * xe + b) * xe + middle;
    const discriminant = b * b - 4 * a * middle;

    let roots = 0;
    let x1 = 0;
    let x2 = 0;

    if (discriminant >= 0) {
      const delta = Math.sqrt(discriminant) / (Math.abs(a) * 2);
      x1 = xe - delta;
      x2 = xe + delta;
      if (Math.abs(x1) <= 1) roots += 1;
      if (Math.abs(x2) <= 1) roots += 1;
      if (x1 < -1) x1 = x2;
    }

    if (roots === 1) {
      if (previous < 0) rise = hour + x1; else set = hour + x1;
    } else if (roots === 2) {
      rise = hour + (ye < 0 ? x2 : x1);
      set = hour + (ye < 0 ? x1 : x2);
    }

    if (rise !== null && set !== null) break;
    previous = next;
  }

  return {
    rise: rise === null ? null : hoursToDate(rise),
    set: set === null ? null : hoursToDate(set),
    alwaysUp: rise === null && set === null && previous > 0,
    alwaysDown: rise === null && set === null && previous <= 0,
  };
}

/* ------------------------------------------------------------------ shooting */

/**
 * The light for a day, in the order it happens.
 *
 * Returned as a list rather than an object because that is how it is read: a
 * photographer wants the sequence and the length of each stretch, not to look
 * up "civilDusk" by name. `minutes` is how long the phase lasts, which is the
 * number that decides whether there is time to move to a second location.
 */
export function lightPhases(date, lat, lon) {
  const sun = sunTimes(date, lat, lon);
  const span = (from, to) => (from && to ? Math.round((to - from) / 60000) : null);

  const phases = [
    { id: 'astronomical', name: 'Astronomical twilight', from: sun.astronomicalDawn, to: sun.nauticalDawn },
    { id: 'nautical', name: 'Nautical twilight', from: sun.nauticalDawn, to: sun.civilDawn },
    { id: 'blue', name: 'Blue hour', from: sun.civilDawn, to: sun.blueHourEnd },
    { id: 'sunrise', name: 'Sunrise', from: sun.blueHourEnd, to: sun.sunrise },
    { id: 'golden', name: 'Golden hour', from: sun.sunrise, to: sun.goldenHourEnd },
    { id: 'day', name: 'Daylight', from: sun.goldenHourEnd, to: sun.goldenHourStart },
    { id: 'golden-pm', name: 'Golden hour', from: sun.goldenHourStart, to: sun.sunset },
    { id: 'sunset', name: 'Sunset', from: sun.sunset, to: sun.blueHourStart },
    { id: 'blue-pm', name: 'Blue hour', from: sun.blueHourStart, to: sun.civilDusk },
    { id: 'nautical-pm', name: 'Nautical twilight', from: sun.civilDusk, to: sun.nauticalDusk },
    { id: 'astronomical-pm', name: 'Astronomical twilight', from: sun.nauticalDusk, to: sun.astronomicalDusk },
  ];

  return phases
    .map((phase) => ({ ...phase, minutes: span(phase.from, phase.to) }))
    .filter((phase) => phase.minutes !== null && phase.minutes > 0);
}

/**
 * Which way to point, for each event worth pointing at.
 *
 * The azimuth of the sun and moon at the moment they cross the horizon. This is
 * the thing a table cannot tell you and a map can: whether the sun will set
 * behind that ridge or to the left of it.
 */
export function lightDirections(date, lat, lon) {
  const sun = sunTimes(date, lat, lon);
  const moon = moonTimes(date, lat, lon);

  const at = (when, body) => {
    if (!when) return null;
    const position = body === 'moon' ? moonPosition(when, lat, lon) : sunPosition(when, lat, lon);
    return Math.round(position.azimuth * 10) / 10;
  };

  return [
    { id: 'sunrise', name: 'Sunrise', body: 'sun', at: sun.sunrise, azimuth: at(sun.sunrise, 'sun') },
    { id: 'sunset', name: 'Sunset', body: 'sun', at: sun.sunset, azimuth: at(sun.sunset, 'sun') },
    { id: 'moonrise', name: 'Moonrise', body: 'moon', at: moon.rise, azimuth: at(moon.rise, 'moon') },
    { id: 'moonset', name: 'Moonset', body: 'moon', at: moon.set, azimuth: at(moon.set, 'moon') },
  ].filter((entry) => entry.azimuth !== null);
}

/**
 * Where the sun, moon and galactic core are *right now*.
 *
 * Rise and set bearings answer "where will it come up"; this answers "which of
 * those shapes on the horizon am I looking at". Only bodies above the horizon
 * are returned — a bearing to something that has set points at nothing — and
 * each carries its altitude, because a sun 3° up and a sun 40° up call for
 * completely different photographs.
 */
export function currentDirections(date, lat, lon) {
  const sun = sunPosition(date, lat, lon);
  const moon = moonPosition(date, lat, lon);
  const core = galacticCentre(date, lat, lon);

  return [
    { id: 'sun-now', name: 'Sun now', body: 'sun', now: true, at: date, ...sun },
    { id: 'moon-now', name: 'Moon now', body: 'moon', now: true, at: date, ...moon },
    { id: 'core-now', name: 'Milky Way now', body: 'core', now: true, at: date, ...core },
  ]
    .filter((entry) => entry.altitude > 0)
    .map((entry) => ({
      ...entry,
      azimuth: Math.round(entry.azimuth * 10) / 10,
      altitude: Math.round(entry.altitude * 10) / 10,
    }));
}

/**
 * A point a given distance and bearing from another, for drawing the lines.
 *
 * Great-circle, because at the length these lines are drawn a flat
 * approximation would visibly bend away from true north at high latitudes —
 * which is exactly where the low sun angles that matter to a photographer are.
 */
export function destinationPoint([lon, lat], bearingDegrees, distanceKm) {
  const radius = 6371.0088;
  const angular = distanceKm / radius;
  const bearing = bearingDegrees * RAD;
  const φ1 = lat * RAD;
  const λ1 = lon * RAD;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(angular)
    + Math.cos(φ1) * Math.sin(angular) * Math.cos(bearing),
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(φ1),
    Math.cos(angular) - Math.sin(φ1) * Math.sin(φ2),
  );

  return [((λ2 / RAD + 540) % 360) - 180, φ2 / RAD];
}

/* ------------------------------------------------------------- milky way */

/**
 * Where the galactic core is, and when it is worth photographing.
 *
 * The bright part of the Milky Way — the bulge around Sagittarius A* — is a
 * fixed point on the sky, so unlike the sun and moon it needs no orbital
 * model at all: one right ascension and one declination, run through the same
 * hour-angle machinery as everything else.
 *
 * J2000 coordinates. Precession has moved the core about a third of a degree
 * since, which is a fifth of the width of the core itself and far inside the
 * error from wherever the hills are.
 */
const CORE_RA = 266.41681 * RAD;    // 17h 45m 40.0s
const CORE_DEC = -29.00782 * RAD;   // -29° 00′ 28″

/** Sun altitude below which the sky is properly dark. */
const ASTRONOMICAL_NIGHT = -18;

export function galacticCentre(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const hourAngle = siderealTime(toDays(date), westLongitude) - CORE_RA;

  return {
    azimuth: azimuthFromNorth(hourAngle, latitude, CORE_DEC),
    altitude: altitude(hourAngle, latitude, CORE_DEC) / RAD,
  };
}

/*
 * Galactic to equatorial, so the band can be sampled rather than just its
 * centre.
 *
 * The north galactic pole and the galactic longitude of the north celestial
 * pole, J2000. These three numbers are the whole coordinate transform.
 */
const NGP_RA = 192.85948 * RAD;
const NGP_DEC = 27.12825 * RAD;
const NCP_LONGITUDE = 122.93192 * RAD;

function galacticToEquatorial(galacticLongitude, galacticLatitude) {
  const gap = NCP_LONGITUDE - galacticLongitude;
  const sinB = Math.sin(galacticLatitude);
  const cosB = Math.cos(galacticLatitude);

  const dec = Math.asin(
    Math.sin(NGP_DEC) * sinB + Math.cos(NGP_DEC) * cosB * Math.cos(gap),
  );
  const ra = NGP_RA + Math.atan2(
    cosB * Math.sin(gap),
    Math.cos(NGP_DEC) * sinB - Math.sin(NGP_DEC) * cosB * Math.cos(gap),
  );

  return { ra, dec };
}

/**
 * How much of the Milky Way is above the horizon, as a fraction.
 *
 * "The Milky Way" here means the part worth driving out for: the bright core
 * region either side of the galactic centre — Scorpius and Sagittarius through
 * to Scutum and Aquila. Taken literally the Milky Way is a great circle right
 * around the sky, and exactly half of a great circle is above the horizon at
 * every instant from everywhere, which is a true statement that helps nobody.
 *
 * The band is sampled along the galactic equator and each sample tested against
 * the horizon, so the answer accounts for the thing that actually decides it:
 * the angle the band makes with the horizon. A band standing upright clears the
 * horizon all at once; one lying flat comes up a piece at a time, which is why
 * the same core altitude can mean a quarter of the arch or all of it.
 *
 * @returns {{fraction: number, points: object[], highest: object, lowest: object}}
 */
export function milkyWayArc(date, lat, lon, { span = 40, step = 5, minAltitude = 0 } = {}) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const sidereal = siderealTime(toDays(date), westLongitude);

  const points = [];
  for (let longitude = -span; longitude <= span; longitude += step) {
    const { ra, dec } = galacticToEquatorial(longitude * RAD, 0);
    const hourAngle = sidereal - ra;
    points.push({
      longitude,
      azimuth: azimuthFromNorth(hourAngle, latitude, dec),
      altitude: altitude(hourAngle, latitude, dec) / RAD,
    });
  }

  const above = points.filter((point) => point.altitude > minAltitude);
  const byAltitude = [...points].sort((a, b) => a.altitude - b.altitude);

  return {
    fraction: above.length / points.length,
    points,
    lowest: byAltitude[0],
    highest: byAltitude[byAltitude.length - 1],
  };
}

/**
 * The Milky Way's band, laid on the ground so a map can draw it.
 *
 * A map is a plan view and the galaxy is overhead, so something has to give.
 * The convention every planetarium app uses — and the one a reader already
 * understands from the sun and moon lines — is to plot each point along its own
 * bearing, at a distance that shrinks as the point climbs: something on the
 * horizon lands at the far edge, something overhead lands on top of you.
 *
 * That makes the drawn curve mean what it looks like. An arc sweeping wide
 * across the south is a band lying low along the southern horizon; one pulled
 * into a tight hook is a band standing up steeply. Both are the shape you would
 * see if you looked up, and both are wrong if you read the distances as
 * distances — which is why the line is drawn without a scale on it.
 *
 * Sampled every three degrees of galactic longitude across the 180° that
 * contains the core, which is enough for a smooth curve at any zoom the line is
 * legible at.
 *
 * @returns {{line: number[][], core: object|null, fraction: number}}
 */
export function milkyWayGround([lon, lat], date, { maxKm = 40, minAltitude = 0, span = 90, step = 3 } = {}) {
  const arc = milkyWayArc(date, lat, lon, { span, step, minAltitude });

  const project = (point) => {
    const height = Math.min(90, Math.max(0, point.altitude));
    return destinationPoint([lon, lat], point.azimuth, maxKm * (1 - height / 90));
  };

  const core = galacticCentre(date, lat, lon);

  return {
    line: arc.points.filter((point) => point.altitude > minAltitude).map(project),
    core: core.altitude > minAltitude
      ? { position: project(core), azimuth: core.azimuth, altitude: core.altitude }
      : null,
    fraction: arc.fraction,
  };
}

/**
 * Where the core will be, all night, as ground positions.
 *
 * `milkyWayGround` answers "where is the band right now". This answers the
 * question a photographer actually plans around: where does the core *go*
 * between dusk and dawn, so which way will it have moved by the time you have
 * hiked in and set up.
 *
 * Same projection as the band — along its bearing, pulled in as it climbs — so
 * the track and the band are in the same picture and can be read together. It
 * curves because the core rises in the south-east, transits south, and sets in
 * the south-west, and the pull-in makes that an arc rather than a fan.
 *
 * Every point carries its own time and altitude, so the caller can label hours
 * along it without recomputing anything.
 *
 * @returns {{when: Date, altitude: number, azimuth: number, position: number[]}[]}
 */
export function milkyWayTrack([lon, lat], from, to, {
  maxKm = 40, stepMinutes = 15, minAltitude = 0,
} = {}) {
  const start = from?.valueOf?.();
  const end = to?.valueOf?.();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const points = [];
  const step = Math.max(1, stepMinutes) * 60000;

  /*
   * Sampled on the clock, not from wherever the window happens to open.
   *
   * Dark begins at an arbitrary minute — 21:47 tonight, 21:44 tomorrow — and
   * stepping a quarter-hour from there gives :47, :02, :17, :32 and never a
   * whole hour, so a caller labelling the hours along the track finds none to
   * label. Anchoring to the epoch puts every sample on a clean quarter, and
   * every real time zone is a whole number of quarter-hours from UTC, so those
   * are clean local quarters too.
   */
  const first = Math.ceil(start / step) * step;

  for (let at = first; at <= end; at += step) {
    const when = new Date(at);
    const core = galacticCentre(when, lat, lon);
    if (core.altitude <= minAltitude) continue;
    const height = Math.min(90, Math.max(0, core.altitude));
    points.push({
      when,
      altitude: core.altitude,
      azimuth: core.azimuth,
      position: destinationPoint([lon, lat], core.azimuth, maxKm * (1 - height / 90)),
    });
  }
  return points;
}

/**
 * The highest the core ever gets from a given latitude.
 *
 * Worth stating plainly because it is the first thing that surprises people:
 * the core sits 29° south of the celestial equator, so from the continental US
 * it tops out somewhere between about 15° and 35° above the southern horizon
 * and never climbs overhead. Asking when it will be at 70° has no answer north
 * of the tropics, and a panel that quietly showed nothing would look broken
 * rather than informative.
 */
export function coreMaxAltitude(lat) {
  return 90 - Math.abs(lat - CORE_DEC / RAD);
}

/**
 * Walk one night in fixed steps, sampling everything that decides whether the
 * core is shootable.
 *
 * Sampling rather than solving is deliberate. The condition is a conjunction of
 * four things — core high enough, sun far enough down, moon below the horizon,
 * and the clock — and each has its own closed form, but their intersection does
 * not. Stepping the night is simpler to read, simpler to trust, and at a
 * two-minute step lands within a minute of the truth, which is finer than the
 * horizon justifies.
 */
function sampleNight(noon, lat, lon, stepMinutes, withArc) {
  const samples = [];
  const step = stepMinutes * 60000;
  const end = noon.valueOf() + DAY_MS;

  for (let time = noon.valueOf(); time <= end; time += step) {
    const when = new Date(time);
    samples.push({
      when,
      core: galacticCentre(when, lat, lon),
      sun: sunPosition(when, lat, lon).altitude,
      moon: moonPosition(when, lat, lon).altitude,
      // Seventeen extra positions per sample, so it is asked for rather than
      // assumed: the month-ahead scan ranks nights on moonlight alone and would
      // pay this cost forty times over for a number it never reads.
      arc: withArc ? milkyWayArc(when, lat, lon).fraction : 0,
    });
  }
  return samples;
}

/** The first contiguous run of samples passing `test`, as a {from, to, minutes}. */
function windowOf(samples, test) {
  let from = null;
  let to = null;

  for (const sample of samples) {
    if (test(sample)) {
      if (!from) from = sample.when;
      to = sample.when;
    } else if (from) {
      break;
    }
  }
  if (!from || !to || to <= from) return null;
  return { from, to, minutes: Math.round((to - from) / 60000) };
}

/**
 * Tonight's Milky Way, for the night that starts on `date`.
 *
 * "Tonight" runs noon to noon, because the good hours are usually after
 * midnight and a calendar day would cut them in half.
 *
 * @returns {{
 *   maxAltitude: number, possible: boolean, transit: Date|null, transitAltitude: number,
 *   transitAzimuth: number, riseAzimuth: number|null, setAzimuth: number|null,
 *   dark: object|null, window: object|null, moonless: object|null,
 *   moon: {fraction: number, waxing: boolean, name: string}, marks: object[],
 *   reason: string,
 * }}
 */
export function milkyWayNight(date, lat, lon, { minAltitude = 10, stepMinutes = 2, arc = true } = {}) {
  const noon = new Date(date);
  noon.setHours(12, 0, 0, 0);

  const samples = sampleNight(noon, lat, lon, stepMinutes, arc);
  const ceiling = coreMaxAltitude(lat);

  const highest = samples.reduce(
    (best, sample) => (sample.core.altitude > best.core.altitude ? sample : best),
    samples[0],
  );

  const dark = windowOf(samples, (s) => s.sun <= ASTRONOMICAL_NIGHT);
  const up = (s) => s.core.altitude >= minAltitude;
  const shootable = (s) => up(s) && s.sun <= ASTRONOMICAL_NIGHT;
  const window = windowOf(samples, shootable);
  const moonless = windowOf(samples, (s) => shootable(s) && s.moon < 0);

  /*
   * "When is three quarters of it up?" — asked of the band, not the centre.
   *
   * Each threshold has two answers a night, once as the arch rises and once as
   * it tips back over. Thresholds the band never reaches from this latitude are
   * dropped rather than reported as never: from the mid-northern US the
   * southern end of the core region simply never clears the horizon, so 100%
   * has no answer and printing one would be a lie.
   */
  const afterDark = samples.filter((sample) => sample.sun <= ASTRONOMICAL_NIGHT);
  const peakArc = arc && afterDark.length
    ? Math.max(...afterDark.map((sample) => sample.arc))
    : 0;

  const marks = [25, 50, 75, 90, 100]
    .filter((mark) => arc && mark <= Math.round(peakArc * 100))
    .map((mark) => {
      /*
       * Measured only where the sky is dark. Half the band is above the
       * horizon through most of a summer afternoon, and a chip reading "75%
       * from 5:22 PM" is technically true and actively misleading — it is a
       * time you cannot use, printed next to times you can.
       */
      const test = (sample) => sample.arc * 100 >= mark;
      const rising = afterDark.find(test);
      const falling = [...afterDark].reverse().find(test);
      return rising && falling && falling.when > rising.when
        ? { percent: mark, rising: rising.when, falling: falling.when }
        : null;
    })
    .filter(Boolean);

  /*
   * The highest the core gets *inside the window you can actually shoot*.
   *
   * Not the same as the transit, and the gap is the whole point. In late
   * summer the core transits before astronomical dark arrives, and by autumn
   * it transits in daylight — a panel reporting a 25° peak at half past two in
   * the afternoon is stating a true fact about a sky nobody can photograph.
   */
  const inWindow = window
    ? samples.filter((sample) => sample.when >= window.from && sample.when <= window.to)
    : [];
  const windowPeak = inWindow.length
    ? inWindow.reduce((best, sample) => (sample.core.altitude > best.core.altitude ? sample : best))
    : null;

  /*
   * The most of the band you can have at once, and when — measured inside the
   * dark window rather than across the whole night, because the arch is at its
   * best in the west long after the sky has started to grey in the east.
   */
  const arcPeak = arc && inWindow.length
    ? inWindow.reduce((best, sample) => (sample.arc > best.arc ? sample : best))
    : null;

  /*
   * The moments worth setting an alarm for, beyond "when is it highest".
   *
   * Photographers do not all want the same instant. The core at its highest is
   * the most detail and the least atmosphere to shoot through, and it is the
   * answer most of the time — but an arch panorama wants the band at its most
   * complete, a landscape foreground wants the core sitting low over the
   * terrain, and anyone who cannot stay out all night wants to know the
   * earliest moment the sky is properly dark.
   *
   * Only moments that exist tonight are returned. A list padded with
   * unavailable options is worse than a short one.
   */
  const inDark = (sample) => sample.sun <= ASTRONOMICAL_NIGHT;
  const usable = samples.filter((sample) => inDark(sample) && sample.core.altitude >= 0);

  const runWhere = (test) => {
    let from = null;
    let to = null;
    for (const sample of usable) {
      if (test(sample)) {
        if (!from) from = sample.when;
        to = sample.when;
      } else if (from) break;
    }
    return from && to && to > from ? { from, to } : null;
  };

  const lowRun = runWhere((sample) => sample.core.altitude >= 4 && sample.core.altitude <= 15);
  const moonCrossing = (() => {
    for (let i = 1; i < samples.length; i += 1) {
      const before = samples[i - 1];
      const after = samples[i];
      if (!inDark(after)) continue;
      if (before.moon >= 0 && after.moon < 0) return { when: after.when, setting: true };
      if (before.moon < 0 && after.moon >= 0) return { when: after.when, setting: false };
    }
    return null;
  })();

  const moments = [
    windowPeak && {
      id: 'peak', primary: true, name: 'Core at its highest',
      when: windowPeak.when,
      why: 'Most detail, and the least atmosphere to shoot through.',
    },
    arcPeak && Math.abs(arcPeak.when - (windowPeak?.when ?? 0)) > 20 * 60000 && {
      id: 'arch', name: 'Most of the band up',
      when: arcPeak.when,
      why: `${Math.round(arcPeak.fraction * 100)}% of the core region above the horizon — the moment for an arch panorama.`,
    },
    lowRun && {
      id: 'low', name: 'Core low over the landscape',
      when: lowRun.from, until: lowRun.to,
      why: 'Between 4° and 15° up, so the core sits on the terrain rather than over your head.',
    },
    moonCrossing && {
      id: 'moon', name: moonCrossing.setting ? 'Moon sets' : 'Moon rises',
      when: moonCrossing.when,
      why: moonCrossing.setting
        ? 'The sky darkens from here — this is when the good part starts.'
        : 'Sky glow rises from here — shoot before it.',
    },
    dark && {
      id: 'dark', name: 'Sky fully dark',
      when: dark.from,
      why: 'Astronomical twilight ends. The earliest the band reads properly on a sensor.',
    },
  ]
    .filter(Boolean)
    /*
     * Two entries pointing at the same minute are one entry with two names.
     * In midsummer the band peaks the instant the sky goes dark, so "most of
     * the band up" and "sky fully dark" both landed on 2:42 and the list read
     * as padding. A moment with a range of its own always survives — it is
     * saying something different even when it starts at the same time.
     */
    .filter((moment, index, all) => moment.until || moment.primary || !all.some(
      (other, otherIndex) => otherIndex < index && !other.until
        && Math.abs(other.when - moment.when) < 15 * 60000,
    ))
    .slice(0, 5);

  const azimuthWhen = (test) => {
    const hit = samples.find(test);
    return hit ? Math.round(hit.core.azimuth * 10) / 10 : null;
  };

  let reason = '';
  if (ceiling < minAltitude) reason = `the core never rises above ${Math.round(ceiling)}° from this latitude`;
  else if (!dark) reason = 'the sky never gets fully dark tonight';
  else if (!window) reason = 'the core is only above the horizon in daylight at this time of year';
  else if (!moonless) reason = 'the moon is up for the whole of the dark window';

  return {
    maxAltitude: Math.round(ceiling * 10) / 10,
    possible: !!window,
    transit: highest ? highest.when : null,
    transitAltitude: highest ? Math.round(highest.core.altitude * 10) / 10 : 0,
    transitAzimuth: highest ? Math.round(highest.core.azimuth * 10) / 10 : 180,
    riseAzimuth: azimuthWhen(up),
    setAzimuth: (() => {
      const hit = [...samples].reverse().find(up);
      return hit ? Math.round(hit.core.azimuth * 10) / 10 : null;
    })(),
    dark,
    window,
    moonless,
    marks,
    moments,
    arcPeak: arcPeak
      ? { when: arcPeak.when, fraction: arcPeak.arc, altitude: Math.round(arcPeak.core.altitude * 10) / 10 }
      : null,
    windowPeak: windowPeak
      ? {
        when: windowPeak.when,
        altitude: Math.round(windowPeak.core.altitude * 10) / 10,
        azimuth: Math.round(windowPeak.core.azimuth * 10) / 10,
      }
      : null,
    moon: (() => {
      const middle = window || dark;
      const at = middle ? new Date((middle.from.valueOf() + middle.to.valueOf()) / 2) : noon;
      const lit = moonIllumination(at);
      return { fraction: lit.fraction, waxing: lit.waxing, name: lit.name };
    })(),
    reason,
  };
}

/**
 * How good a night this actually is, as a percentage.
 *
 * Three things decide whether you see the Milky Way, and only one of them is
 * astronomy. The sky has to be dark — handled already, by the window itself.
 * The moon has to be out of the way. And it has to be clear, which is the one
 * that most often ruins the trip and the one no amount of orbital mechanics
 * will tell you.
 *
 * Scored across the window minute by minute rather than as an average of
 * averages, because the shape matters: a window whose first half is overcast
 * and second half clear is a night worth driving to, and one that is uniformly
 * half-clouded is not, and a single mean cannot tell them apart.
 *
 * `cover` is an optional hour-by-hour cloud series. Without it the score is
 * moon-only and says so, rather than quietly assuming clear skies — an
 * optimistic default here sends someone out under an overcast sky.
 *
 * @returns {{score: number, verdict: string, moonScore: number,
 *            cloudScore: number|null, cloudCover: number|null, best: object|null}}
 */
export function nightQuality(night, cover = null) {
  const window = night?.window;
  if (!window) {
    return { score: null, verdict: 'No window tonight', moonScore: 0, cloudScore: null, cloudCover: null, best: null };
  }

  const coverAt = (when) => {
    if (!cover?.length) return null;
    let closest = null;
    let gap = Infinity;
    for (const hour of cover) {
      const distance = Math.abs(hour.at - when);
      if (distance < gap && hour.cover !== null) {
        gap = distance;
        closest = hour.cover;
      }
    }
    // More than 90 minutes from the nearest reading is not a reading.
    return gap <= 5400000 ? closest : null;
  };

  const step = 300000;   // five minutes
  const samples = [];
  for (let time = window.from.valueOf(); time <= window.to.valueOf(); time += step) {
    const when = new Date(time);
    const moonUp = night.moonless
      ? when < night.moonless.from || when > night.moonless.to
      : true;

    /*
     * A full moon up is close to fatal; a thin crescent barely matters. The
     * 0.85 leaves a floor: even under a full moon the brightest parts of the
     * band are still there, which is why people photograph it anyway.
     */
    const moonScore = moonUp ? 1 - 0.85 * night.moon.fraction : 1;
    const clouds = coverAt(when);
    samples.push({ when, moonScore, cloudScore: clouds === null ? null : 1 - clouds / 100 });
  }

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const moonScore = mean(samples.map((sample) => sample.moonScore));
  const measured = samples.filter((sample) => sample.cloudScore !== null);
  const cloudScore = measured.length ? mean(measured.map((sample) => sample.cloudScore)) : null;

  const score = cloudScore === null ? null : moonScore * cloudScore;

  /*
   * The best stretch inside the window: the longest run scoring above the
   * window's own average, which is what "come at this time" actually means.
   *
   * A uniform night is the case to be careful with. When every sample scores
   * the same, floating-point drift puts the mean a hair above some of them and
   * the run shatters — so a perfectly clear, moonless night reported no best
   * stretch at all, which is the opposite of the truth. A window that barely
   * varies has no better part: the whole of it is the best part.
   */
  const scored = samples.map((sample) => ({
    when: sample.when,
    value: sample.moonScore * (sample.cloudScore === null ? 1 : sample.cloudScore),
  }));
  const values = scored.map((entry) => entry.value);
  const spread = Math.max(...values) - Math.min(...values);

  let best = null;
  if (spread < 0.05) {
    best = { from: window.from, to: window.to, peak: Math.max(...values) };
  } else {
    const threshold = mean(values);
    let run = null;
    for (const entry of [...scored, null]) {
      if (entry && entry.value >= threshold) {
        run = run || { from: entry.when, to: entry.when, peak: entry.value };
        run.to = entry.when;
        run.peak = Math.max(run.peak, entry.value);
      } else if (run) {
        if (!best || run.to - run.from > best.to - best.from) best = run;
        run = null;
      }
    }
  }

  return {
    score,
    verdict: verdictFor(score === null ? moonScore : score, cloudScore),
    moonScore,
    cloudScore,
    cloudCover: cloudScore === null ? null : Math.round((1 - cloudScore) * 100),
    best: best && best.to > best.from ? best : null,
  };
}

function verdictFor(score, cloudScore) {
  if (cloudScore === null) {
    // Without cloud data the word would overstate what is known.
    return score >= 0.75 ? 'Moon is out of the way' : score >= 0.4 ? 'Moon interferes' : 'Moon washes it out';
  }
  if (score >= 0.75) return 'Excellent';
  if (score >= 0.55) return 'Good';
  if (score >= 0.3) return 'Fair';
  if (score >= 0.12) return 'Poor';
  return 'Not tonight';
}

/**
 * The next `nights` nights, ranked by how much moonless dark core time each has.
 *
 * This is the question a photographer actually asks — not "is it up tonight"
 * but "which weekend do I drive out" — and it is answerable weeks ahead
 * because the only variable that moves is the moon. Cloud is the other
 * variable and is not knowable at this range; the panel layers a forecast over
 * the near end of this list rather than pretending this can include it.
 *
 * Coarser sampling than a single night: at ten minutes the ranking is identical
 * and a month costs a fraction of the arithmetic.
 */
export function bestMilkyWayNights(date, lat, lon, nights = 30, options = {}) {
  const results = [];

  for (let offset = 0; offset < nights; offset += 1) {
    const night = new Date(date);
    night.setHours(12, 0, 0, 0);
    night.setDate(night.getDate() + offset);

    const detail = milkyWayNight(night, lat, lon, { stepMinutes: 10, arc: false, ...options });
    results.push({
      date: night,
      minutes: detail.moonless?.minutes || 0,
      window: detail.moonless,
      maxAltitude: detail.transitAltitude,
      moon: detail.moon,
      possible: detail.possible,
    });
  }

  return results;
}
