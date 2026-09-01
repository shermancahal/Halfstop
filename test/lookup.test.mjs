/**
 * Tests for the point lookups.
 *
 * The land lookup exists because agency GIS layers name the same concept a
 * dozen ways, and the first version of it matched none of the real ones: it
 * looked for the word "manager" while PAD-US calls the field Mang_Name. These
 * fix the actual field names in place so that regression cannot repeat.
 *
 * fetch is stubbed throughout — neither service was reachable from the sandbox
 * this was written in, and a test that needs the internet is a test that fails
 * for reasons unrelated to the code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  landManager,
  forecast,
  weatherClass,
  expandAgency,
  parseISODuration,
  parseWMSLegend,
  arcgisLegendRows,
  expandSeries,
  fogIngredients,
} from '../assets/js/lib/lookup.js';

/** Replace global fetch for one test, restoring it afterwards. */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const result = handler(String(url));
    if (result === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => result };
  };
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

const POINT = [-84.2807, 35.9606];

/* ------------------------------------------------------------------ land */

test('land: reads PAD-US field names', () => withFetch(
  () => ({ features: [{ attributes: { Mang_Name: 'USFS', Unit_Nm: 'Cherokee National Forest', Pub_Access: 'Open Access' } }] }),
  async () => {
    const result = await landManager(POINT);
    assert.equal(result.ok, true);
    assert.equal(result.agency, 'US Forest Service', 'Mang_Name must be recognised');
    assert.equal(result.unit, 'Cherokee National Forest');
    assert.equal(result.access, 'Open Access');
  },
));

test('land: reads BLM field names', () => withFetch(
  () => ({ features: [{ attributes: { ADM_MANAGE: 'BLM', ADM_UNIT_NAME: 'Moab Field Office' } }] }),
  async () => {
    const result = await landManager(POINT);
    assert.equal(result.agency, 'Bureau of Land Management');
    assert.equal(result.unit, 'Moab Field Office');
  },
));

test('land: reads a state layer naming things differently again', () => withFetch(
  () => ({ features: [{ attributes: { OWNER_NAME: 'State of Utah', AREA_NAME: 'Goblin Valley' } }] }),
  async () => {
    const result = await landManager(POINT);
    assert.equal(result.agency, 'State of Utah');
    assert.equal(result.unit, 'Goblin Valley');
  },
));

test('land: null-ish attribute values are skipped, not shown', () => withFetch(
  () => ({ features: [{ attributes: { Mang_Name: '<Null>', ADM_MANAGE: 'NPS', Unit_Nm: '  ' } }] }),
  async () => {
    const result = await landManager(POINT);
    assert.equal(result.agency, 'National Park Service');
    assert.equal(result.unit, '');
  },
));

test('land: an ArcGIS error inside a 200 is treated as a failure', () => withFetch(
  () => ({ error: { message: 'Invalid or missing input parameters.' } }),
  async () => {
    const result = await landManager(POINT);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Invalid or missing input/);
  },
));

test('land: falls through to the next service when the first has no feature', () => {
  let calls = 0;
  return withFetch(
    () => {
      calls++;
      return calls === 1 ? { features: [] } : { features: [{ attributes: { Mang_Name: 'BLM' } }] };
    },
    async () => {
      const result = await landManager(POINT);
      assert.equal(calls, 2, 'the second service should be tried');
      assert.equal(result.agency, 'Bureau of Land Management');
    },
  );
});

test('land: a service that answers with nothing is not reported as broken', () => withFetch(
  () => ({ features: [] }),
  async () => {
    // Every service answering and finding nothing is the ordinary case over
    // private land. Reporting it as a list of failures made a working lookup
    // read as a broken feature.
    const result = await landManager(POINT);
    assert.equal(result.ok, false);
    assert.equal(result.empty, true);
    assert.match(result.reason, /most likely private/);
    assert.equal(result.unreachable.length, 0);
    assert.ok(result.checked.length > 0, 'it should name what it asked');
  },
));

test('land: a service that could not be asked is reported as such', () => withFetch(
  () => ({ error: { message: 'Invalid URL' } }),
  async () => {
    const result = await landManager(POINT);
    assert.equal(result.ok, false);
    assert.equal(result.empty, false);
    assert.match(result.reason, /no service could answer/);
    assert.ok(result.unreachable.some((entry) => /Invalid URL/.test(entry)));
  },
));

