/**
 * Lunar eclipses: when they are, how deep, and how long.
 *
 * Deliberately not built on sky.js's moon.
 *
 * That series carries one latitude term — 5.128 sin F — and no evection, which
 * is ample for pointing a camera at the moon and hopeless here. Whether an
 * eclipse happens at all turns on the moon's ecliptic latitude at the moment of
 * opposition, measured against an umbra about forty arc-minutes across. A
 * model good to "a few arc-minutes" would call marginal eclipses wrong and put
 * contact times out by tens of minutes, which is worse than not answering.
 *
 * This is Meeus, Astronomical Algorithms, chapter 54 — a purpose-built recipe
 * for eclipses rather than a general ephemeris evaluated at one instant. It
 * gives greatest eclipse to well under a minute, and magnitudes to a few
 * thousandths, for centuries either side of now.
 *
 * Everything here is in UTC and is the same for every observer on Earth: a
 * lunar eclipse is the moon moving through one shadow, so the whole planet
 * sees the same event at the same moment. Only whether the moon is ABOVE THE
 * HORIZON differs from place to place, and that is the one part this module
 * leaves to the caller.
 */

const RAD = Math.PI / 180;
const sin = (degrees) => Math.sin(degrees * RAD);
const cos = (degrees) => Math.cos(degrees * RAD);

/** Julian Ephemeris Day to a Date. Close enough: the difference from TT is under a minute here. */
const fromJDE = (jde) => new Date((jde - 2440587.5) * 86400000);
const toJDE = (date) => date.getTime() / 86400000 + 2440587.5;

/**
 * The lunation number for a full moon near a date.
 *
 * `k` counts new moons from January 2000; a full moon is a whole number plus a
 * half. Meeus gives the approximation directly from the fractional year.
 */
function lunationNear(date) {
  const year = date.getUTCFullYear()
    + (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1))
      / (Date.UTC(date.getUTCFullYear() + 1, 0, 1) - Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.floor((year - 2000) * 12.3685);
}

/**
 * Everything about the eclipse at one full moon, or null if there is not one.
 *
 * `k` must be a lunation plus 0.5 — the half is what makes it a full moon
 * rather than a new one, and passing a whole number here computes a SOLAR
 * eclipse's geometry with lunar formulae, which is silently wrong rather than
 * an error.
 */
export function eclipseAtLunation(k) {
  /*
   * Enforced rather than merely documented.
   *
   * A whole k is a NEW moon, and these are the full-moon corrections. Applied
   * there they compute a solar eclipse's geometry with the wrong constants and
   * return a plausible-looking object — the failure would be a wrong answer,
   * not a crash, which is the kind that survives a long time.
   */
  if (!Number.isFinite(k) || Math.abs(k - Math.floor(k) - 0.5) > 1e-9) {
    throw new RangeError(`eclipseAtLunation wants a lunation plus a half (a full moon); got ${k}`);
  }

  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;

  // Mean phase, then the corrections that turn it into greatest eclipse.
  const mean = 2451550.09766 + 29.530588861 * k
    + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;

  // Eccentricity of the earth's orbit, which slowly shrinks; the solar terms
  // below are scaled by it.
  const E = 1 - 0.002516 * T - 0.0000074 * T2;

  const M = 2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3;        // sun
  const M1 = 201.5643 + 385.81693528 * k + 0.0107582 * T2
    + 0.00001238 * T3 - 0.000000058 * T4;                                        // moon
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2
    - 0.00000227 * T3 + 0.000000011 * T4;                                        // latitude
  const omega = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;    // node

  /*
   * The gate. F is the moon's argument of latitude: near 0 or 180 the moon is
   * near a node and can meet the shadow, and away from it no eclipse is
   * possible at all. Meeus gives 0.36 as the bound, and skipping early here is
   * what keeps a scan over years cheap.
   */
  if (Math.abs(sin(F)) > 0.36) return null;

  const F1 = F - 0.02665 * sin(omega);
  const A1 = 299.77 + 0.107408 * k - 0.009173 * T2;

  const jde = mean
    - 0.4065 * sin(M1) + 0.1727 * E * sin(M)
    + 0.0161 * sin(2 * M1) - 0.0097 * sin(2 * F1)
    + 0.0073 * E * sin(M1 - M) - 0.0050 * E * sin(M1 + M)
    - 0.0023 * sin(M1 - 2 * F1) + 0.0021 * E * sin(2 * M)
    + 0.0012 * sin(M1 + 2 * F1) + 0.0006 * E * sin(2 * M1 + M)
    - 0.0004 * sin(3 * M1) - 0.0003 * E * sin(M + 2 * F1)
    + 0.0003 * sin(A1) - 0.0002 * E * sin(M - 2 * F1)
    - 0.0002 * E * sin(2 * M1 - M) - 0.0002 * sin(omega);

  const P = 0.2070 * E * sin(M) + 0.0024 * E * sin(2 * M)
    - 0.0392 * sin(M1) + 0.0116 * sin(2 * M1)
    - 0.0073 * E * sin(M1 + M) + 0.0067 * E * sin(M1 - M)
    + 0.0118 * sin(2 * F1);

  const Q = 5.2207 - 0.0048 * E * cos(M) + 0.0020 * E * cos(2 * M)
    - 0.3299 * cos(M1) - 0.0060 * E * cos(M1 + M) + 0.0041 * E * cos(M1 - M);

  const W = Math.abs(cos(F1));

  /*
   * Gamma is the least distance from the moon's centre to the axis of earth's
   * shadow, in equatorial earth radii, and it is the number the whole event
   * follows from. Negative means the moon passes south of the axis.
   */
  const gamma = (P * cos(F1) + Q * sin(F1)) * (1 - 0.0048 * W);

  // u is the umbra's radius correction — it is how far the shadow has spread
  // by the moon's distance, and it moves with the sun's own distance too.
  const u = 0.0059 + 0.0046 * E * cos(M) - 0.0182 * cos(M1)
    + 0.0004 * cos(2 * M1) - 0.0005 * cos(M + M1);

  const penumbralMagnitude = (1.5573 + u - Math.abs(gamma)) / 0.5450;
  const umbralMagnitude = (1.0128 - u - Math.abs(gamma)) / 0.5450;

  if (penumbralMagnitude <= 0) return null;

  const kind = umbralMagnitude >= 1 ? 'total'
    : umbralMagnitude > 0 ? 'partial'
      : 'penumbral';

  // Radii of the three shadow circles the moon can be inside, and the moon's
  // own rate of travel through them.
  const partialRadius = 1.0128 - u;
  const totalRadius = 0.4678 - u;
  const penumbralRadius = 1.5573 + u;
  const rate = 0.5458 + 0.0400 * cos(M1);

  const semiDuration = (radius) => {
    const inside = radius * radius - gamma * gamma;
    return inside > 0 ? (60 / rate) * Math.sqrt(inside) : 0;
  };

  const greatest = fromJDE(jde);
  const minutes = (n) => new Date(greatest.getTime() + n * 60000);

  const penumbral = semiDuration(penumbralRadius);
  const partial = kind === 'penumbral' ? 0 : semiDuration(partialRadius);
  const total = kind === 'total' ? semiDuration(totalRadius) : 0;

  return {
    kind,
    greatest,
    gamma,
    umbralMagnitude,
    penumbralMagnitude,
    // The phases the moon is inside each shadow, outermost first. A penumbral
    // eclipse has only the first; a total has all three.
    penumbral: penumbral ? { from: minutes(-penumbral), to: minutes(penumbral), minutes: penumbral * 2 } : null,
    partial: partial ? { from: minutes(-partial), to: minutes(partial), minutes: partial * 2 } : null,
    total: total ? { from: minutes(-total), to: minutes(total), minutes: total * 2 } : null,
  };
}

