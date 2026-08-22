/**
 * Map engine loader.
 *
 * The viewer is written against the Mapbox GL JS API surface, which MapLibre GL
 * also implements. That lets the site run on open tiles with no account today,
 * and switch to Mapbox — vector styles, terrain, custom Studio layers — by
 * dropping a token into config.js, with no other code change.
 */

import { MAPBOX_TOKEN, MAP_ENGINE } from '../config.js';

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

function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
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

export function resolveEngineName() {
  if (MAP_ENGINE === 'mapbox') return 'mapbox';
  if (MAP_ENGINE === 'maplibre') return 'maplibre';
  return MAPBOX_TOKEN ? 'mapbox' : 'maplibre';
}

export function hasMapboxToken() {
  return typeof MAPBOX_TOKEN === 'string' && MAPBOX_TOKEN.trim().length > 0;
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
    const sourceId = `overlay-${overlay.id}`;
    sources[sourceId] = {
      type: 'raster',
      tiles: overlay.tiles,
      tileSize: overlay.tileSize || 256,
      maxzoom: overlay.maxzoom || 19,
      attribution: overlay.attribution || '',
    };
    layers.push({
      id: sourceId,
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': overlay.opacity ?? 1, 'raster-fade-duration': 180 },
    });
  }

  // Note: no `glyphs` key. Mapbox GL validates the style against the style spec
  // and aborts loading on any error — and `glyphs: undefined` is an error there
  // ("string expected, undefined found"), even though MapLibre tolerates it.
  // A style with no symbol layers does not need glyphs at all, so omit the key
  // entirely rather than setting it to undefined.
  return { version: 8, sources, layers };
}

/** Overlays are raster layers named `overlay-<id>`; this is their draw order anchor. */
export const OVERLAY_LAYER_PREFIX = 'overlay-';
