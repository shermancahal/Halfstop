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

/** The default tile above, as the point it is centred on. */
const HOME = [-83.67, 36.0];

/**
 * The tile to ask for, which is not always the default one.
 *
 * Two ways the default is wrong, and both have had this tool report a working
 * layer as a broken one:
 *
 * A layer that only covers one state is correctly empty everywhere else, and
 * the default tile is over Tennessee — so Kentucky's lidar hillshade came back
 * blank and looked broken when it was working perfectly and simply had nothing
 * to draw there. An entry can name its own place: `"at": [lon, lat, zoom]`.
 *
 * And a layer has a zoom range. Asking the light pollution layer for z9 when
 * it publishes to z8 is a 400 from the server and a FAIL in this report, for a
 * layer that is fine — the request was outside what it offers. The zoom is
 * clamped to the range the entry itself declares, which is the same range the
 * app will ask within.
 */
function tileFor(entry) {
  const [lon, lat, asked] = Array.isArray(entry?.at) ? entry.at : [...HOME, undefined];
  const floor = Number.isFinite(entry?.minzoom) ? entry.minzoom : 0;
  const ceiling = Number.isFinite(entry?.maxzoom) ? entry.maxzoom : 22;
  const zoom = Math.min(Math.max(asked ?? Z, floor), ceiling);

  // Keep the exact default tile when nothing moved it, so the numbers in the
  // report stay comparable with every previous run.
  if (!Array.isArray(entry?.at) && zoom === Z) return { z: Z, x: X, y: Y };

  const n = 2 ** zoom;
  const rad = (lat * Math.PI) / 180;
  return {
    z: zoom,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

function tileURL(template, tile = { z: Z, x: X, y: Y }) {
  const [w, s, e, n] = bbox3857(tile.z, tile.x, tile.y);
  return template
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y))
    .replace(/\{quadkey\}/g, quadkey(tile.z, tile.x, tile.y))
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
 * A PNG's pixel size, read out of its header.
 *
 * Eight bytes of signature, then the IHDR chunk: length, type, then width and
 * height as big-endian 32-bit integers. Worth the twelve lines — "the legend is
 * horizontal now" and "the legend is a 1x1 pixel" are both things a byte count
 * cannot tell you.
 */
/**
 * Whether a body begins the way an image does.
 *
 * Content-type is what a server claims; these bytes are what it sent.
 */
function imageMagic(bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 12) return false;
  const b = (i) => view.getUint8(i);
  if (view.getUint32(0) === 0x89504e47) return true;                 // PNG
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return true;  // JPEG
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return true;  // GIF
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) return true; // WebP
  return false;
}

