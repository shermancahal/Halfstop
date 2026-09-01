/**
 * Fog, worked out from a public forecast rather than read off one.
 *
 * The National Weather Service does not publish a fog probability. Its
 * gridpoint feed publishes the ingredients — temperature, dewpoint, wind and
 * sky cover, hour by hour, a week out — and a forecaster turns those into the
 * word "patchy fog" in the prose forecast. This module does the same arithmetic
 * the ingredients support, and says which ingredient decided each hour.
 *
 * That distinction is the whole design. Everything here is a model over
 * somebody else's forecast, so it is stated as a likelihood with its reasoning
 * attached, and the one place a real forecast of fog is available — the
 * `visibility` series, which some grids publish and most do not — overrules the
 * model rather than being averaged with it.
 *
 * WHY THE INGREDIENTS ARE THESE
 *
 * Fog is cloud on the ground, so the dominant term is how close the air is to
 * saturation: the dewpoint depression, T minus Td. At a depression of zero the air
 * cannot hold what it has. That term alone would be useless, though, because
 * saturated air in a gale is low cloud and drizzle, not fog — what turns
 * saturation into fog is the wind being in a narrow band, and the band is
 * different for the two ways fog forms:
 *
 *   Radiation fog forms in place. The ground radiates heat away under a clear
 *   sky, cools the air touching it to its dewpoint, and a light stir mixes that
 *   cooling up through a layer deep enough to see. Needs night, clear sky, and
 *   wind light but not absent — dead calm makes dew on the grass instead,
 *   because nothing lifts the cooling off the surface. This is valley fog, and
 *   it is what is in the bottom of a hollow at dawn.
 *
 *   Advection fog is carried in. Moist air moves over ground colder than it is
 *   and cools from below as it travels. Needs wind — more of it than radiation
 *   fog tolerates — and does not care about the sky or the hour. This is the
 *   fog that comes off water and the fog that sits on a cold snowpack in
 *   spring.
 *
 * Freezing fog is neither: it is either of the above at or below freezing,
 * where the droplets freeze on contact with the road, the windscreen and the
 * tripod. It is carried as a flag on the kind rather than as a third kind,
 * because it says nothing about how the fog formed and everything about what
 * it will do to you.
 *
 * WHAT IS NOT MODELLED
 *
 * Upslope fog needs the wind's direction against the terrain's aspect; steam
 * fog needs a water temperature. Neither is in the feed, and guessing at them
 * from what is would be inventing a forecast rather than reading one. A hollow
 * or a lake shore will fog when this says it will not.
 */

/* ------------------------------------------------------------------ thresholds */

/*
 * Every number a rule turns on, named and in one place.
 *
 * Not because they are precise — they are bands off a synoptic-meteorology
 * bookshelf, and the boundaries are soft — but because a threshold spelled
 * inline is a threshold nobody can find, argue with, or test.
 */
export const FOG = {
  /** Below this the air is not moving enough to lift the cooling: dew, not fog. */
  calmKmh: 1.5,
  /** Above this a radiation inversion mixes out before it can thicken. */
  radiationWindKmh: 9,
  /** Advection needs air actually moving over the cold surface. */
  advectionWindKmh: [7, 28],
  /** Radiation fog needs the ground to be able to radiate away to space. */
  radiationSky: 45,
  /** Below this, droplets freeze on whatever they land on. */
  freezingC: 0,
  /** A forecast visibility under this is a forecaster saying "fog". */
  visibilityFogM: 1000,
  /** And over this is a forecaster saying "no fog", whatever the model thinks. */
  visibilityClearM: 6000,
};

/**
 * Likelihood from the dewpoint depression alone, before anything modifies it.
 *
 * Bands rather than a curve. A continuous function of depression would imply a
 * precision that a gridded forecast interpolated to your pin does not have, and
 * would still have to be pinned to the same handful of points to be tested.
 */
const DEPRESSION_BANDS = [
  [0.6, 90],
  [1.1, 78],
  [1.7, 62],
  [2.5, 44],
  [3.5, 26],
  [5.0, 12],
];

export function fromDepression(depressionC) {
  if (!Number.isFinite(depressionC) || depressionC < 0) return 0;
  for (const [limit, score] of DEPRESSION_BANDS) if (depressionC <= limit) return score;
  return 3;
}

/* ------------------------------------------------------------------ one hour */

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

