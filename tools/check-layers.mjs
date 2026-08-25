/**
 * Ask every configured layer for one tile, and say what came back.
 *
 * Written after "cell coverage does not show anything" — a layer that answers
 * 200 with a fully transparent image looks identical, from inside the app, to
 * one that is simply switched off. The app's own badge only catches a service
 * that fails to answer at all, so a wrong-but-valid URL can sit in the
 * configuration indefinitely with nobody able to tell.
 *
 * Three things are worth knowing per layer, and this reports all three:
 *
 *   - the status, which catches a moved or renamed service;
 *   - the content type, which catches an ArcGIS or WMS error returned as JSON
 *     or XML with a 200 beside it — the most common way these fail;
 *   - the size, which catches the transparent tile. A 256px PNG with nothing
 *     drawn on it compresses to a few hundred bytes, so anything under a
 *     kilobyte is almost certainly empty.
 *
 * It needs the network, so it is not part of `npm test`. It runs in CI, where
 * there is one, without being allowed to fail a deploy: a third party being
 * down for an hour is not a reason to stop publishing the site.
 *
 *   node tools/check-layers.mjs [--json] [--only <id>] [--candidates]
 *
 * `--candidates` probes tools/layer-candidates.json instead of the catalogue.
 * That file is a staging area: a service whose URL cannot be confirmed from
 * documentation goes there first, and only the forms that come back with an
 * image on them are worth putting in front of anyone. Shipping four plausible
 * URLs and finding out from a user which two were wrong is how the cell
 * coverage layer got into the state it is in.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BASEMAPS, OVERLAYS } from '../assets/js/config.js';

const args = process.argv.slice(2);
const asJSON = args.includes('--json');
const useCandidates = args.includes('--candidates');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : '';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * One tile over the Smokies — roughly 83.7W to 83.0W, 35.5N to 36.0N — at a
 * zoom where everything here has data: national forest, a national park, an
 * interstate, towns and a state line, all inside one tile.
 * A layer that is genuinely empty at this tile is a layer with a problem.
 */
const Z = 9;
const X = 137;
const Y = 201;
const EMPTY_BYTES = 1000;

/** The published site, so the CORS answer is the one the real page would get. */
const ORIGIN = 'https://shermancahal.github.io';

const SPAN = 20037508.342789244;

/** The tile's bounds in web mercator metres, which is what {bbox-epsg-3857} is. */
function bbox3857(z, x, y) {
  const size = (SPAN * 2) / 2 ** z;
  const west = -SPAN + x * size;
  const north = SPAN - y * size;
  return [west, north - size, west + size, north];
}

function tileURL(template) {
  const [w, s, e, n] = bbox3857(Z, X, Y);
  return template
    .replace(/\{z\}/g, String(Z))
    .replace(/\{x\}/g, String(X))
    .replace(/\{y\}/g, String(Y))
    .replace(/\{quadkey\}/g, quadkey(Z, X, Y))
    .replace(/\{bbox-epsg-3857\}/g, `${w},${s},${e},${n}`)
    .replace(/\{s\}/g, 'a');
}

function quadkey(z, x, y) {
  let key = '';
  for (let i = z; i > 0; i -= 1) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if (x & mask) digit += 1;
    if (y & mask) digit += 2;
    key += digit;
  }
  return key;
}

/**
 * The layer names a capabilities document offers.
 *
 * The point of the candidates file is to stop guessing at service vocabulary,
 * and a GetCapabilities or an ArcGIS `f=pjson` is the service telling you its
 * own. Printing what it says beats another round of plausible URLs.
 */
function layerNames(body) {
  const found = [];
  // WMS: <Layer><Name>workspace:layer</Name>. The service's own name is in
  // there too, which is harmless — it is one line among the real ones.
  for (const match of body.matchAll(/<Name>([^<]{1,120})<\/Name>/g)) found.push(match[1]);
  if (found.length) return [...new Set(found)].slice(0, 400);

  // ArcGIS: {"layers":[{"id":3,"name":"Snow Depth"}]}
  try {
    const parsed = JSON.parse(body);
    // A query answer describes its own columns, which is how you find the one
    // that names a carrier without downloading the whole layer.
    if (Array.isArray(parsed.fields) && parsed.fields.length) {
      return parsed.fields.map((field) => field.name);
    }
    const layers = parsed.layers || parsed.services || parsed.folders || [];
    for (const layer of layers) {
      if (typeof layer === 'string') found.push(layer);
      else if (layer && layer.name !== undefined) found.push(`${layer.id ?? ''} ${layer.name}`.trim());
    }
  } catch {
    // Not JSON either. The first 300 characters are printed instead.
  }
  return found.slice(0, 400);
}

/**
 * Layers that need a Mapbox token are checked only when one is available:
 * without it they are not broken, they are not configured.
 */
const token = process.env.MAPBOX_TOKEN || '';