test('land: one broken service does not mask another answering correctly', () => {
  /*
   * What was actually seen in the field: a misconfigured service ahead of a
   * working one that finds nothing. The verdict has to come from the one that
   * worked, not from the one that broke first.
   *
   * The first call fails and every later one answers, rather than a fixed
   * count of failures, because this test should not need editing when a dead
   * service is removed from the list - which is exactly what happened to the
   * PAD-US entry, and it took this test down with it.
   */
  let call = 0;
  return withFetch(
    () => {
      call += 1;
      if (call === 1) return { error: { message: 'Invalid or missing input parameters.' } };
      return { features: [] };
    },
    async () => {
      const result = await landManager(POINT);
      assert.equal(result.empty, true, 'the working service decides the verdict');
      assert.match(result.reason, /most likely private/);
      assert.equal(result.unreachable.length, 1, 'the broken one is still recorded');
    },
  );
});

test('land: the query uses the JSON geometry form ArcGIS accepts everywhere', () => {
  // BLM rejected the `x,y` shorthand with "Invalid or missing input
  // parameters"; the explicit form with a spatial reference works.
  let requested = '';
  return withFetch(
    (url) => { requested = url; return { features: [{ attributes: { Mang_Name: 'BLM' } }] }; },
    async () => {
      await landManager(POINT);
      const geometry = JSON.parse(decodeURIComponent(/[?&]geometry=([^&]+)/.exec(requested)[1]));
      assert.equal(geometry.x, POINT[0]);
      assert.equal(geometry.y, POINT[1]);
      assert.equal(geometry.spatialReference.wkid, 4326);
      assert.match(requested, /geometryType=esriGeometryPoint/);
      assert.match(requested, /where=1%3D1/, 'services that require a where clause need one');
    },
  );
});

test('land: agency codes expand, unknown ones pass through untouched', () => {
  assert.equal(expandAgency('NPS'), 'National Park Service');
  assert.equal(expandAgency('blm'), 'Bureau of Land Management');
  assert.equal(expandAgency('Weyerhaeuser'), 'Weyerhaeuser');
  assert.equal(expandAgency(''), '');
});

/* ------------------------------------------------------------------ weather */

const POINTS_RESPONSE = {
  properties: {
    forecast: 'https://api.weather.gov/gridpoints/MRX/60,40/forecast',
    relativeLocation: { properties: { city: 'Townsend', state: 'TN' } },
  },
};

const FORECAST_RESPONSE = {
  properties: {
    updated: '2026-08-23T12:00:00Z',
    periods: [
      {
        name: 'This Afternoon', isDaytime: true, temperature: 84, temperatureUnit: 'F',
        shortForecast: 'Chance Showers And Thunderstorms', detailedForecast: 'A chance of showers.',
        windSpeed: '5 to 10 mph', windDirection: 'SW', probabilityOfPrecipitation: { value: 60 },
      },
      { name: 'Tonight', isDaytime: false, temperature: 63, temperatureUnit: 'F', shortForecast: 'Mostly Cloudy' },
    ],
  },
};

test('weather: resolves a point to a forecast in two requests', () => {
  const seen = [];
  return withFetch(
    (url) => {
      seen.push(url);
      return url.includes('/points/') ? POINTS_RESPONSE : FORECAST_RESPONSE;
    },
    async () => {
      const result = await forecast(POINT);
      assert.equal(result.ok, true);
      assert.equal(seen.length, 2, '/points then the grid URL it hands back');
      assert.match(seen[0], /\/points\/35\.9606,-84\.2807/);
      assert.equal(result.place, 'Townsend, TN');
      assert.equal(result.periods[0].temperature, 84);
      assert.equal(result.periods[0].wind, '5 to 10 mph SW');
      assert.equal(result.periods[0].precipitation, 60);
    },
  );
});

test('weather: outside the US it says so instead of failing vaguely', () => withFetch(
  () => null,   // /points answers 404 off-coverage
  async () => {
    const result = await forecast([2.35, 48.86]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /only covers the United States/);
  },
));

test('weather: an empty period list is a failure, not an empty panel', () => withFetch(
  (url) => (url.includes('/points/') ? POINTS_RESPONSE : { properties: { periods: [] } }),
  async () => {
    const result = await forecast(POINT);
    assert.equal(result.ok, false);
    assert.match(result.reason, /came back empty/);
  },
));

