/**
 * Site configuration.
 *
 * Everything an operator normally needs to change lives in this one file:
 * branding, the Mapbox token, and the basemap/overlay catalogue. No build step
 * and no secrets management — a Mapbox public token (pk.*) is designed to be
 * shipped in client code, and should be URL-restricted in your Mapbox account.
 */

export const SITE = {
  name: 'American Byways Maps',
  shortName: 'AB Maps',
  tagline: 'Field maps, tracks and waypoints from the road.',
  description:
    'A public library of GPS tracks, routes and waypoints exported from GaiaGPS — '
    + 'viewable in the browser and downloadable as GPX, KML or GeoJSON.',
  parent: { name: 'American Byways', url: 'https://americanbyways.com' },
  // Shown in the footer and in file attributions.
  copyrightHolder: 'American Byways',
  contactEmail: '',
};

/**
 * Mapbox public access token (pk.…).
 *
 * Leave empty and the site runs on MapLibre GL with the open basemaps below —
 * fully functional, no account needed. Set it and the Mapbox-backed styles below
 * light up automatically.
 */
export const MAPBOX_TOKEN = readMapboxToken();

/**
 * The token is kept OUT of this file, and out of git.
 *
 * assets/js/token.js sets `window.ABMAP_MAPBOX_TOKEN` and is gitignored; copy
 * token.example.js to token.js and put your token there. A Mapbox `pk.` token
 * is public by design and is meant to ship in client code, but GitHub's secret
 * scanner blocks pushes containing one, and a token in git outlives the day you
 * decide to rotate it.
 */
function readMapboxToken() {
  const injected = typeof globalThis === 'undefined' ? '' : globalThis.ABMAP_MAPBOX_TOKEN;
  return typeof injected === 'string' ? injected.trim() : '';
}

/**
 * Rendering engine.
 *   'auto'     — Mapbox GL JS when a token is set, MapLibre GL otherwise
 *   'mapbox'   — force Mapbox GL JS (requires MAPBOX_TOKEN)
 *   'maplibre' — force MapLibre GL, even with a token set
 */
export const MAP_ENGINE = 'auto';

/** Default camera when nothing else is specified. Centred on the Appalachians. */
export const DEFAULT_VIEW = { center: [-84.28, 35.96], zoom: 6.4 };

/** 'imperial' or 'metric'. Users can flip this in the viewer; this is the default. */
export const DEFAULT_UNITS = 'imperial';

const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const USGS_ATTRIBUTION = 'Map data © <a href="https://www.usgs.gov/">USGS</a> — The National Map';
const ESRI_ATTRIBUTION = 'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';

/**
 * Basemaps, in the order they appear in the layer picker.
 *
 * Raster entries need `tiles` (an array of URL templates), `tileSize`, `maxzoom`
 * and `attribution`. Mapbox vector styles instead use `style`, and are hidden
 * automatically unless a token is configured.
 *
 * ArcGIS/USGS tile services use {z}/{y}/{x} order — note the swap.
 */
export const BASEMAPS = [
  {
    id: 'usgs-topo',
    name: 'USGS Topo',
    group: 'Topographic',
    description: 'The National Map — US Topo quads. Best general-purpose backcountry base.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'usgs-imagery-topo',
    name: 'USGS Imagery + Topo',
    group: 'Topographic',
    description: 'Aerial imagery with topographic labels and contours burned in.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'opentopomap',
    name: 'OpenTopoMap',
    group: 'Topographic',
    description: 'Contour-heavy topo rendering of OpenStreetMap data, with hillshading.',
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    tileSize: 256,
    maxzoom: 17,
    attribution: `${OSM_ATTRIBUTION}, <a href="https://opentopomap.org/">OpenTopoMap</a> (CC-BY-SA)`,
  },
  {
    id: 'esri-imagery',
    name: 'Satellite',
    group: 'Imagery',
    description: 'High-resolution world imagery.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 19,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'osm',
    name: 'Street',
    group: 'Road',
    description: 'Standard OpenStreetMap — the most current road and address data.',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19,
    attribution: OSM_ATTRIBUTION,
  },

  /* ---- Mapbox styles: shown only when MAPBOX_TOKEN is set ---- */
  {
    id: 'mapbox-outdoors',
    name: 'Mapbox Outdoors',
    group: 'Mapbox',
    description: 'Vector terrain style with contours and trails. Requires a Mapbox token.',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    requiresToken: true,
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © OpenStreetMap',
  },
  {
    id: 'mapbox-satellite-streets',
    name: 'Mapbox Satellite Streets',
    group: 'Mapbox',
    description: 'Mapbox imagery with road and place labels. Requires a Mapbox token.',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    requiresToken: true,
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © OpenStreetMap © Maxar',
  },
];

/**
 * Default basemap when the URL does not name one.
 *
 * Two defaults, because the good answer differs: without a Mapbox account the
 * USGS quads are the best general-purpose base available, but once a token is
 * configured the Mapbox vector style is almost certainly what was wanted.
 */
export const DEFAULT_BASEMAP = 'usgs-topo';
export const DEFAULT_BASEMAP_WITH_TOKEN = 'mapbox-outdoors';

/**
 * Overlays drawn on top of the basemap. Each is independently toggleable with
 * its own opacity. Add your own by appending to this list — nothing else needs
 * to change.
 */
export const OVERLAYS = [
  {
    id: 'hillshade',
    name: 'Hillshade',
    description: 'Terrain relief shading. Reads well under topo and street bases.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.35,
    enabled: false,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'places',
    name: 'Labels & boundaries',
    description: 'Place names, roads and administrative boundaries — useful over bare imagery.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 1,
    enabled: false,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'usgs-hydro',
    name: 'Hydrography',
    description: 'Streams, rivers and water bodies from the National Hydrography Dataset.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.8,
    enabled: false,
    attribution: USGS_ATTRIBUTION,
  },
];

/** Colour ramp for tracks that carry no colour of their own. */
export const TRACK_COLORS = [
  '#c2410c', '#1d4ed8', '#15803d', '#a21caf', '#0f766e',
  '#b45309', '#4338ca', '#be123c', '#3f6212', '#0369a1',
];

export default {
  SITE, MAPBOX_TOKEN, MAP_ENGINE, DEFAULT_VIEW, DEFAULT_UNITS,
  BASEMAPS, DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN, OVERLAYS, TRACK_COLORS,
};