/**
 * One hour's worth of fog, from that hour's ingredients.
 *
 * @param {object} hour
 * @param {number} hour.temperatureC
 * @param {number} hour.dewpointC
 * @param {number} hour.windKmh
 * @param {number} hour.skyPercent   0 clear, 100 overcast
 * @param {boolean} hour.night       whether the sun is down at this hour
 * @param {number} [hour.visibilityM] forecast visibility, where the grid has one
 * @returns {{chance: number, kind: 'radiation'|'advection'|'none',
 *            freezing: boolean, depressionC: number|null, why: string,
 *            forecast: boolean}}
 */
export function fogHour({
  temperatureC, dewpointC, windKmh, skyPercent, night, visibilityM = null,
}) {
  const known = [temperatureC, dewpointC, windKmh, skyPercent]
    .every((value) => Number.isFinite(value));
  if (!known) {
    return {
      chance: null, kind: 'none', freezing: false, depressionC: null,
      forecast: false, why: 'the forecast is missing an ingredient for this hour',
    };
  }

  const depressionC = temperatureC - dewpointC;
  const base = fromDepression(depressionC);
  const freezing = temperatureC <= FOG.freezingC;
  const [advectionMin, advectionMax] = FOG.advectionWindKmh;

  let kind = 'none';
  let chance = Math.min(base, 20);
  let why = '';

  if (night && skyPercent <= FOG.radiationSky && windKmh <= FOG.radiationWindKmh) {
    kind = 'radiation';
    chance = base;
    // A clear sky radiates harder than a half-covered one.
    if (skyPercent <= 20) chance += 5;
    /*
     * Dead calm is a penalty, not a bonus, which is the counter-intuitive half
     * of radiation fog: with no stir at all the cooling stays in the top
     * millimetre of grass and you get dew and a clear view over it.
     */
    if (windKmh < FOG.calmKmh) chance -= 12;
    why = `clear sky, light wind and ${depressionC.toFixed(1)}°C of dewpoint depression overnight`;
  } else if (windKmh >= advectionMin && windKmh <= advectionMax && base >= 40) {
    kind = 'advection';
    /*
     * Held below the radiation case at the same depression. Whether the ground
     * downwind is colder than the air over it is the question that decides
     * advection fog, and the feed does not answer it — so this is the ingredient
     * list being suggestive rather than the ingredient list being met.
     */
    chance = base - 12;
    why = `moist air (${depressionC.toFixed(1)}°C depression) moving at ${Math.round(windKmh)} km/h`;
  } else if (base >= 40) {
    why = windKmh > advectionMax
      ? 'the air is nearly saturated but too windy to fog — low cloud and drizzle instead'
      : 'the air is nearly saturated, but the sky or the hour is against fog forming';
  } else {
    why = `${depressionC.toFixed(1)}°C of dewpoint depression — too dry`;
  }

  /*
   * Where a real forecast of fog exists, it wins.
   *
   * Some grids carry a visibility series and most do not. When one does, a
   * forecaster has already turned these same ingredients into a number, with a
   * model and a local knowledge this has neither of. Averaging the two would
   * dilute the better answer with the worse one, so it replaces rather than
   * adjusts — and `forecast` records which of the two the reader is looking at.
   */
  if (Number.isFinite(visibilityM)) {
    if (visibilityM <= FOG.visibilityFogM) {
      chance = Math.max(chance, 85);
      if (kind === 'none') kind = night ? 'radiation' : 'advection';
      return {
        chance: clamp(chance), kind, freezing, depressionC, forecast: true,
        why: `visibility forecast at ${Math.round(visibilityM)} m`,
      };
    }
    if (visibilityM >= FOG.visibilityClearM) {
      return {
        chance: Math.min(clamp(chance), 10), kind: 'none', freezing, depressionC, forecast: true,
        why: `visibility forecast at ${(visibilityM / 1000).toFixed(1)} km — clear`,
      };
    }
  }

  return { chance: clamp(chance), kind, freezing, depressionC, forecast: false, why };
}

/* ------------------------------------------------------------------ naming */

const KIND_NAMES = {
  radiation: 'Ground fog',
  advection: 'Drifting fog',
  none: 'No fog',
};