test('weather: conditions classify by severity, not by first match', () => {
  // "Showers And Thunderstorms" mentions both; a line with thunder is a
  // thunderstorm, so thunder has to win.
  assert.equal(weatherClass('Chance Showers And Thunderstorms'), 'thunder');
  assert.equal(weatherClass('Rain And Snow'), 'snow');
  assert.equal(weatherClass('Partly Sunny'), 'partly');
  assert.equal(weatherClass('Sunny'), 'clear');
  assert.equal(weatherClass('Patchy Fog'), 'fog');
  assert.equal(weatherClass(''), 'cloud');
});

/* --------------------------------------------------------------- sky cover */

test('an ISO 8601 duration becomes whole hours', () => {
  // NWS gridpoint values carry the span they hold for, and a six-hour value has
  // to fill six hours or a night-time window falls into a gap and scores as
  // unknown when the forecast plainly covers it.
  assert.equal(parseISODuration('PT1H'), 1);
  assert.equal(parseISODuration('PT6H'), 6);
  assert.equal(parseISODuration('P1DT3H'), 27);
  assert.equal(parseISODuration('P2D'), 48);
  // Sub-hour values still cover the hour they start in rather than vanishing.
  assert.equal(parseISODuration('PT30M'), 1);
  // Anything unparseable is one hour, never zero — zero would drop the reading.
  assert.equal(parseISODuration(''), 1);
  assert.equal(parseISODuration('nonsense'), 1);
});

/*
 * The GeoServer colour scales.
 *
 * Shape captured from the live NDFD service in CI, not written from the
 * documentation — the first attempt at reading it guessed the key names and
 * matched nothing, which is the whole argument for probing before building.
 */
const skyLegend = {
  Legend: [{
    layerName: 'sky',
    rules: [{
      symbolizers: [{
        Raster: {
          colormap: {
            entries: [
              { label: '0', quantity: '0', color: '#FFFFFF' },
              { label: '25', quantity: '25', color: '#D0D8E0' },
              { label: '50', quantity: '50', color: '#A0B0C0' },
              { label: '100', quantity: '100', color: '#607080' },
            ],
          },
        },
      }],
    }],
  }],
};

test('legend: a colormap becomes swatches with the service own colours', () => {
  assert.deepEqual(parseWMSLegend(skyLegend), [
    { color: '#FFFFFF', label: '0' },
    { color: '#D0D8E0', label: '25' },
    { color: '#A0B0C0', label: '50' },
    { color: '#607080', label: '100' },
  ]);
});

test('legend: the nodata sentinel and transparent steps are not in the key', () => {
  /*
   * Temperature opens its colormap with {"label":"","quantity":"-500"}, which
   * is nodata rather than a temperature anyone will stand in, and coverage gaps
   * come through fully transparent. Both would draw as a row with no text
   * beside a swatch of nothing.
   */
  const withSentinels = {
    Legend: [{
      rules: [{
        symbolizers: [{
          Raster: {
            colormap: {
              entries: [
                { label: '', quantity: '-500', color: '#000000' },
                { label: '  ', quantity: '-499', color: '#000000' },
                { label: '-40', quantity: '-40', color: '#2B2BFF' },
                { label: 'gap', quantity: '0', color: '#000000', opacity: '0' },
                { label: '110', quantity: '110', color: '#FF2B2B' },
              ],
            },
          },
        }],
      }],
    }],
  };
  assert.deepEqual(parseWMSLegend(withSentinels), [
    { color: '#2B2BFF', label: '-40' },
    { color: '#FF2B2B', label: '110' },
  ]);
});

test('legend: a step repeated in the ramp appears once in the key', () => {
  // A ramp often holds one colour across neighbouring quantities. The same
  // swatch and the same text twice in a column reads as a rendering fault.
  const repeated = {
    Legend: [{
      rules: [{
        symbolizers: [{
          Raster: {
            colormap: {
              entries: [
                { label: '10', quantity: '10', color: '#123456' },
                { label: '10', quantity: '11', color: '#123456' },
                { label: '20', quantity: '20', color: '#123456' },
              ],
            },
          },
        }],
      }],
    }],
  };
  assert.deepEqual(parseWMSLegend(repeated), [
    { color: '#123456', label: '10' },
    { color: '#123456', label: '20' },
  ]);
});

test('legend: nothing usable is an empty list, never a throw', () => {
  // The panel treats an empty key as "no key" and shows the layer name alone.
  // Anything thrown here would take the whole layer row with it.
  for (const body of [null, undefined, {}, { Legend: [] }, { Legend: [{}] },
    { Legend: [{ rules: [{ symbolizers: [{}] }] }] }]) {
    assert.deepEqual(parseWMSLegend(body), []);
  }
});

