/**
 * Map engine loader.
 *
 * The viewer is written against the Mapbox GL JS API surface, which MapLibre GL
 * also implements. That lets the site run on open tiles with no account today,
 * and switch to Mapbox — vector styles, terrain, custom Studio layers — by
 * dropping a token into config.js, with no other code change.
 */

import { MAPBOX_TOKEN, MAP_ENGINE } from '../config.js';
import { bywaysStyle } from './byways-style.js';

const MAPLIBRE_VERSION = '4.7.1';
const MAPBOX_VERSION = '3.7.0';

const SOURCES = {
  maplibre: {
    js: `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`,
    css: `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`,
    global: 'maplibregl',
  },
  mapbox: {
    js: `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}/mapbox-gl.js`,
    css: `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}/mapbox-gl.css`,
    global: 'mapboxgl',
  },
};

/**
 * The engine's stylesheet goes in FIRST, ahead of ours.
 *
 * It used to be appended, which put it last in document order — and since our
 * popup rules and its popup rules have exactly the same specificity
 * (`.mapboxgl-popup-content` either way), last one wins. So every override
 * this app makes to the engine's chrome was being quietly reverted the moment
 * the engine loaded: in dark mode the popup card came back `#fff` while the
 * panel behind it stayed dark, which is precisely what got reported twice.
 *
 * Inserting it before our own stylesheets makes vendor CSS the base it should
 * always have been, and fixes the whole class rather than the one rule anybody
 * happened to notice.
 */
