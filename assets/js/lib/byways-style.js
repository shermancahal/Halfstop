/**
 * Byways Topo — a vector map style we own.
 *
 * Every other basemap in this app is somebody else's rendering: PNG tiles
 * arriving pre-coloured, with no way to change a shade or add a route shield
 * because there is nothing to change — we receive pixels, not data. This style
 * is the alternative. It draws Mapbox's vector tiles ourselves, so the palette,
 * the road hierarchy and the shields are all decisions made here.
 *
 * The palette leans on the two traditions worth stealing from:
 *
 * - National Geographic for the ground — warm cream land, muted sage forest,
 *   restrained water. A topo you can read a route across is one where the base
 *   recedes and the lines you care about come forward. Saturated greens fight
 *   the tracks drawn on top of them.
 * - Rand McNally for the roads — the hierarchy that makes a road atlas
 *   scannable at arm's length. Interstates blue, US routes red, state routes
 *   amber, everything else neutral, each with a casing so it holds up over
 *   imagery and shading.
 *
 * Unpaved roads and tracks are deliberately louder than either tradition would
 * have them, because this is a map for finding the road that is not paved.
 *
 * Requires a Mapbox token: the sources, glyphs and sprite are all Mapbox's.
 * Without one the app falls back to a raster topo — see config.js.
 */

/* ------------------------------------------------------------------ palette */

export const PALETTE = {
  land: '#f4efe4',
  landAlt: '#efe8d9',        // bare ground, sand
  forest: '#dfe6d3',
  forestDeep: '#d2dcc4',
  park: '#e2ead6',
  wetland: '#dde6dc',
  snow: '#f4f6f8',
  water: '#a8c8dd',
  waterDeep: '#93b9d2',
  waterLine: '#8fb4cd',

  contour: '#c2ab8b',
  contourIndex: '#a98f6b',
  hillshade: '#8a7a5f',

  interstate: '#3d6ea8',
  usRoute: '#b3402f',
  stateRoute: '#c98a2b',
  major: '#ffffff',
  minor: '#ffffff',
  unpaved: '#b98a52',
  track: '#a8702f',
  path: '#8a6b46',
  casing: '#cdbfa5',
  casingDark: '#a9977a',

  ink: '#2f2a22',
  inkSoft: '#5d5443',
  halo: '#f7f3e9',
  boundary: '#a596a0',
};

/** Ordered so the smallest roads are drawn first and the biggest end up on top. */
const ROAD_CLASSES = {
  motorway: { colour: PALETTE.interstate, base: 1.6, top: 8 },
  trunk: { colour: PALETTE.usRoute, base: 1.4, top: 6.5 },
  primary: { colour: PALETTE.stateRoute, base: 1.2, top: 5.5 },
  secondary: { colour: PALETTE.major, base: 1, top: 4.5 },
  tertiary: { colour: PALETTE.minor, base: 0.8, top: 3.8 },
};

const FONT = ['DIN Pro Regular', 'Arial Unicode MS Regular'];
const FONT_BOLD = ['DIN Pro Bold', 'Arial Unicode MS Bold'];

/** Interpolate a line width across zooms, so roads thicken as you come in. */
const width = (base, top) => [
  'interpolate', ['linear'], ['zoom'],
  5, base * 0.5,
  10, base,
  14, (base + top) / 2,
  18, top,
];

/* ------------------------------------------------------------------ style */

/**
 * Build the style.
 *
 * Everything is addressed by full https URL rather than the `mapbox://` short
 * form, because only Mapbox GL resolves that scheme — MapLibre would fail on
 * it, and which engine is running depends on configuration rather than on this
 * file.
 *
 * @param {string} token  A Mapbox public token.
 * @returns {object} A style-spec document.
 */