/**
 * Lunar eclipses from a date forward.
 *
 * Scans full moons rather than days: an eclipse can only happen at one, and
 * the gate on F throws out the great majority in a few lines of arithmetic.
 */
export function lunarEclipses(from = new Date(), { count = 6, years = 12 } = {}) {
  const start = lunationNear(from) - 2;
  const limit = start + Math.ceil(years * 12.3685) + 2;
  const found = [];

  for (let k = start; k <= limit && found.length < count; k += 1) {
    const eclipse = eclipseAtLunation(k + 0.5);
    if (!eclipse) continue;
    // The whole event, not just its middle: an eclipse already under way when
    // you look is still the one you want to be told about.
    const ends = eclipse.penumbral?.to || eclipse.greatest;
    if (ends < from) continue;
    found.push(eclipse);
  }
  return found;
}

/**
 * The three circles of an eclipse, in earth radii, ready to draw.
 *
 * Exported so the picture and the physics cannot drift apart. Meeus's 1.0128 -
 * u and 1.5573 + u are the distances from the shadow axis to the moon's CENTRE
 * at first contact, so each already contains a moon radius — which is exactly
 * why magnitude divides by 0.5450, a moon diameter. Using them as the shadow
 * radii makes both circles one moon too big, and a partial eclipse then draws
 * as a total one: plausible, symmetrical, and wrong.
 */
export function shadowGeometry(eclipse) {
  const MOON = 0.2725;
  const u = 0.0059;
  return {
    moon: MOON,
    umbra: 1.0128 - u - MOON,
    penumbra: 1.5573 + u - MOON,
    offset: Math.abs(eclipse.gamma),
  };
}

/** How deep it gets, in the words people use for it. */
export function describeEclipse(eclipse) {
  if (!eclipse) return '';
  if (eclipse.kind === 'total') {
    return 'The moon passes entirely into the earth’s shadow and turns a deep '
      + 'copper red — the only red light left is what the earth’s atmosphere bends around it.';
  }
  if (eclipse.kind === 'partial') {
    const percent = Math.round(eclipse.umbralMagnitude * 100);
    return `${percent}% of the moon’s face crosses into the earth’s shadow, `
      + 'leaving a dark bite out of it with a red edge.';
  }
  return 'The moon passes through the pale outer shadow only. It dims a little '
    + 'on one side and is easy to miss unless you are looking for it.';
}