/*
 * ArcGIS legends, and which of two names to show.
 *
 * Both fixtures are the real shapes: BLM's GTLF labels every sublayer's single
 * class the same generic way, and the Forest Service MVUM puts the real
 * distinctions in the class labels instead.
 */
const GTLF_LEGEND = {
  layers: [
    {
      layerId: 0,
      layerName: 'Roads Managed for Public Motorized Use',
      legend: [{ label: 'Transportation System - Road', imageData: 'AAA' }],
    },
    {
      layerId: 1,
      layerName: 'Roads Managed for Limited Public Motorized Use',
      legend: [{ label: 'Transportation System - Road', imageData: 'BBB' }],
    },
    {
      layerId: 2,
      layerName: 'Trails Managed for Public Motorized Use',
      legend: [{ label: 'Trail', imageData: 'CCC' }],
    },
  ],
};

test('legend: a sublayer with one class is named by the sublayer', () => {
  /*
   * GTLF's three route layers all label their single class "Transportation
   * System - Road" or "Trail". Taking the class labels would draw three rows
   * saying almost the same thing and throw away the designation, which is the
   * only part anybody switched the layer on for.
   */
  assert.deepEqual(arcgisLegendRows(GTLF_LEGEND).map((row) => row.label), [
    'Roads Managed for Public Motorized Use',
    'Roads Managed for Limited Public Motorized Use',
    'Trails Managed for Public Motorized Use',
  ]);
});

test('legend: a sublayer with several classes keeps its class labels', () => {
  // Here the classes are the distinctions and the sublayer name is the thing
  // that would say nothing.
  const mvum = {
    layers: [{
      layerId: 1,
      layerName: 'Motor Vehicle Use Map: Roads',
      legend: [
        { label: 'Roads open to all Vehicles, Yearlong', imageData: 'AAA' },
        { label: 'Roads open to all Vehicles, Seasonal', imageData: 'BBB' },
      ],
    }],
  };
  assert.deepEqual(arcgisLegendRows(mvum).map((row) => row.label), [
    'Roads open to all Vehicles, Yearlong',
    'Roads open to all Vehicles, Seasonal',
  ]);
});

test('legend: naming a sublayer takes only that one', () => {
  assert.deepEqual(arcgisLegendRows(GTLF_LEGEND, 2).map((row) => row.label), [
    'Trails Managed for Public Motorized Use',
  ]);
});

test('legend: a class with no swatch or no label is not a row', () => {
  // Both the MVUM and GTLF keys publish an unlabelled class, and a swatch with
  // nothing beside it reads as a rendering fault rather than as a category.
  const ragged = {
    layers: [{
      layerId: 0,
      layerName: 'Something',
      legend: [
        { label: 'Real', imageData: 'AAA' },
        { label: '   ', imageData: 'BBB' },
        { label: 'No swatch' },
      ],
    }],
  };
  assert.deepEqual(arcgisLegendRows(ragged).map((row) => row.label), ['Real']);
});

test('legend: nothing usable is an empty list, never a throw', () => {
  for (const body of [null, undefined, {}, { layers: [] }, { layers: [{ legend: [] }] }]) {
    assert.deepEqual(arcgisLegendRows(body), []);
  }
});

/* ------------------------------------------------------------------ gridpoints */

/*
 * The unit conversions, which are the part of this that fails silently.
 *
 * A gridpoint carries its own unit per series, and the obvious assumption is
 * wrong in a way nothing would flag: NWS publishes temperatures in Celsius even
 * though its prose forecasts are in Fahrenheit. A dewpoint depression computed
 * across a mismatch is a plausible number that is not the thing it claims to
 * be, so each conversion is pinned against a value whose answer is known.
 */
