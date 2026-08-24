/**
 * Point lookups: who manages this land, and what the weather will do.
 *
 * Both hit third-party services that could not be reached from the sandbox
 * this was written in, so both report failure in terms a person can act on
 * rather than returning null and leaving a blank panel. The endpoints are
 * configurable for the same reason agency GIS URLs are configurable elsewhere
 * in this app: they move.
 */

import { LAND_LOOKUPS } from '../config.js';

const WEATHER_ROOT = 'https://api.weather.gov';

/** Abort a request that is taking longer than a person will wait. */
async function fetchJSON(url, { timeout = 12000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    return { ok: true, data: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason: error.name === 'AbortError' ? 'the service did not answer in time' : 'could not reach the service',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ land */

/**
 * The first non-empty field from a feature's attributes.
 *
 * Agency layers name the same concept a dozen ways — ADMIN_AGENCY_CODE,
 * agency_name, Manager, MANAGING_AGENCY — and the names change between service
 * versions, so match loosely rather than pinning to one schema that will rot.
 */
function pickAttribute(attributes, patterns) {
  for (const pattern of patterns) {
    for (const [key, value] of Object.entries(attributes || {})) {
      if (!pattern.test(key)) continue;
      const text = String(value ?? '').trim();
      if (text && text.toLowerCase() !== 'null' && text !== '<Null>') return text;
    }
  }
  return '';
}

// Ordered most specific first, since the first match wins. The abbreviated
// forms are not optional extras: PAD-US calls this Mang_Name and BLM calls it
// ADM_MANAGE, so a pattern list that only knew the full word "manager" would
// match neither — which is precisely what happened the first time.
const AGENCY_PATTERNS = [
  /mang_?(name|type)/i, /^mang/i, /mgr/i, /manage/i,
  /agency/i, /owner/i, /admin/i, /jurisdiction/i, /steward/i,
];
const UNIT_PATTERNS = [
  /unit_?n(a)?m(e)?/i, /area_?name/i, /loc_?name/i, /^name$/i,
  /forest/i, /district/i, /d_?des_?tp/i,
];
const ACCESS_PATTERNS = [/pub_?access/i, /public_?access/i, /access/i];

/** Expand the abbreviations these datasets use, which are otherwise opaque. */
const AGENCY_NAMES = {
  BLM: 'Bureau of Land Management',
  USFS: 'US Forest Service',
  FS: 'US Forest Service',
  NPS: 'National Park Service',
  FWS: 'US Fish & Wildlife Service',
  USFWS: 'US Fish & Wildlife Service',
  DOD: 'Department of Defense',
  BOR: 'Bureau of Reclamation',
  TVA: 'Tennessee Valley Authority',
  STAT: 'State',
  SLB: 'State Trust Land',
  PVT: 'Private',
  UNK: 'Unknown',
};

export function expandAgency(value) {
  const key = String(value || '').trim().toUpperCase();
  return AGENCY_NAMES[key] || value;
}

/**
 * Who manages the land under a point.
 *
 * Tries each configured service in turn and returns the first that answers with
 * a feature. Returns a reason rather than null when every service fails, so the
 * panel can say whether nothing owns this point or nothing could be asked.
 *
 * @returns {Promise<{ok: true, agency: string, unit: string, access: string, source: string}
 *                 | {ok: false, reason: string}>}
 */
export async function landManager([lon, lat]) {
  if (!LAND_LOOKUPS.length) return { ok: false, reason: 'no land-ownership service is configured' };

  // Two different outcomes wear the same failure today, and they mean opposite
  // things. A service that answered and found nothing is working correctly —
  // the point is simply not on land it maps. A service that could not be asked
  // is a configuration problem. Reporting both as errors made a working lookup
  // over private land read as a broken feature.
  const unreachable = [];
  const answeredEmpty = [];

  for (const service of LAND_LOOKUPS) {
    // The explicit JSON geometry form rather than the `x,y` shorthand. Both are
    // documented, but the shorthand relies on the service inferring the spatial
    // reference and some reject it outright — BLM answered "Invalid or missing
    // input parameters" to the short form and accepts this one. `where=1=1` is
    // here for the same reason: harmless where it is redundant, required by
    // services that will not run a query without a where clause.
    const geometry = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
    const url = `${service.url}/query`
      + `?geometry=${encodeURIComponent(geometry)}`
      + '&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects'
      + `&where=${encodeURIComponent('1=1')}`
      + '&outFields=*&returnGeometry=false&f=json';

    const result = await fetchJSON(url);
    if (!result.ok) { unreachable.push(`${service.name} (${result.reason})`); continue; }

    // ArcGIS reports its own errors inside a 200 response.
    if (result.data?.error) {
      unreachable.push(`${service.name} (${result.data.error.message || 'service error'})`);
      continue;
    }

    const feature = (result.data?.features || [])[0];
    if (!feature) { answeredEmpty.push(service.name); continue; }

    const attributes = feature.attributes || {};
    return {
      ok: true,
      agency: expandAgency(pickAttribute(attributes, AGENCY_PATTERNS)),
      unit: pickAttribute(attributes, UNIT_PATTERNS),
      access: pickAttribute(attributes, ACCESS_PATTERNS),
      source: service.name,
    };
  }

  // A service answering with nothing is the ordinary case over private land, so
  // lead with that and mention the broken ones only as a footnote — they are
  // for whoever maintains the configuration, not for someone standing at a pin.
  if (answeredEmpty.length) {
    return {
      ok: false,
      empty: true,
      reason: 'no public land mapped at this point — most likely private',
      checked: answeredEmpty,
      unreachable,
    };
  }

  return {
    ok: false,
    empty: false,
    reason: unreachable.length
      ? `no service could answer — ${unreachable.join('; ')}`
      : 'no land-ownership service answered',
    checked: [],
    unreachable,
  };
}

/**
 * Is this agency a public land manager, and which kind?
 *
 * The question behind "who manages this" is almost always "can I camp here",
 * and an agency name alone does not answer it for someone who does not already
 * know that BOR is federal and SLB usually is not.
 */
export function publicLand(agency = '', access = '') {
  const text = `${agency}`.toLowerCase();
  const closed = /closed|restricted|no public/i.test(access);

  const FEDERAL = [
    ['bureau of land management', 'BLM'], ['forest service', 'USFS'],
    ['national park', 'NPS'], ['fish & wildlife', 'USFWS'], ['fish and wildlife', 'USFWS'],
    ['reclamation', 'BOR'], ['army corps', 'USACE'], ['tennessee valley', 'TVA'],
    ['department of defense', 'DOD'],
  ];
  for (const [needle, short] of FEDERAL) {
    if (text.includes(needle)) return { public: !closed, level: 'Federal', short, closed };
  }
  if (/\bstate\b|state of |state trust|wildlife management area/.test(text)) {
    return { public: !closed, level: 'State', short: 'State', closed };
  }
  if (/county|municipal|city of|regional park/.test(text)) {
    return { public: !closed, level: 'Local', short: 'Local', closed };
  }
  if (/private|inholding|corporation|timber|llc|\binc\b/.test(text)) {
    return { public: false, level: 'Private', short: 'Private', closed: true };
  }
  return { public: false, level: '', short: '', closed: false };
}

/* ------------------------------------------------------------------ weather */

/**
 * Forecast from the US National Weather Service.
 *
 * Two requests by design: /points resolves a coordinate to a forecast grid and
 * the nearest reporting town, and the grid URL it returns is the one that
 * carries the periods. Free, no key, and US-only — outside the US /points
 * returns 404, which is reported as such rather than as a failure.
 *
 * @returns {Promise<{ok: true, place: string, periods: object[], updated: string}
 *                 | {ok: false, reason: string}>}
 */
export async function forecast([lon, lat]) {
  const point = await fetchJSON(`${WEATHER_ROOT}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);

  if (!point.ok) {
    if (point.status === 404) {
      return { ok: false, reason: 'the National Weather Service only covers the United States' };
    }
    return { ok: false, reason: point.reason };
  }

  const properties = point.data?.properties || {};
  const forecastURL = properties.forecast;
  if (!forecastURL) return { ok: false, reason: 'no forecast is published for this point' };

  const relative = properties.relativeLocation?.properties;
  const place = relative ? [relative.city, relative.state].filter(Boolean).join(', ') : '';

  const detail = await fetchJSON(forecastURL);
  if (!detail.ok) return { ok: false, reason: detail.reason };

  const periods = (detail.data?.properties?.periods || []).slice(0, 6).map((period) => ({
    name: period.name,
    isDaytime: period.isDaytime,
    temperature: period.temperature,
    unit: period.temperatureUnit,
    short: period.shortForecast,
    detailed: period.detailedForecast,
    wind: [period.windSpeed, period.windDirection].filter(Boolean).join(' '),
    precipitation: period.probabilityOfPrecipitation?.value ?? null,
  }));

  if (!periods.length) return { ok: false, reason: 'the forecast came back empty' };

  return { ok: true, place, periods, updated: detail.data?.properties?.updated || '' };
}

/**
 * A coarse condition class for a forecast summary, used to pick an icon.
 *
 * The NWS short forecast is free text ("Chance Showers And Thunderstorms Then
 * Partly Sunny"), so this matches keywords in severity order — thunder before
 * rain, because a line mentioning both is a thunderstorm.
 */
export function weatherClass(short = '') {
  const text = short.toLowerCase();
  if (/thunder|t-storm/.test(text)) return 'thunder';
  if (/snow|flurr|sleet|winter|ice|freezing/.test(text)) return 'snow';
  if (/rain|shower|drizzle/.test(text)) return 'rain';
  if (/fog|haze|smoke/.test(text)) return 'fog';
  if (/wind|breezy|blustery/.test(text)) return 'wind';
  if (/cloud|overcast/.test(text)) return 'cloud';
  if (/partly|mostly sunny|few clouds/.test(text)) return 'partly';
  if (/sun|clear|fair/.test(text)) return 'clear';
  return 'cloud';
}

/* ------------------------------------------------------------------ elevation */

/**
 * Ground elevation at a point, from the USGS Elevation Point Query Service.
 *
 * A dropped pin has no elevation of its own — an imported GPX waypoint carries
 * one, a place you tapped on the map does not — and "how high is this saddle"
 * is most of why you tapped it. US coverage only, like the weather.
 *
 * @returns {Promise<{ok: true, metres: number}|{ok: false, reason: string}>}
 */
export async function elevation([lon, lat]) {
  const url = 'https://epqs.nationalmap.gov/v1/json'
    + `?x=${lon.toFixed(6)}&y=${lat.toFixed(6)}&units=Meters&wkid=4326&includeDate=false`;

  const result = await fetchJSON(url);
  if (!result.ok) return { ok: false, reason: result.reason };

  const raw = result.data?.value ?? result.data?.location?.z;
  const metres = typeof raw === 'string' ? Number(raw) : raw;

  // The service answers -1000000 for points it has no data for rather than
  // failing, which would otherwise render as a plausible-looking depth.
  if (!Number.isFinite(metres) || metres <= -999999) {
    return { ok: false, reason: 'no elevation data covers this point' };
  }
  return { ok: true, metres };
}
