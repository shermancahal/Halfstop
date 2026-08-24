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
 * - Rand McNally for contrast and hierarchy. An atlas is read in a moving
 *   vehicle in bad light, so nothing in it is subtle: parchment land, gold and
 *   red roads, one deep brown for every structural line. The first version of
 *   this style used pastels and washed out completely — pale ground, pale
 *   contours, pale roads, nothing for the eye to catch.
 * - National Geographic for the terrain — tan and brown ground with muted
 *   green woodland, rather than the grey-and-white of a street map. It is the
 *   colouring that makes relief legible without shouting.
 *
 * Unpaved roads and tracks are deliberately louder than either tradition would
 * have them, because this is a map for finding the road that is not paved.
 *
 * Requires a Mapbox token: the sources, glyphs and sprite are all Mapbox's.
 * Without one the app falls back to a raster topo — see config.js.
 */

import { shieldImageExpression, SHIELD_TEXT_COLOUR } from './route-shields.js';

/* ------------------------------------------------------------------ palette */

export const PALETTE = {
  // Anchored on the Rand McNally atlas values, which are considerably more
  // saturated than the pastels this started with. The first version washed out:
  // pale land, pale contours, pale roads, nothing to fix your eye on. Contrast
  // is the whole point of an atlas — you read it in a moving vehicle in bad
  // light — so the ground is a real parchment tan, not cream, and the contours
  // and boundaries are the deep brown that keeps them legible over it.
  land: '#D1BE9D',           // base landmass — warm parchment
  landPale: '#DCCDB2',       // open ground, one step lighter for figure/ground
  landAlt: '#E0D3B8',        // sand, bare rock
  urban: '#B9A37E',          // built-up areas — the darker wicker tone
  forest: '#82A775',         // parks, national forest, protected land
  forestDeep: '#6E9463',     // dense woodland
  park: '#93B487',
  snow: '#EFF3F5',

  water: '#3B727C',          // oceans, large lakes
  waterDeep: '#2F5F68',
  waterLine: '#3B727C',

  // #64513B does triple duty in the reference palette: contours, state lines
  // and map grids. Using one dark brown for all the structural linework is
  // what makes the atlas read as one drawing rather than three overlays.
  contour: '#8A7355',
  contourIndex: '#64513B',
  hillshade: '#5A4834',
  boundary: '#64513B',

  // Road colours follow the atlas conventions rather than a scheme of their
  // own: an interstate is blue on every US road map ever printed, a US route
  // red, a state route amber. The first pass used three warm tones a step apart
  // — rose, orange, gold — which was pleasant and told you nothing, because on
  // parchment they read as one colour at speed.
  interstate: '#2E5C9A',     // interstate blue
  usRoute: '#C0392B',        // US routes — atlas red
  stateRoute: '#E09B2D',     // state routes — atlas amber
  major: '#FFFFFF',          // two-lane paved, white against its casing
  minor: '#FDFBF6',
  unpaved: '#8C5A28',
  track: '#8C5A28',
  path: '#6B5335',
  casing: '#8A7355',
  casingDark: '#64513B',

  ink: '#2A2118',
  inkSoft: '#4A3D2E',
  halo: '#F2E9D6',
};

/** Ordered so the smallest roads are drawn first and the biggest end up on top. */
/*
 * The road hierarchy, and the thing this style is for.
 *
 * Widths were roughly half these and the result read as faint — a motorway at
 * 1.6px on a parchment ground is a hairline, and at trip-planning zooms the
 * whole network disappeared into the terrain. An atlas is read in a moving
 * vehicle in bad light; the roads are the figure and everything else is the
 * ground.
 *
 * Colours are the atlas convention rather than an invention: interstates in
 * their own strong blue, US routes red, state routes amber, and everything
 * paved below that in white with a dark casing so it reads as road rather than
 * as a trail. The two-lane roads a byway actually runs on — secondary and
 * tertiary — are deliberately not the thinnest thing on the map.
 */