test('gridpoints: each unit the feed uses is converted to the one we work in', () => {
  const series = (uom, value) => expandSeries({ uom, values: [{ validTime: '2026-10-12T00:00:00+00:00/PT1H', value }] });

  assert.equal(series('wmoUnit:degC', 12).unit, 'degC');
  assert.equal(series('wmoUnit:degC', 12).rows[0].value, 12);

  const fromF = series('wmoUnit:degF', 50);
  assert.equal(fromF.unit, 'degC');
  assert.ok(Math.abs(fromF.rows[0].value - 10) < 1e-9);

  const fromK = series('wmoUnit:K', 283.15);
  assert.ok(Math.abs(fromK.rows[0].value - 10) < 1e-9);

  const fromMs = series('wmoUnit:m_s-1', 10);
  assert.equal(fromMs.unit, 'km_h-1');
  assert.ok(Math.abs(fromMs.rows[0].value - 36) < 1e-9);

  const fromMph = series('wmoUnit:[mi_i]_h-1', 10);
  assert.ok(Math.abs(fromMph.rows[0].value - 16.09344) < 1e-9);

  const fromMiles = series('wmoUnit:[mi_i]', 1);
  assert.equal(fromMiles.unit, 'm');
  assert.ok(Math.abs(fromMiles.rows[0].value - 1609.344) < 1e-9);
});

test('gridpoints: an unknown unit passes through and says so, rather than lying', () => {
  const odd = expandSeries({ uom: 'wmoUnit:furlong', values: [{ validTime: '2026-10-12T00:00:00+00:00/PT1H', value: 3 }] });
  assert.equal(odd.unit, 'wmoUnit:furlong');
  assert.equal(odd.rows[0].value, 3);
});

test('gridpoints: an interval is expanded to the hours it covers, nulls included', () => {
  const expanded = expandSeries({
    uom: 'wmoUnit:percent',
    values: [{ validTime: '2026-10-12T00:00:00+00:00/PT3H', value: 40 }, { validTime: '2026-10-12T03:00:00+00:00/PT1H', value: null }],
  });
  assert.equal(expanded.rows.length, 4);
  assert.deepEqual(expanded.rows.map((row) => row.value), [40, 40, 40, null]);
});

const GRID_POINT = { properties: { forecastGridData: 'https://api.weather.gov/gridpoints/MRX/50,60' } };

const gridPayload = (extra = {}) => ({
  properties: {
    temperature: { uom: 'wmoUnit:degC', values: [{ validTime: '2026-10-12T00:00:00+00:00/PT2H', value: 6 }] },
    dewpoint: { uom: 'wmoUnit:degC', values: [{ validTime: '2026-10-12T00:00:00+00:00/PT2H', value: 5.5 }] },
    windSpeed: { uom: 'wmoUnit:km_h-1', values: [{ validTime: '2026-10-12T00:00:00+00:00/PT2H', value: 4 }] },
    skyCover: { uom: 'wmoUnit:percent', values: [{ validTime: '2026-10-12T00:00:00+00:00/PT2H', value: 5 }] },
    ...extra,
  },
});

test('gridpoints: fog ingredients arrive on one timeline', async () => {
  await withFetch((url) => (url.includes('/points/') ? GRID_POINT : gridPayload()), async () => {
    const result = await fogIngredients(POINT);
    assert.equal(result.ok, true);
    assert.equal(result.hours.length, 2);
    assert.deepEqual(
      { ...result.hours[0], at: result.hours[0].at.toISOString() },
      {
        at: '2026-10-12T00:00:00.000Z',
        temperatureC: 6, dewpointC: 5.5, windKmh: 4, skyPercent: 5, visibilityM: null,
      },
    );
  });
});

/*
 * Most land grids publish no visibility at all. That is the normal case rather
 * than a failure. The model reads a null and an absent key identically — the
 * check is `Number.isFinite` either way — so this is about the shape of a row
 * rather than about the answer: an hour should look the same whichever optional
 * series the local office happens to publish, so that a row printed while
 * something is going wrong has a hole in it that is visible.
 */
test('gridpoints: a grid with no visibility series is still usable', async () => {
  await withFetch((url) => (url.includes('/points/') ? GRID_POINT : gridPayload()), async () => {
    const result = await fogIngredients(POINT);
    assert.equal(result.hours.every((hour) => hour.visibilityM === null), true);
  });
});

test('gridpoints: a grid that does publish visibility carries it through in metres', async () => {
  const withVis = gridPayload({
    visibility: { uom: 'wmoUnit:m', values: [{ validTime: '2026-10-12T00:00:00+00:00/PT2H', value: 300 }] },
  });
  await withFetch((url) => (url.includes('/points/') ? GRID_POINT : withVis), async () => {
    const result = await fogIngredients(POINT);
    assert.equal(result.hours[0].visibilityM, 300);
  });
});

test('gridpoints: outside the United States it says which service does not cover you', async () => {
  await withFetch(() => null, async () => {
    const result = await fogIngredients([2.35, 48.85]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /National Weather Service/);
  });
});
