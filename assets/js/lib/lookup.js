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

/**
 * Hourly cloud cover, for deciding whether tonight is worth driving out for.
 *
 * The plain forecast gives prose — "Mostly Clear then Partly Cloudy" — which is
 * unusable for scoring a two-hour window at one in the morning. The gridpoint
 * endpoint behind that forecast publishes the raw `skyCover` series the words
 * were written from: percentages, hour by hour, a week out.
 *
 * Values arrive as ISO 8601 intervals — "2026-08-24T01:00:00+00:00/PT3H" means
 * this value holds for three hours — so each is expanded into the hours it
 * covers rather than being read as a single point.
 *
 * @returns {Promise<{ok: true, hours: {at: Date, cover: number}[]}
 *                 | {ok: false, reason: string}>}
 */
export async function skyCover(position) {
  const grid = await gridSeries(position, ['skyCover']);
  if (!grid.ok) return grid;

  const values = grid.series.skyCover;
  if (!values?.length) return { ok: false, reason: 'no cloud cover is published for this point' };

  return { ok: true, hours: values.map((row) => ({ at: row.at, cover: row.value })) };
}

/*
 * The units NWS publishes gridpoint values in, and what this app wants them in.
 *
 * Every value in a gridpoint payload carries its own `uom`, so the unit is
 * knowable rather than assumable — which matters because the obvious assumption
 * is wrong in a way that would go unnoticed: temperatures come in Celsius even
 * from a service whose prose forecasts are in Fahrenheit, and a dewpoint
 * depression computed across a mismatch is a plausible-looking number that is
 * simply not the thing it claims to be.
 *
 * Anything not listed is passed through unconverted, with its unit reported, so
 * a caller can tell "this is metres" from "this is whatever the feed said".
 */
const UNIT_CONVERSIONS = {
  'wmoUnit:degF': { to: 'degC', apply: (value) => (value - 32) * (5 / 9) },
  'wmoUnit:K': { to: 'degC', apply: (value) => value - 273.15 },
  'wmoUnit:m_s-1': { to: 'km_h-1', apply: (value) => value * 3.6 },
  'wmoUnit:[mi_i]_h-1': { to: 'km_h-1', apply: (value) => value * 1.609344 },
  'wmoUnit:[nmi_i]_h-1': { to: 'km_h-1', apply: (value) => value * 1.852 },
  'wmoUnit:[mi_i]': { to: 'm', apply: (value) => value * 1609.344 },
  'wmoUnit:km': { to: 'm', apply: (value) => value * 1000 },
};

const CANONICAL = {
  'wmoUnit:degC': 'degC',
  'wmoUnit:km_h-1': 'km_h-1',
  'wmoUnit:m': 'm',
  'wmoUnit:percent': 'percent',
};

/** One series of a gridpoint payload, expanded to hours and put into our units. */
export function expandSeries(field) {
  const uom = field?.uom || '';
  const conversion = UNIT_CONVERSIONS[uom];
  const unit = conversion?.to || CANONICAL[uom] || uom;
  const rows = [];

  for (const entry of field?.values || []) {
    const [start, duration] = String(entry.validTime || '').split('/');
    const from = new Date(start);
    if (!Number.isFinite(from.valueOf())) continue;

    const raw = entry.value;
    const value = Number.isFinite(raw) ? (conversion ? conversion.apply(raw) : raw) : null;

    const span = parseISODuration(duration);
    for (let hour = 0; hour < span; hour += 1) {
      rows.push({ at: new Date(from.valueOf() + hour * 3600000), value });
    }
  }

  return { unit, rows };
}

/**
 * Several gridpoint series from one fetch.
 *
 * The gridpoint payload is one document carrying forty-odd series, and it is
 * the same document behind the cloud cover the Milky Way card reads and the
 * temperature, dewpoint and wind that fog needs. Fetching it once per question
 * would be two round trips through the point lookup for one answer, on a page
 * that is often on a phone at the edge of coverage.
 *
 * @param {[number, number]} position
 * @param {string[]} fields gridpoint property names, e.g. ['temperature']
 * @returns {Promise<{ok: true, series: Record<string, {at: Date, value: number|null}[]>,
 *                    units: Record<string, string>}
 *                 | {ok: false, reason: string}>}
 */