function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;

  const ours = document.head.querySelector('link[rel="stylesheet"], style');
  if (ours) document.head.insertBefore(link, ours);
  else document.head.append(link);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load the map library from ${src}`)), { once: true });
    document.head.append(script);
  });
}

/** Overlays are raster layers named `overlay-<id>`; this is their draw order anchor. */
export const OVERLAY_LAYER_PREFIX = 'overlay-';

export function resolveEngineName() {
  if (MAP_ENGINE === 'mapbox') return 'mapbox';
  if (MAP_ENGINE === 'maplibre') return 'maplibre';
  return MAPBOX_TOKEN ? 'mapbox' : 'maplibre';
}

export function hasMapboxToken() {
  return typeof MAPBOX_TOKEN === 'string' && MAPBOX_TOKEN.trim().length > 0;
}

/**
 * The token itself, for the few callers that need to build a URL with it.
 *
 * Exported from here rather than imported from config all over the app, so
 * there is one place that knows whether a token exists and what it is.
 */
export function mapboxToken() {
  return hasMapboxToken() ? MAPBOX_TOKEN : '';
}

/**
 * Load the chosen GL library.
 * @returns {Promise<{gl: object, engine: 'mapbox'|'maplibre'}>}
 */
export async function loadEngine() {
  let engine = resolveEngineName();
  if (engine === 'mapbox' && !hasMapboxToken()) {
    // Explicitly configured for Mapbox but no token: fail soft rather than
    // showing an empty map, since the open basemaps work perfectly well.
    console.warn('[maps] MAP_ENGINE is "mapbox" but MAPBOX_TOKEN is empty — falling back to MapLibre.');
    engine = 'maplibre';
  }

  const source = SOURCES[engine];
  loadStylesheet(source.css);
  await loadScript(source.js);

  const gl = window[source.global];
  if (!gl) throw new Error(`The ${engine} library loaded but did not register itself.`);
  if (engine === 'mapbox') gl.accessToken = MAPBOX_TOKEN;
  return { gl, engine };
}

/**
 * Build a raster style spec for a basemap plus its overlays.
 *
 * Keeping our own style (rather than a hosted one) means switching basemaps is
 * a source swap, not a full setStyle, so loaded tracks never have to be torn
 * down and re-added.
 */
/**
 * An overlay's raster sources, as a list.
 *
 * Most overlays are one tile service, but some answer a single question that no
 * one agency covers — "where can I camp" spans BLM and the Forest Service — and
 * splitting those into separate switches makes the user do the agency's
 * paperwork. Such an overlay declares `sources: [...]`, and each entry becomes
 * its own raster layer under one toggle, so one service failing does not blank
 * the other.
 *
 * Layer ids are `overlay-<id>` for the first part and `overlay-<id>--<n>` after
 * it, so everything keyed on the overlay id still finds its layers by prefix.
 */
export function overlayParts(overlay) {
  const base = { tileSize: overlay.tileSize, maxzoom: overlay.maxzoom, attribution: overlay.attribution };

  /*
   * A queried overlay is three layers over one source: a fill, the outline
   * that makes a pale fill findable, and a dot.
   *
   * The dot is here because a fill and a line render nothing at all over point
   * geometry, and several services answer with points where their titles
   * promise areas - Colorado's is facilities, Maine's is park sites, Michigan's
   * campgrounds are campgrounds. Those layers switched on and drew nothing, and
   * nothing anywhere said why. A circle layer costs nothing over lines and
   * polygons, which never render as circles, so it is added unconditionally
   * rather than from a flag somebody has to remember to set.
   *
   * All three are listed so everything that tears an overlay down by its parts
   * still finds all of it.
   */
  if (overlay.query) {
    return [
      { ...base, query: overlay.query, role: 'fill', layerId: `${OVERLAY_LAYER_PREFIX}${overlay.id}` },
      { ...base, query: overlay.query, role: 'casing', layerId: `${OVERLAY_LAYER_PREFIX}${overlay.id}--1` },
      { ...base, query: overlay.query, role: 'line', layerId: `${OVERLAY_LAYER_PREFIX}${overlay.id}--2` },
      { ...base, query: overlay.query, role: 'dot', layerId: `${OVERLAY_LAYER_PREFIX}${overlay.id}--3` },
      { ...base, query: overlay.query, role: 'label', layerId: `${OVERLAY_LAYER_PREFIX}${overlay.id}--4` },
    ];
  }

  const parts = Array.isArray(overlay.sources) && overlay.sources.length
    ? overlay.sources.map((source) => ({ ...base, ...source }))
    : [{ ...base, tiles: overlay.tiles }];

  return parts.map((part, index) => ({
    ...part,
    layerId: index === 0 ? `${OVERLAY_LAYER_PREFIX}${overlay.id}` : `${OVERLAY_LAYER_PREFIX}${overlay.id}--${index}`,
  }));
}

/** The overlay id a layer or source id belongs to, or '' if it is not one. */
export function overlayIdFromLayer(layerId = '') {
  if (!layerId.startsWith(OVERLAY_LAYER_PREFIX)) return '';
  return layerId.slice(OVERLAY_LAYER_PREFIX.length).split('--')[0];
}

/**
 * The style document for a basemap, and whether it is vector.
 *
 * Three cases, and the difference matters to the caller: a raster style bakes
 * the overlays into the document, while both vector paths start with only the
 * basemap's own layers and need overlays added once the style has loaded.
 *
 * @returns {{style: object|string, vector: boolean}}
 */
export function styleFor(basemap, overlays = []) {
  if (basemap?.custom === 'byways' && MAPBOX_TOKEN) {
    return { style: bywaysStyle(MAPBOX_TOKEN), vector: true, fallback: '' };
  }
  if (basemap?.style && MAPBOX_TOKEN) {
    return { style: basemap.style, vector: true, fallback: '' };
  }

  /*
   * No token: raster tiles instead.
   *
   * `fallback` exists because this substitution used to be silent, and a silent
   * substitution is a lie the interface tells. Byways Topo without a token
   * renders CyclOSM — somebody else's cycling map, with pale lavender
   * motorways, no route shields and none of our palette — while the panel went
   * on calling it Byways Topo. The report that came back was that the style had
   * a cycling layer on it and the colours were wrong, which is exactly right
   * and had nothing to do with the style.
   */
  const fallback = basemap?.custom && !MAPBOX_TOKEN
    ? 'Byways Topo renders from vector tiles and needs a Mapbox token.'
      + ' Showing CyclOSM raster instead — different colours, and no route shields.'
    : '';

  return { style: buildRasterStyle(basemap, overlays), vector: false, fallback };
}

export function buildRasterStyle(basemap, overlays = []) {
  const sources = {};
  const layers = [];

  if (basemap?.tiles) {
    sources.basemap = {
      type: 'raster',
      tiles: basemap.tiles,
      tileSize: basemap.tileSize || 256,
      maxzoom: basemap.maxzoom || 19,
      attribution: basemap.attribution || '',
    };
    layers.push({ id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-fade-duration': 180 } });
  }

  for (const overlay of overlays) {
    // A queried overlay has no tiles to bake in — its data depends on where the
    // map is looking, so it is added at runtime on both engines rather than
    // written into the style document here.
    if (overlay.query) continue;
    for (const part of overlayParts(overlay)) {
      sources[part.layerId] = {
        type: 'raster',
        tiles: part.tiles,
        tileSize: part.tileSize || 256,
        maxzoom: part.maxzoom || 19,
        attribution: part.attribution || '',
      };
      layers.push({
        id: part.layerId,
        type: 'raster',
        source: part.layerId,
        paint: { 'raster-opacity': overlay.opacity ?? 1, 'raster-fade-duration': 180 },
      });
    }
  }

  /*
   * Glyphs, when we have a token to fetch them with.
   *
   * The note that used to sit here said a style with no symbol layers does not
   * need glyphs, which was true when it was written and stopped being true the
   * day the viewer started adding its own label layers to whatever style is
   * loaded. Mapbox GL rejects a symbol layer with a text-field against a style
   * with no glyphs URL — at addLayer time, so the layer never arrives — and
   * that showed up in the console as
   *   layers.light-label.layout.text-field: use of "text-field" requires a
   *   style "glyphs" property
   * with the sun and moon bearings drawing unlabelled.
   *
   * `glyphs: undefined` is itself a spec violation, so the key is set or
   * absent, never present-and-empty. Without a token there is no free font
   * endpoint here worth depending on, so the caller is told there are no
   * glyphs and leaves its label layers out rather than watching them fail.
   */
  const style = { version: 8, sources, layers };
  if (MAPBOX_TOKEN) {
    style.glyphs = `https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${MAPBOX_TOKEN}`;
  }
  return style;
}

/** Whether a style can carry text at all — i.e. whether it declares glyphs. */
export const styleHasGlyphs = (style) => typeof style?.glyphs === 'string' && style.glyphs.length > 0;


/**
 * The identify rows for one overlay feature, in the order the catalogue asked.
 *
 * A layer may name its own columns. Falling back on the column name works
 * while the column is called LANDS_NAME and stops working when it is called
 * APT1_LAANC, which becomes "Apt1 laanc" and tells a reader nothing they did
 * not already not know.
 *
 * `fields` is declarative rather than a set of formatter functions - a value
 * table survives being read, diffed and cached in a way a closure does not:
 *
 *   { CEILING: { label: 'Ceiling', suffix: ' ft AGL', values: { 0: 'None' } } }
 *
 * `values` wins over `suffix`, so a coded column can spell out the cases that
 * mean something and leave the rest to be printed plainly. A field with no
 * value on this feature is left out entirely rather than shown empty, and a
 * `values` entry of '' drops a row the catalogue would rather not show.
 *
 * @param {object} fields   the catalogue's `query.fields`
 * @param {object} properties the feature's properties
 * @param {(value: unknown) => string} humanise how a bare value is printed
 * @returns {Array<[string, string]>} label/value pairs
 */
export function overlayRows(fields, properties = {}, humanise = String) {
  const rows = [];
  for (const [key, spec] of Object.entries(fields || {})) {
    const value = properties[key];
    if (value === null || value === undefined || value === '') continue;
    // String(value) is explicit rather than load-bearing - JavaScript coerces
    // a property key to text on its own, so { 0: ... } is found by 0 as well
    // as by "0". Worth writing out only because the same table is fed to a
    // Mapbox `match` elsewhere, where the coercion does not happen and the
    // mismatch painted every ceiling the fallback colour.
    const coded = spec?.values && Object.hasOwn(spec.values, String(value));
    const text = coded ? spec.values[String(value)] : `${humanise(value)}${spec?.suffix || ''}`;
    if (text === '' || text === null || text === undefined) continue;
    rows.push([spec?.label || key, String(text)]);
  }
  return rows;
}