const KIND_NOTES = {
  radiation: 'Cools into place overnight and sits in hollows and river bottoms. '
    + 'Burns off within an hour or two of the sun reaching it.',
  advection: 'Carried in on the wind from somewhere wetter or warmer. '
    + 'Does not burn off on schedule — it leaves when the wind changes.',
  none: '',
};

/** What to call it, freezing included, in the words a driver would use. */
export function fogName({ kind, freezing }) {
  if (kind === 'none') return KIND_NAMES.none;
  return freezing ? `Freezing ${KIND_NAMES[kind].toLowerCase()}` : KIND_NAMES[kind];
}

export function fogNote({ kind, freezing }) {
  const note = KIND_NOTES[kind] || '';
  if (!freezing || kind === 'none') return note;
  return `${note} At or below freezing the droplets freeze on contact — expect ice on the road, `
    + 'the windscreen and anything left outside.';
}

/**
 * Four words for a number, because a percentage on a modelled likelihood
 * invites more confidence than the model has.
 */
export function fogBand(chance) {
  if (!Number.isFinite(chance)) return 'unknown';
  if (chance >= 70) return 'likely';
  if (chance >= 45) return 'possible';
  if (chance >= 20) return 'unlikely';
  return 'no';
}

/* ------------------------------------------------------------------ a run of hours */

/**
 * The next stretch of hours, and the one worth knowing about.
 *
 * The peak is what a card leads with, but the peak alone is a time without a
 * shape: "62% at 05:00" does not say whether that is a half-hour of mist or a
 * dawn you will not be driving out of. So the run containing the peak is
 * returned with it — when it starts, when it ends, and how it is trending.
 *
 * @param {Array} hours rows of {at: Date, ...fogHour input}
 * @param {object} [options]
 * @param {Date} [options.now] hours before this are dropped as already past
 * @param {number} [options.horizonHours] how far ahead to look
 */
export function fogOutlook(hours, { now = new Date(), horizonHours = 36 } = {}) {
  const limit = now.valueOf() + horizonHours * 3600000;
  const rows = (hours || [])
    .filter((hour) => hour.at instanceof Date && Number.isFinite(hour.at.valueOf()))
    .filter((hour) => hour.at.valueOf() >= now.valueOf() - 3600000 && hour.at.valueOf() <= limit)
    .map((hour) => ({ ...hour, ...fogHour(hour) }))
    .sort((a, b) => a.at - b.at);

  if (!rows.length) return { ok: false, reason: 'no forecast hours in range', rows: [] };

  const scored = rows.filter((row) => Number.isFinite(row.chance));
  if (!scored.length) return { ok: false, reason: 'the forecast is missing what fog needs', rows };

  const peak = scored.reduce((best, row) => (row.chance > best.chance ? row : best), scored[0]);

  /*
   * The run around the peak, not every hour over a threshold.
   *
   * A night can fog at 04:00, clear at noon and fog again the following
   * evening, and reporting "fog from 04:00 to 22:00" because both ends cross a
   * line would be false. So the window walks outward from the peak and stops at
   * the first hour that does not qualify.
   */
  const qualifies = (row) => Number.isFinite(row.chance) && row.chance >= 45;
  let first = rows.indexOf(peak);
  let last = first;
  if (qualifies(peak)) {
    while (first > 0 && qualifies(rows[first - 1])) first -= 1;
    while (last < rows.length - 1 && qualifies(rows[last + 1])) last += 1;
  }

  return {
    ok: true,
    rows,
    peak,
    from: rows[first].at,
    to: rows[last].at,
    hours: last - first + 1,
    /* Whether any of it came from a published visibility rather than this model. */
    forecast: rows.slice(first, last + 1).some((row) => row.forecast),
  };
}

/**
 * Night, for an hour rather than for a day.
 *
 * `sunTimes` answers for a calendar date; a run of forecast hours crosses
 * several, and the hour after midnight belongs to the night that started the
 * evening before. Comparing each hour against its own date's sunrise and sunset
 * gets that right without any date arithmetic at the call site.
 *
 * @param {(date: Date, lat: number, lon: number) => object} sunTimes
 */
export function nightHours(hours, lat, lon, sunTimes) {
  return (hours || []).map((hour) => {
    const times = sunTimes(hour.at, lat, lon);
    let night;
    if (times.polar === 'day') night = false;
    else if (times.polar === 'night') night = true;
    else night = hour.at < times.sunrise || hour.at >= times.sunset;
    return { ...hour, night };
  });
}
