/**
 * Aurora, for the two nights a decade it matters here.
 *
 * Deliberately a readout rather than a map layer. NOAA's OVATION model covers
 * the whole globe, but from the latitudes this app is used at — Kentucky,
 * Tennessee, Texas — the aurora is visible a handful of nights in ten years. A
 * permanent switch that draws nothing on 3,650 nights out of 3,652 is the
 * cell-coverage mistake again: it costs a reader the time it takes to work out
 * the map is not broken.
 *
 * What is worth having is the answer to "is tonight one of them", which is a
 * number in the Photography panel beside the moon and the cloud cover.
 *
 * Both feeds come from NOAA's Space Weather Prediction Center, checked from CI
 * for status and for whether a browser is allowed to read them.
 */

const OVATION = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const KP_INDEX = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

/**
 * Pull one point's chance out of the OVATION grid.
 *
 * The grid is a flat list of `[longitude, latitude, chance]` on a one-degree
 * mesh, longitudes 0 to 359 rather than -180 to 180. Converting the caller's
 * longitude rather than the grid's is the cheap direction: the grid has 65,000
 * entries and the caller has one.
 *
 * @returns {{chance: number, observed: string, forecast: string}|null}
 */
export function auroraAt(body, [lon, lat]) {
  const rows = body?.coordinates;
  if (!Array.isArray(rows) || !rows.length) return null;

  const wantLon = Math.round(((lon % 360) + 360) % 360);
  const wantLat = Math.round(lat);
  if (!Number.isFinite(wantLon) || !Number.isFinite(wantLat)) return null;

  /*
   * Scanned rather than indexed.
   *
   * The obvious arithmetic — longitude times 181 plus latitude plus 90 —
   * assumes an ordering the feed does not document, and an off-by-one there
   * would not throw: it would quietly report a chance from a point some
   * distance away, which is exactly the kind of wrong answer nobody catches. A
   * pass over 65,000 rows costs a millisecond and assumes nothing.
   */
  for (const row of rows) {
    if (row[0] === wantLon && row[1] === wantLat) {
      return {
        chance: Number(row[2]) || 0,
        observed: body['Observation Time'] || '',
        forecast: body['Forecast Time'] || '',
      };
    }
  }
  return null;
}

/**
 * The latest planetary K index out of SWPC's table.
 *
 * The feed is a spreadsheet as JSON: a header row of column names, then rows of
 * values. The last row is the most recent reading, and the useful column is the
 * K index itself.
 *
 * @returns {{kp: number, when: string}|null}
 */
export function latestKp(body) {
  if (!Array.isArray(body) || body.length < 2) return null;

  const header = body[0].map((name) => String(name).toLowerCase());
  const timeAt = header.findIndex((name) => name.includes('time'));
  // "Kp_index" in the current feed, but it has been "kp" and "k_index" before,
  // so this matches the family rather than one spelling.
  const kpAt = header.findIndex((name) => /k.?p|k_?index/.test(name));
  if (kpAt < 0) return null;

  const last = body[body.length - 1];
  const kp = Number(last[kpAt]);
  if (!Number.isFinite(kp)) return null;
  return { kp, when: timeAt >= 0 ? String(last[timeAt]) : '' };
}

/**
 * How to describe a Kp number to somebody deciding whether to drive out.
 *
 * The thresholds are the aurora's, not this app's: Kp 5 is the storm line, and
 * below about 4 there is nothing to see from the middle of the country however
 * clear the sky is. Saying "quiet" is more use than saying "2".
 */
export function describeKp(kp) {
  if (!Number.isFinite(kp)) return '';
  if (kp >= 7) return 'severe storm — visible well south of the usual line';
  if (kp >= 5) return 'storm — worth looking north';
  if (kp >= 4) return 'unsettled — possible on the northern horizon up north';
  return 'quiet — no aurora at these latitudes';
}

/** Fetch and read the K index. Null on any failure; this is an enhancement. */
export async function kpNow() {
  try {
    const response = await fetch(KP_INDEX);
    if (!response.ok) return null;
    return latestKp(await response.json());
  } catch {
    return null;
  }
}

/**
 * Fetch and read tonight's chance at a point.
 *
 * The grid is close to a megabyte, so this is called when somebody opens the
 * section rather than on load — the difference matters to whoever is standing
 * at a trailhead on one bar of signal.
 */
export async function auroraChance([lon, lat]) {
  try {
    const response = await fetch(OVATION);
    if (!response.ok) return null;
    return auroraAt(await response.json(), [lon, lat]);
  } catch {
    return null;
  }
}