export function bywaysStyle(token) {
  if (!token) return null;
  const key = encodeURIComponent(token);
  const vector = (tileset) => ({
    type: 'vector',
    tiles: [`https://api.mapbox.com/v4/${tileset}/{z}/{x}/{y}.vector.pbf?access_token=${key}`],
    minzoom: 0,
    maxzoom: 14,
  });

  return {
    version: 8,
    name: 'Byways Topo',
    // Glyphs and sprite are required for any symbol layer. A style with labels
    // and no glyphs URL does not fail visibly — the labels simply never appear.
    glyphs: `https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${key}`,
    sprite: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite?access_token=${key}`,
    sources: {
      composite: vector('mapbox.mapbox-streets-v8'),
      terrain: vector('mapbox.mapbox-terrain-v2'),
    },
    layers: [
      ...groundLayers(),
      ...reliefLayers(),
      ...waterLayers(),
      ...roadLayers(),
      ...boundaryLayers(),
      ...labelLayers(),
      ...shieldLayers(),
    ],
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> '
      + '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  };
}

/* ---- ground ---- */

function groundLayers() {
  return [
    { id: 'background', type: 'background', paint: { 'background-color': PALETTE.land } },
    {
      id: 'landcover',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landcover',
      paint: {
        'fill-color': [
          'match', ['get', 'class'],
          'wood', PALETTE.forestDeep,
          'scrub', PALETTE.forest,
          'grass', PALETTE.park,
          'snow', PALETTE.snow,
          PALETTE.forest,
        ],
        // Fades in rather than switching on, so zooming out does not produce a
        // hard edge where the source's maxzoom stops.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 0.85],
        'fill-antialias': false,
      },
    },
    {
      id: 'national-park',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse_overlay',
      filter: ['==', ['get', 'class'], 'national_park'],
      paint: { 'fill-color': PALETTE.park, 'fill-opacity': 0.5 },
    },
    {
      id: 'landuse',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['park', 'grass', 'wood', 'scrub', 'sand'], true, false],
      paint: {
        'fill-color': [
          'match', ['get', 'class'],
          'sand', PALETTE.landAlt,
          'wood', PALETTE.forestDeep,
          PALETTE.park,
        ],
        'fill-opacity': 0.7,
      },
    },
  ];
}

/* ---- relief ---- */

function reliefLayers() {
  return [
    {
      id: 'hillshade',
      type: 'fill',
      source: 'terrain',
      'source-layer': 'hillshade',
      paint: {
        'fill-color': PALETTE.hillshade,
        // Terrain-v2 ships six shadow classes; only the darker ones earn their
        // keep here, since heavy shading buries the contours drawn over it.
        'fill-opacity': [
          'match', ['get', 'class'],
          'shadow', 0.09,
          'medium_shadow', 0.06,
          'faint_shadow', 0.03,
          0,
        ],
        'fill-antialias': false,
      },
    },
    {
      id: 'contour',
      type: 'line',
      source: 'terrain',
      'source-layer': 'contour',
      filter: ['!=', ['get', 'index'], 5],
      minzoom: 11,
      paint: {
        'line-color': PALETTE.contour,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 0.8],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.35, 13, 0.6],
      },
    },
    {
      id: 'contour-index',
      type: 'line',
      source: 'terrain',
      'source-layer': 'contour',
      filter: ['==', ['get', 'index'], 5],
      minzoom: 10,
      paint: {
        'line-color': PALETTE.contourIndex,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 1.4],
        'line-opacity': 0.75,
      },
    },
    {
      id: 'contour-label',
      type: 'symbol',
      source: 'terrain',
      'source-layer': 'contour',
      filter: ['==', ['get', 'index'], 5],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'],
        'text-font': FONT,
        'text-size': 9.5,
        'symbol-spacing': 320,
      },
      paint: {
        'text-color': PALETTE.contourIndex,
        'text-halo-color': PALETTE.halo,
        'text-halo-width': 1.2,
      },
    },
  ];
}

/* ---- water ---- */

function waterLayers() {
  return [
    {
      id: 'water',
      type: 'fill',
      source: 'composite',
      'source-layer': 'water',
      paint: { 'fill-color': PALETTE.water },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'composite',
      'source-layer': 'waterway',
      minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': PALETTE.waterLine,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 1.6, 18, 3],
      },
    },
  ];
}

/* ---- roads ---- */

/**
 * Roads, casings first.
 *
 * Two passes rather than one: every casing is drawn before every fill, so a
 * junction shows one road passing over another rather than each road's outline
 * cutting through its neighbour.
 */
function roadLayers() {
  const layers = [];

  // Tracks and unpaved roads sit under the sealed network but above terrain.
  // They are drawn dashed and in earth tones because on this map they are the
  // point, not an afterthought.
  layers.push({
    id: 'road-track',
    type: 'line',
    source: 'composite',
    'source-layer': 'road',
    filter: ['match', ['get', 'class'], ['track', 'service'], true, false],
    minzoom: 11,
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.track,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 1.6, 18, 3],
      'line-dasharray': [4, 2],
      'line-opacity': 0.85,
    },
  });

  layers.push({
    id: 'road-path',
    type: 'line',
    source: 'composite',
    'source-layer': 'road',
    filter: ['match', ['get', 'class'], ['path', 'pedestrian'], true, false],
    minzoom: 13,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.path,
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 18, 1.8],
      'line-dasharray': [2, 2],
    },
  });

  for (const [className, spec] of Object.entries(ROAD_CLASSES)) {
    layers.push({
      id: `road-${className}-casing`,
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      filter: ['==', ['get', 'class'], className],
      minzoom: className === 'motorway' ? 4 : className === 'trunk' ? 5 : 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': className === 'secondary' || className === 'tertiary'
          ? PALETTE.casing
          : PALETTE.casingDark,
        'line-width': width(spec.base + 1.4, spec.top + 2.6),
      },
    });
  }

  for (const [className, spec] of Object.entries(ROAD_CLASSES)) {
    layers.push({
      id: `road-${className}`,
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      filter: ['==', ['get', 'class'], className],
      minzoom: className === 'motorway' ? 4 : className === 'trunk' ? 5 : 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': spec.colour, 'line-width': width(spec.base, spec.top) },
    });
  }

  layers.push({
    id: 'road-street',
    type: 'line',
    source: 'composite',
    'source-layer': 'road',
    filter: ['match', ['get', 'class'], ['street', 'street_limited'], true, false],
    minzoom: 12,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 2.4, 18, 4],
    },
  });

  return layers;
}

/* ---- boundaries ---- */

function boundaryLayers() {
  return [
    {
      id: 'boundary-state',
      type: 'line',
      source: 'composite',
      'source-layer': 'admin',
      filter: ['all', ['==', ['get', 'admin_level'], 1], ['==', ['get', 'maritime'], 'false']],
      paint: {
        'line-color': PALETTE.boundary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 10, 1.6],
        'line-dasharray': [3, 1.5],
      },
    },
    {
      id: 'boundary-country',
      type: 'line',
      source: 'composite',
      'source-layer': 'admin',
      filter: ['all', ['<=', ['get', 'admin_level'], 0], ['==', ['get', 'maritime'], 'false']],
      paint: {
        'line-color': PALETTE.boundary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 10, 2.2],
      },
    },
  ];
}

/* ---- labels ---- */

function labelLayers() {
  return [
    {
      id: 'label-water',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'natural_label',
      filter: ['match', ['get', 'class'], ['lake', 'ocean', 'sea', 'river'], true, false],
      minzoom: 7,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 14, 13],
        'text-max-width': 8,
      },
      paint: {
        'text-color': '#5c7f96',
        'text-halo-color': PALETTE.halo,
        'text-halo-width': 1.1,
      },
    },
    {
      id: 'label-summit',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'natural_label',
      filter: ['match', ['get', 'class'], ['landform'], true, false],
      minzoom: 11,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': 11,
        'text-offset': [0, 0.6],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': PALETTE.inkSoft,
        'text-halo-color': PALETTE.halo,
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'label-road',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'road',
      filter: ['match', ['get', 'class'],
        ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'track'], true, false],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 18, 12],
      },
      paint: {
        'text-color': PALETTE.inkSoft,
        'text-halo-color': PALETTE.halo,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'label-place',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'place_label',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT_BOLD,
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          4, ['match', ['get', 'class'], 'settlement', 11, 9],
          12, ['match', ['get', 'class'], 'settlement', 16, 12],
        ],
        'text-max-width': 7,
      },
      paint: {
        'text-color': PALETTE.ink,
        'text-halo-color': PALETTE.halo,
        'text-halo-width': 1.5,
      },
    },
  ];
}

/* ---- route shields ---- */

/**
 * US route shields.
 *
 * This is the part raster tiles cannot give you at any price. Mapbox Streets
 * tags each road with `shield` (which design), `ref` (the number on it) and
 * `reflen` (how many characters it has), and the Mapbox sprite carries an image
 * for every combination — `us-interstate-2`, `us-highway-3` and so on. Building
 * the image name from the feature's own fields is what makes an I-40 marker
 * look like an interstate marker rather than a generic label.
 *
 * `icon-image` falls back to the `default-<n>` rectangle for anything without a
 * recognised shield design, so an unusual state route still gets a marker
 * rather than vanishing.
 */
function shieldLayers() {
  return [
    {
      id: 'road-shield',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'road',
      filter: ['all',
        ['has', 'ref'],
        ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
      ],
      minzoom: 7,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 250,
        'icon-image': [
          'coalesce',
          ['image', ['concat', ['get', 'shield'], '-', ['to-string', ['get', 'reflen']]]],
          ['image', ['concat', 'default-', ['to-string', ['get', 'reflen']]]],
        ],
        'icon-size': 0.9,
        'text-field': ['get', 'ref'],
        'text-font': FONT_BOLD,
        'text-size': 9,
        'symbol-avoid-edges': true,
        'icon-allow-overlap': false,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['match', ['get', 'shield'],
          'us-interstate', '#ffffff',
          PALETTE.ink,
        ],
      },
    },
  ];
}