async function candidates() {
  const all = useCandidates
    ? JSON.parse(await readFile(path.join(HERE, 'layer-candidates.json'), 'utf8'))
      .map((entry) => ({ ...entry, tiles: [entry.url], kind: 'candidate' }))
    : [
      ...BASEMAPS.filter((entry) => entry.tiles).map((entry) => ({ ...entry, kind: 'basemap' })),
      ...OVERLAYS.filter((entry) => entry.tiles).map((entry) => ({ ...entry, kind: 'overlay' })),
    ];
  return all.filter((entry) => (only ? entry.id === only : true));
}

async function probe(entry) {
  const template = entry.tiles[0];
  if (/\{token\}|access_token=$/.test(template) && !token) {
    return { ...entry, skipped: 'needs a Mapbox token' };
  }

  const url = tileURL(template.replace(/\{token\}/g, token));
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'american-byways-maps layer check (github.com/shermancahal/Map)',
        // Sent so the answer says whether a browser could have made this
        // request. A tile that fetches perfectly from a script and is refused
        // by the page is the second way a layer shows nothing, and status
        // alone cannot tell the two apart.
        Origin: ORIGIN,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.arrayBuffer();
    const type = response.headers.get('content-type') || '';
    const bytes = body.byteLength;

    // An error page is the failure that looks most like success: 200, a body,
    // and not one pixel of map in it.
    const isImage = /image\//.test(type);
    const decoded = isImage ? '' : new TextDecoder().decode(body);
    const text = isImage ? '' : decoded.slice(0, 300).replace(/\s+/g, ' ').trim();

    return {
      ...entry,
      url,
      status: response.status,
      type,
      bytes,
      ms: Date.now() - started,
      verdict: !response.ok ? 'failed'
        : !isImage ? 'not an image'
          // A tile a browser is not allowed to read is a tile that does not
          // draw, however well it downloads from a script. Worth failing on:
          // it is invisible from every other angle.
          : !response.headers.get('access-control-allow-origin') ? 'no CORS'
            : bytes < EMPTY_BYTES ? (entry.seasonal ? 'empty (seasonal)' : 'blank')
              : 'ok',
      text,
      cors: response.headers.get('access-control-allow-origin') || '',
      names: isImage ? [] : layerNames(decoded),
    };
  } catch (error) {
    return { ...entry, url, verdict: 'unreachable', text: String(error.message || error) };
  }
}

const results = [];
for (const entry of await candidates()) {
  // Serially, deliberately. These are other people's services and a burst of
  // thirty requests from a CI runner is not a good way to ask.
  let result = await probe(entry);
  // One retry, and only for a service that did not answer at all. Two of these
  // timed out in one run and were fine in the next; a weekly report that cries
  // wolf gets ignored, which defeats the point of having one.
  if (result.verdict === 'unreachable') result = await probe(entry);
  results.push(result);
}

if (asJSON) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const mark = {
    ok: 'ok  ', blank: 'BLANK', failed: 'FAIL', 'not an image': 'FAIL', unreachable: 'DOWN',
    'no CORS': 'CORS',
    // Snow depth in August is empty because there is no snow, not because the
    // service is wrong. Marked in the catalogue rather than guessed at here.
    'empty (seasonal)': 'ok  ',
  };
  for (const result of results) {
    if (result.skipped) {
      console.log(`  --    ${result.id.padEnd(22)} skipped (${result.skipped})`);
      continue;
    }
    const size = result.bytes === undefined ? '' : `${String(result.bytes).padStart(7)}B`;
    const cors = result.status === undefined ? '' : (result.cors ? `cors:${result.cors}` : 'CORS:none');
    console.log(`  ${(mark[result.verdict] || '????').padEnd(5)} ${result.id.padEnd(34)} ${String(result.status ?? '').padEnd(4)} ${size}  ${(result.type || '').padEnd(12)} ${cors}`);
    if (result.names?.length) {
      // Eight to a line. A service with sixty fields is worth reading, and
      // sixty lines of it is not.
      for (let at = 0; at < result.names.length; at += 8) {
        console.log(`        ${result.names.slice(at, at + 8).join(', ')}`);
      }
    } else if (result.verdict !== 'ok' && result.text) {
      console.log(`        ${result.text.slice(0, 160)}`);
    }
    if (result.verdict !== 'ok') console.log(`        ${result.url}`);
  }

  const checked = results.filter((result) => !result.skipped);
  const bad = checked.filter((result) => result.verdict !== 'ok' && result.verdict !== 'empty (seasonal)');
  console.log(`\n${checked.length - bad.length} of ${checked.length} layers returned an image with something on it.`);
  if (bad.length) {
    console.log(`Needs attention: ${bad.map((result) => `${result.id} (${result.verdict})`).join(', ')}`);
  }
}

// Always exits 0. This reports on other people's servers; it is a diagnostic,
// not a gate, and failing a deploy because NOAA is having an afternoon would be
// the wrong trade.
process.exit(0);