export async function gridSeries([lon, lat], fields) {
  const point = await fetchJSON(`${WEATHER_ROOT}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);

  if (!point.ok) {
    if (point.status === 404) {
      return { ok: false, reason: 'the National Weather Service only covers the United States' };
    }
    return { ok: false, reason: point.reason };
  }

  const gridURL = point.data?.properties?.forecastGridData;
  if (!gridURL) return { ok: false, reason: 'no gridded forecast is published for this point' };

  const grid = await fetchJSON(gridURL);
  if (!grid.ok) return { ok: false, reason: grid.reason };

  const properties = grid.data?.properties || {};
  const series = {};
  const units = {};
  for (const field of fields) {
    const expanded = expandSeries(properties[field]);
    series[field] = expanded.rows;
    units[field] = expanded.unit;
  }

  return { ok: true, series, units };
}

/**
 * Everything fog is worked out from, on one timeline.
 *
 * Zipped here rather than in the fog model, because lining up four series that
 * each publish their own run-length-encoded intervals is a property of this
 * feed, not of meteorology — and the model is far easier to test against plain
 * rows than against four interleaved interval lists.
 *
 * `visibility` is asked for and very often absent: most land grids do not
 * publish it. That is not an error, and a missing series simply leaves the
 * hour's visibility null, which the model reads as "no forecaster has said".
 */
export async function fogIngredients(position) {
  const grid = await gridSeries(position,
    ['temperature', 'dewpoint', 'windSpeed', 'skyCover', 'visibility']);
  if (!grid.ok) return grid;

  /*
   * Every hour carries every key, whether or not the grid published the series.
   *
   * A missing series would otherwise leave the key absent rather than null.
   * The model reads both the same way — neither is a finite number — but one of
   * them prints as a row with a hole in it when something goes wrong, and the
   * shape of a row should not depend on which optional series this particular
   * office happens to publish.
   */
  const FIELDS = [
    ['temperature', 'temperatureC'],
    ['dewpoint', 'dewpointC'],
    ['windSpeed', 'windKmh'],
    ['skyCover', 'skyPercent'],
    ['visibility', 'visibilityM'],
  ];

  const byHour = new Map();
  const row = (at) => {
    const stamp = at.valueOf();
    if (!byHour.has(stamp)) {
      byHour.set(stamp, { at, ...Object.fromEntries(FIELDS.map(([, key]) => [key, null])) });
    }
    return byHour.get(stamp);
  };

  for (const [field, key] of FIELDS) {
    for (const entry of grid.series[field] || []) row(entry.at)[key] = entry.value;
  }

  const hours = [...byHour.values()].sort((a, b) => a.at - b.at);
  if (!hours.length) return { ok: false, reason: 'no gridded forecast is published for this point' };

  return { ok: true, hours, units: grid.units };
}

/**
 * Hours in an ISO 8601 duration like PT6H, P1DT3H, PT30M.
 *
 * Only whole hours matter here — the series is hourly at its finest — so a
 * sub-hour duration still covers the hour it starts in.
 */
export function parseISODuration(duration = '') {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration.trim());
  if (!match) return 1;
  const [, days, hours, minutes] = match;
  const total = (Number(days || 0) * 24) + Number(hours || 0) + (Number(minutes || 0) / 60);
  return Math.max(1, Math.round(total));
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

/**
 * Turn a GeoServer JSON legend into a list of swatches.
 *
 * The weather layers used to carry a picture of their key — a PNG fetched from
 * GeoServer and scaled into the panel — while the radar layer drew a list of
 * coloured squares written out in the catalogue. Two layers in the same group
 * explaining themselves two different ways, and the picture was the harder of
 * the two to read.
 *
 * Asking GeoServer for `format=application/json` returns the same key as data,
 * so the list can be drawn the way radar's is without NOAA's palette being
 * copied into this repository — where it would be wrong the first time they
 * restyle a layer, silently, and stay wrong.
 *
 * The shape, from the live service:
 *
 *   {"Legend":[{"layerName":"sky","rules":[{"symbolizers":[{"Raster":
 *     {"colormap":{"entries":[{"label":"0","quantity":"0","color":"#000000"}]}}
 *   }]}]}]}
 *
 * @returns {{color: string, label: string}[]}
 */
export function parseWMSLegend(body) {
  const entries = [];
  for (const legend of body?.Legend || []) {
    for (const rule of legend.rules || []) {
      for (const symbolizer of rule.symbolizers || []) {
        for (const entry of symbolizer?.Raster?.colormap?.entries || []) {
          entries.push(entry);
        }
      }
    }
  }

  const seen = new Set();
  return entries
    /*
     * Two kinds of entry are in the data but not in the key.
     *
     * Temperature's colormap opens with `{"label":"","quantity":"-500"}` — a
     * nodata sentinel, not a temperature anybody will encounter — and
     * transparent entries mark the gaps in coverage. Both would draw as a row
     * with an empty label beside a swatch of nothing.
     */
    .filter((entry) => String(entry.label ?? '').trim() && Number(entry.opacity ?? 1) > 0)
    .map((entry) => ({ color: entry.color || 'transparent', label: String(entry.label).trim() }))
    // A ramp often repeats a colour across neighbouring steps; the same swatch
    // and the same text twice in a column reads as a rendering fault.
    .filter((entry) => {
      const key = `${entry.color}|${entry.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Turn an ArcGIS legend document into rows the panel can draw.
 *
 * The shape is `{layers: [{layerId, layerName, legend: [{label, imageData}]}]}`,
 * and the interesting decision is which of those two names to show.
 *
 * A service that draws one thing per sublayer labels its single class
 * generically — BLM's route layers all say "Transportation System - Road" —
 * while the sublayer itself is called "Roads Managed for Limited Public
 * Motorized Use". Flattening the classes there produces four identical rows and
 * throws away the only part anybody needed. So a sublayer contributing exactly
 * one class is labelled by its own name.
 *
 * Where a sublayer has several classes, those classes are the distinctions —
 * the MVUM's seasonal and vehicle-width rows — and the sublayer name would be
 * the thing that says nothing. So they win instead.
 *
 * @param layer optional sublayer id; without it, every sublayer is included.
 * @returns {{label: string, imageData: string, contentType: string}[]}
 */
export function arcgisLegendRows(body, layer) {
  const layers = (body?.layers || []).filter(
    (entry) => typeof layer !== 'number' || entry.layerId === layer,
  );

  const rows = [];
  for (const entry of layers) {
    const classes = (entry.legend || []).filter((item) => item.imageData);
    if (!classes.length) continue;

    const single = classes.length === 1;
    for (const item of classes) {
      const label = single
        ? (entry.layerName || item.label || '')
        : (item.label || entry.layerName || '');
      // A swatch with nothing beside it reads as a rendering fault. Both the
      // MVUM and GTLF keys publish one.
      if (!String(label).trim()) continue;
      rows.push({
        label: String(label).trim(),
        imageData: item.imageData,
        contentType: item.contentType || 'image/png',
      });
    }
  }
  return rows;
}
