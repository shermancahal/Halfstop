/**
 * Site configuration.
 *
 * Everything an operator normally needs to change lives in this one file:
 * branding, the Mapbox token, and the basemap/overlay catalogue. No build step
 * and no secrets management — a Mapbox public token (pk.*) is designed to be
 * shipped in client code, and should be URL-restricted in your Mapbox account.
 */

export const SITE = {
  name: 'American Byways GPS',
  shortName: 'AB GPS',
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
    id: 'cyclosm',
    name: 'Byways Topo',
    group: 'Topographic',
    description: 'OpenStreetMap rendered for the outdoors — tracks, trail surfaces and land cover. The closest open equivalent to a Gaia-style topo.',
    tiles: [
      'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    ],
    tileSize: 256,
    maxzoom: 18,
    attribution: `${OSM_ATTRIBUTION}, tiles by <a href="https://www.cyclosm.org/">CyclOSM</a>`,
  },
  {
    id: 'esri-topo',
    name: 'Esri Topo',
    group: 'Topographic',
    description: 'Worldwide topographic base with roads, boundaries and land cover.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Map data © <a href="https://www.esri.com/">Esri</a> and the GIS community',
  },
  {
    id: 'usgs-imagery',
    name: 'USGS Imagery',
    group: 'Imagery',
    description: 'Aerial imagery from The National Map, without labels.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'osm-hot',
    name: 'Humanitarian',
    group: 'Topographic',
    description: 'OSM rendered with rural detail forward — unpaved surfaces, tracks and remote infrastructure show far more clearly than on the standard style.',
    tiles: [
      'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    ],
    tileSize: 256,
    maxzoom: 19,
    attribution: `${OSM_ATTRIBUTION}, tiles by <a href="https://www.hotosm.org/">Humanitarian OSM Team</a>`,
  },
  {
    id: 'carto-light',
    name: 'Minimal Light',
    group: 'Road',
    description: 'Pale, low-contrast base. Tracks and pins read clearly over it — the best choice when the data matters more than the map.',
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ],
    tileSize: 256,
    maxzoom: 19,
    attribution: `${OSM_ATTRIBUTION}, tiles by <a href="https://carto.com/attributions">CARTO</a>`,
  },
  {
    id: 'carto-dark',
    name: 'Minimal Dark',
    group: 'Road',
    description: 'The dark counterpart. Easiest on the eyes at night and the natural partner to the app\u2019s dark theme.',
    tiles: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    ],
    tileSize: 256,
    maxzoom: 19,
    attribution: `${OSM_ATTRIBUTION}, tiles by <a href="https://carto.com/attributions">CARTO</a>`,
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
    id: 'public-lands',
    name: 'Public lands',
    description: 'Federal and state land ownership from the USGS Protected Areas Database (PAD-US).',
    // ArcGIS dynamic map services are requested by bounding box rather than by
    // tile index; both GL libraries substitute {bbox-epsg-3857} for a WMS-style
    // request. `unverified` shows a caveat in the layer picker.
    tiles: ['https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image&layers=show:19,20,21,22,23'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.45,
    enabled: false,
    unverified: true,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'trails-hiking',
    name: 'Hiking routes',
    description: 'Waymarked hiking and long-distance trail routes from OpenStreetMap.',
    tiles: ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 18,
    opacity: 0.9,
    enabled: false,
    attribution: `${OSM_ATTRIBUTION}, routes by <a href="https://hiking.waymarkedtrails.org/">Waymarked Trails</a> (CC-BY-SA)`,
  },
  {
    id: 'trails-cycling',
    name: 'Cycling routes',
    description: 'Waymarked cycle route networks from OpenStreetMap.',
    tiles: ['https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 18,
    opacity: 0.9,
    enabled: false,
    attribution: `${OSM_ATTRIBUTION}, routes by <a href="https://cycling.waymarkedtrails.org/">Waymarked Trails</a> (CC-BY-SA)`,
  },
  {
    id: 'usgs-relief',
    name: 'Shaded relief',
    description: 'USGS terrain relief. An alternative to the Esri hillshade below.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.4,
    enabled: false,
    attribution: USGS_ATTRIBUTION,
  },
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