const ROAD_CLASSES = {
  motorway: { colour: PALETTE.interstate, base: 3.4, top: 13 },
  trunk: { colour: PALETTE.usRoute, base: 2.8, top: 11 },
  primary: { colour: PALETTE.stateRoute, base: 2.4, top: 9.5 },
  secondary: { colour: PALETTE.major, base: 2, top: 8 },
  tertiary: { colour: PALETTE.minor, base: 1.5, top: 6.5 },
};

/**
 * The name to draw for a feature.
 *
 * `name_en` first, falling back to the local name. Two reasons: a US atlas
 * reads better in one script, and Mapbox GL cannot fetch glyphs for characters
 * above U+FFFF — it raises "glyphs > 65535 not supported" once per affected
 * tile and draws nothing for that label. Preferring the Latin name avoids most
 * of those before they happen.
 */
const LABEL_NAME = ['coalesce', ['get', 'name_en'], ['get', 'name']];

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
      /*
       * Shields BEFORE the other labels, and the order is the whole fix.
       *
       * GL resolves symbol collisions in layer order: whatever is placed first
       * keeps its spot and everything after it moves or disappears. With
       * shields last, every water name, summit, road name and place label got
       * there first, and on any map with labels on it the shields were the
       * thing that gave way — which is exactly backwards for a road map, where
       * the shield is the most useful label on the road.
       */
      ...shieldLayers(),
      ...labelLayers(),
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
          'shadow', 0.16,
          'medium_shadow', 0.11,
          'faint_shadow', 0.055,
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
      minzoom: 10,
      paint: {
        'line-color': PALETTE.contour,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 13, 0.75],
      },
    },
    {
      id: 'contour-index',
      type: 'line',
      source: 'terrain',
      'source-layer': 'contour',
      filter: ['==', ['get', 'index'], 5],
      minzoom: 9,
      paint: {
        'line-color': PALETTE.contourIndex,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 16, 1.7],
        'line-opacity': 0.9,
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
        /*
         * Every class gets the dark casing, not just the coloured ones. White
         * roads on parchment with a mid-brown edge were the faintest thing on
         * the map, and secondary and tertiary are the two-lane roads a byway
         * actually runs on — the ones that most need to be findable.
         */
        'line-color': PALETTE.casingDark,
        'line-width': width(spec.base + 1.6, spec.top + 3.2),
      },
    });
  }

  layers.push({
    id: 'road-street-casing',
    type: 'line',
    source: 'composite',
    'source-layer': 'road',
    filter: ['match', ['get', 'class'], ['street', 'street_limited'], true, false],
    minzoom: 11,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.casing,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 16, 5, 18, 7.5],
    },
  });

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
    minzoom: 11,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 3.2, 18, 5.4],
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
        'text-field': LABEL_NAME,
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
        'text-field': LABEL_NAME,
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
        'text-field': LABEL_NAME,
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
        'text-field': LABEL_NAME,
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
      minzoom: 6,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 6, 180, 12, 260],
        // Images we generate and register ourselves — see lib/route-shields.js
        // for why this does not go through the Mapbox sprite.
        'icon-image': shieldImageExpression(),
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.85, 12, 1.05],
        'icon-rotation-alignment': 'viewport',
        'text-field': ['get', 'ref'],
        'text-font': FONT_BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9, 12, 11],
        'text-rotation-alignment': 'viewport',
        'text-anchor': 'center',
        /*
         * The shield and its number are one thing and are drawn on the same
         * terms. They were not: the number was set to ignore collisions
         * entirely while the shield behind it was not, so wherever the shield
         * lost a collision the bare number stayed — which is precisely the
         * "the shields turned into text labels" that got reported.
         *
         * Both now always draw, and neither ignores placement, so other labels
         * route around them instead of over them.
         */
        'icon-allow-overlap': true,
        'icon-ignore-placement': false,
        'text-allow-overlap': true,
        'text-ignore-placement': false,
        'text-optional': false,
        'icon-optional': false,
        // An interstate marker outranks a county route when they land together.
        'symbol-sort-key': ['match', ['get', 'class'],
          'motorway', 1, 'trunk', 2, 'primary', 3, 4],
      },
      paint: { 'text-color': SHIELD_TEXT_COLOUR },
    },
  ];
}