function pngSize(bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 24) return null;
  if (view.getUint32(0) !== 0x89504e47) return null;
  if (view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The layer names a capabilities document offers.
 *
 * The point of the candidates file is to stop guessing at service vocabulary,
 * and a GetCapabilities or an ArcGIS `f=pjson` is the service telling you its
 * own. Printing what it says beats another round of plausible URLs.
 */
/**
 * Pull whatever a candidate says it is looking for out of the body.
 *
 * For the cases the generic extractors cannot reach: a WMTS capabilities
 * document names its layers in `ows:Identifier` rather than `Name`, and a
 * light-pollution atlas keeps its tile URL pattern inside the JavaScript of its
 * own viewer page. Both are one regex away from being readable, and both are
 * otherwise a round trip of guessing at URLs.
 *
 * Deduped and capped, because an unfiltered capabilities document is several
 * hundred lines of log nobody reads.
 */
/**
 * The message an ArcGIS service puts in a 200 when it is refusing.
 *
 * Returns null for anything that is not one of these, so a body that merely
 * mentions the word error in a layer name is not mistaken for a failure.
 */
function esriError(body) {
  const text = String(body ?? '');
  if (!/"error"\s*:\s*\{/.test(text)) return null;
  const detail = text.match(/"details"\s*:\s*\[\s*"([^"]+)"/);
  const message = text.match(/"message"\s*:\s*"([^"]+)"/);
  const code = text.match(/"code"\s*:\s*(\d+)/);
  return detail?.[1] || message?.[1] || (code ? `code ${code[1]}` : 'unspecified');
}

/**
 * A well-formed answer holding nothing.
 *
 * Only says yes when the body actually carries a features array and that array
 * is empty - a capabilities document or a field list has no features at all and
 * must not be called empty.
 */
function emptyFeatures(body) {
  const text = String(body ?? '');
  if (!/"features"\s*:\s*\[/.test(text)) return false;
  return /"features"\s*:\s*\[\s*\]/.test(text);
}

/*
 * A pattern that does not compile is a check that did not run.
 *
 * This used to return the error message as though it were a match, and a
 * non-empty array reads as "the body said what it should" everywhere it is
 * consulted. Three probes passed that way in one run - JavaScript has no
 * inline `(?i)`, so every pattern written with one silently certified its
 * page. A broken pattern now fails loudly instead, which is the only useful
 * thing a broken check can do.
 *
 * Leading (?i) is also honoured rather than rejected, since it is the form
 * everyone writes and translating it is one line.
 */
function findIn(body, pattern) {
  const inline = String(pattern).match(/^\(\?([ims]+)\)([\s\S]*)$/);
  const flags = `g${inline ? inline[1] : ''}`;
  const source = inline ? inline[2] : String(pattern);
  const matches = String(body).matchAll(new RegExp(source, flags));
  return [...new Set([...matches].map((match) => (match[1] ?? match[0]).trim()))].slice(0, 40);
}

/** Whether a candidate's find pattern compiles at all. */
function findFails(pattern) {
  if (!pattern) return null;
  try {
    findIn('', pattern);
    return null;
  } catch (error) {
    return error.message;
  }
}

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
    /*
     * A feature collection describes the data itself, which is the only way to
     * settle what a vector tile actually tags a road with. Guessing at that
     * vocabulary — rather than reading it — is the most expensive mistake in
     * this project's history, twice over.
     */
    if (Array.isArray(parsed.features) && parsed.features.length) {
      return parsed.features.slice(0, 24).map((feature) => {
        const props = feature.properties || {};

        /*
         * A geocoding answer, which is a feature collection too but describes
         * somewhere rather than something. What matters here is only whether
         * the state is in it and where — as a feature of its own, or buried in
         * another feature's `context`. Reading that off the wire is what turns
         * "the shields are generic" into a one-line fix.
         */
        if (Array.isArray(feature.place_type)) {
          const context = (feature.context || [])
            .map((entry) => `${String(entry.id).split('.')[0]}=${entry.short_code || entry.text}`)
            .join(' ');
          return [
            `place_type=${feature.place_type.join('|')}`,
            `text=${feature.text}`,
            props.short_code ? `short_code=${props.short_code}` : '',
            context && `context[ ${context} ]`,
          ].filter(Boolean).join(' ');
        }

        const keep = ['class', 'type', 'ref', 'shield', 'reflen', 'name', 'surface'];
        const shown = keep.filter((key) => props[key] !== undefined)
          .map((key) => `${key}=${props[key]}`).join(' ');
        return shown || Object.keys(props).slice(0, 8).join(',');
      });
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
  /*
   * Substring rather than equality.
   *
   * `--only pm:` is how you ask about a family of candidates, and an exact
   * match answers that with silence: the run finished in under a second,
   * reported nothing, and looked like every probe passing. A filter that can
   * match nothing without saying so is the same shape as a find pattern that
   * cannot compile.
   */
  const picked = all.filter((entry) => (only ? entry.id.includes(only) : true));
  if (only && !picked.length) {
    console.error(`--only ${only} matched none of the ${all.length} entries.`);
    process.exit(2);
  }
  return picked;
}

async function probe(entry) {
  const template = entry.tiles[0];
  if (/\{token\}|access_token=$/.test(template) && !token) {
    return { ...entry, skipped: 'needs a Mapbox token' };
  }

  const url = tileURL(template.replace(/\{token\}/g, token), tileFor(entry));
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
        // And the Referer with it, because that is the header Mapbox checks a
        // URL-restricted token against — not Origin. Without it every
        // token-gated probe fails from CI with a 403 that says nothing about
        // whether the endpoint works, which is worse than not probing at all.
        Referer: `${ORIGIN}/Map/`,
        /*
         * A candidate may ask for part of a file.
         *
         * PMTiles is one archive read a slice at a time, which is the whole
         * reason it works from static hosting - and a probe that omits the
         * Range header asks for the entire planet and times out. That is
         * exactly what happened: "unreachable" said nothing about Protomaps
         * and everything about the request.
         */
        ...(entry.range ? { Range: entry.range } : {}),
      },
      redirect: 'follow',
      // Thirty seconds, not ten. The USGS contour and transport services take
      // upwards of twenty to answer a cold tile — slow is what they are, not
      // broken, and reporting them as down every week teaches people to skim
      // the report.
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.arrayBuffer();
    const type = response.headers.get('content-type') || '';
    const bytes = body.byteLength;

    // An error page is the failure that looks most like success: 200, a body,
    // and not one pixel of map in it.
    // A tile is a tile whatever the header says it is. ArcGIS tiled services
    // hand back `application/octet-stream` for a perfectly good JPEG, and the
    // FAA's VFR sectional was reported as "not an image" for exactly that
    // reason - a real chart, failed on a header. Read the first bytes instead:
    // PNG, JPEG, GIF and WebP all announce themselves there.
    const isImage = /image\//.test(type) || imageMagic(body);
    const size = isImage ? pngSize(body) : null;
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
        /*
         * A candidate can declare that it is data rather than a tile.
         *
         * Several of the things worth checking are not images at all — an
         * aurora forecast grid, a service's own list of what it publishes, a
         * geocode. Reporting those as failures because they are not PNGs makes
         * the summary line cry wolf, and a report people skim is a report that
         * stops catching the layer that really did break.
         *
         * CORS still matters exactly as much: a JSON body a browser is not
         * allowed to read is as useless as a tile it cannot draw.
         */
        /*
         * A page a person is sent to, not a resource the app fetches.
         *
         * The identify card can carry a link - "request authorisation" points
         * at FAA DroneZone - and a link is navigated to, so no CORS header is
         * involved and demanding one would fail every link that works. What
         * matters is that it answers, and that it is not a soft 404: a
         * "page not found" served as 200 with a full site chrome around it is
         * the failure mode here, so a candidate can still name what the page
         * has to say.
         */
        : entry.expect === 'page'
          ? (findFails(entry.find) ? `bad find pattern: ${findFails(entry.find)}`
            : bytes < EMPTY_BYTES ? 'blank'
            : (entry.find && !findIn(decoded, entry.find).length) ? 'page did not say it' : 'ok')
        : entry.expect === 'data'
          ? (!response.headers.get('access-control-allow-origin') ? 'no CORS'
            /*
             * An ArcGIS service that cannot answer says so in a 200.
             *
             * "The requested layer (layerId: 0) was not found" and "Token
             * Required" both arrive as HTTP 200 with a JSON error body, so a
             * check that only reads the status code passes them - and six
             * shipped layers passed exactly that way before this existed. The
             * whole point of a health check is to name the dead ones, and it
             * was quietly certifying them.
             */
            : esriError(decoded) ? `service error: ${esriError(decoded)}`
            /*
             * A query that answers with no features is the emptiest kind of
             * pass. `"features":[]` satisfies any regex looking for envelope
             * keys, and this file has already certified two layers that way -
             * the FAA grid and Oregon's park status both came back 200, well
             * formed and holding nothing. Existence, shape and returning data
             * are three questions; only the third one puts a layer on a map.
             */
            /*
             * Unless the candidate is asking whether it is still empty.
             *
             * Some of these assert an absence on purpose - "the app's own
             * WHERE finds no special-use airspace over Dolly Sods, which is
             * the MOA exclusion working" or "Oregon still publishes no park
             * data, so there is still no layer to add". Scored the usual way
             * those are red every week for being right, and a report with a
             * standing block of expected failures in it is a report people
             * stop reading. `expectEmpty` flips the polarity: empty is the
             * pass, and a service that starts answering is the news.
             */
            : (entry.expectEmpty && emptyFeatures(decoded)) ? 'ok'
            : entry.expectEmpty ? 'no longer empty'
            : emptyFeatures(decoded) ? 'no features'
            /*
             * And a data probe that names what it expects has to find it.
             *
             * `find` decided only which text got printed here, while the
             * `page` branch above has always treated it as the assertion it
             * reads like. So a candidate written to assert something - "this
             * box holds no special-use airspace" - was scored purely on the
             * service answering at all, and reported as expected while its
             * own body said the opposite. I wrote that candidate and read the
             * green line.
             *
             * Same verdict name as the page branch, for the same meaning: it
             * answered, and it did not say the thing.
             */
            : (entry.find && !findIn(decoded, entry.find).length) ? 'page did not say it'
            : 'ok')
          : !isImage ? 'not an image'
          // A tile a browser is not allowed to read is a tile that does not
          // draw, however well it downloads from a script. Worth failing on:
          // it is invisible from every other angle.
          : !response.headers.get('access-control-allow-origin') ? 'no CORS'
            : bytes < EMPTY_BYTES ? (entry.seasonal ? 'empty (seasonal)' : 'blank')
              : 'ok',
      text,
      size,
      cors: response.headers.get('access-control-allow-origin') || '',
      names: isImage ? []
        : entry.find ? (findFails(entry.find) ? [`bad find pattern: ${findFails(entry.find)}`] : findIn(decoded, entry.find))
        : layerNames(decoded),
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
    ok: 'ok  ', blank: 'BLANK', failed: 'FAIL', 'not an image': 'FAIL', 'no features': 'NONE', 'page did not say it': 'FAIL', unreachable: 'DOWN',
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
    const px = result.size ? `${result.size.width}x${result.size.height}`.padStart(9) : ''.padStart(9);
    console.log(`  ${(mark[result.verdict] || '????').padEnd(5)} ${result.id.padEnd(30)} ${String(result.status ?? '').padEnd(4)} ${size} ${px}  ${(result.type || '').padEnd(11)} ${cors}`);
    if (result.names?.length) {
      // Eight to a line. A service with sixty fields is worth reading, and
      // sixty lines of it is not.
      for (let at = 0; at < result.names.length; at += 8) {
        console.log(`        ${result.names.slice(at, at + 8).join(', ')}`);
      }
    } else if (result.text && (result.verdict !== 'ok' || result.expect === 'data')) {
      /*
       * A data probe prints its body even when it passed.
       *
       * The first run of these produced three green lines that said nothing at
       * all: the legend JSON, the BLM catalogue and the atlas page all
       * answered 200 with a `find` that matched nothing, and "ok" with no
       * output is indistinguishable from "ok, and here is what you asked for".
       * The whole reason to probe data rather than a tile is to read it.
       */
      console.log(`        ${result.text.slice(0, 160)}`);
    }
    if (result.verdict !== 'ok') console.log(`        ${result.url}`);
  }

  const checked = results.filter((result) => !result.skipped);
  const bad = checked.filter((result) => result.verdict !== 'ok' && result.verdict !== 'empty (seasonal)');
  console.log(`\n${checked.length - bad.length} of ${checked.length} answered the way they were expected to.`);
  if (bad.length) {
    console.log(`Needs attention: ${bad.map((result) => `${result.id} (${result.verdict})`).join(', ')}`);
  }
}

// Always exits 0. This reports on other people's servers; it is a diagnostic,
// not a gate, and failing a deploy because NOAA is having an afternoon would be
// the wrong trade.
process.exit(0);
