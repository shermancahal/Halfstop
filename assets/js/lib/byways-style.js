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

import {
  shieldImageExpression, shieldTextColour,
  shieldTextSizeExpression, shieldTextOffsetExpression, shieldDisplayWidth,
} from './route-shields.js';

/* ------------------------------------------------------------------ schema */

/**
 * Where this style expects to find things in the tiles it is drawn over.
 *
 * The cartography here is ours; the geometry is rented. Byways Topo has always
 * read Mapbox Streets v8 directly - `source-layer: 'road'`, `['get','class']`
 * with Mapbox's own class values - which is fine while there is one source and
 * becomes twenty-five scattered assumptions the moment there are two.
 *
 * Protomaps, which is the source that can be self-hosted and downloaded,
 * describes the same world with a different vocabulary. Its layers are earth,
 * landcover, landuse, roads, water, buildings, boundaries, pois and places -
 * read off the published package rather than guessed - and it has no contour
 * layer at all, which is a real gap rather than a renaming.
 *
 * So the names live here, in one object, and the style reads them. This commit
 * changes nothing about what is drawn: the Mapbox schema below is the same set
 * of strings that were inline, and a snapshot test compares the whole
 * generated style against what it produced before to prove it.
 */
export const MAPBOX_SCHEMA = {
  id: 'mapbox',
  source: 'composite',
  reliefSource: 'terrain',
  layers: {
    landcover: 'landcover',
    landuse: 'landuse',
    landuseOverlay: 'landuse_overlay',
    water: 'water',
    waterway: 'waterway',
    road: 'road',
    place: 'place_label',
    natural: 'natural_label',
    boundary: 'admin',
    contour: 'contour',
    hillshade: 'hillshade',
  },
  fields: {
    roadClass: 'class',
    ref: 'ref',
    refLength: 'reflen',
    shield: 'shield',
    name: 'name',
    nameEn: 'name_en',
    surface: 'surface',
    elevation: 'ele',
  },
};

/**
 * The same world, described by Protomaps.
 *
 * Layer names read from the published package; the attribute names read from
 * the get expressions in it rather than from prose about it.
 *
 * Two findings changed the estimate, both in our favour. Protomaps precomputes
 * `shield_text` - the number already stripped of its system - and `network`,
 * which says whose number it is: US:I, US:US, US:KY. Mapbox's `shield` field
 * only ever gave a shape, and the state had to be inferred from wherever the
 * map happened to be looking, which is wrong within a few miles of a border.
 * Under this schema a road says which network it belongs to, so the shield can
 * stop guessing.
 *
 * The gaps are real and named rather than papered over. There is no contour
 * layer and no hillshade - the USGS contour overlay already in the catalogue
 * is the answer for the first, and terrain relief is already its own overlay.
 * `null` here means "this schema cannot draw that", and the style is expected
 * to skip the layer rather than ask for a source-layer that does not exist and
 * silently draw nothing.
 *
 * `natural` is marked uncertain on purpose. Mapbox's natural_label carries
 * peaks and water names; whether those live in Protomaps' places or its pois
 * has not been established, and writing a guess here would produce exactly the
 * silent blank this file exists to avoid.
 */
export const PROTOMAPS_SCHEMA = {
  id: 'protomaps',
  source: 'protomaps',
  reliefSource: null,
  layers: {
    landcover: 'landcover',
    landuse: 'landuse',
    // Protomaps has one landuse layer rather than a base and an overlay.
    landuseOverlay: null,
    water: 'water',
    // Rivers and coastline are the same layer here, told apart by `kind`.
    waterway: 'water',
    road: 'roads',
    place: 'places',
    natural: null,
    boundary: 'boundaries',
    contour: null,
    hillshade: null,
  },
  fields: {
    // `kind` is the universal classification field, where Mapbox uses `class`.
    roadClass: 'kind',
    ref: 'ref',
    refLength: null,
    // Not a shape but a network: US:I, US:US, US:KY. Richer than what it
    // replaces, and the reason the shield work mostly survives.
    shield: 'network',
    shieldText: 'shield_text',
    name: 'name',
    nameEn: 'name:en',
    surface: null,
    elevation: null,
  },
};

/*
 * The schema in force while a style is being built.
 *
 * A module-level binding rather than an argument threaded through thirty
 * functions: every layer builder here is a nullary function called once, in
 * order, from one place. When the Protomaps schema arrives this becomes what
 * `bywaysStyle` sets before it calls them.
 */
let S = MAPBOX_SCHEMA;

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

/*
 * Whether the road is unsealed.
 *
 * `surface` is the only surface detail in Mapbox Streets — paved or unpaved,
 * and only where OpenStreetMap has it — so gravel, dirt and sand all arrive
 * here as the same word. That is worth saying plainly rather than implying a
 * precision the tiles do not carry: this map can tell you a road is not sealed,
 * not what it is made of. Severity is not in there at all; the Forest Service
 * MVUM overlay is where the legal and practical status of a forest road lives.
 */
const UNPAVED = ['==', ['get', 'surface'], 'unpaved'];

/** Roads that are drawn solid, and so have something for a dash to sit on. */
const SEALED_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'street_limited'];

const FONT = ['DIN Pro Regular', 'Arial Unicode MS Regular'];
const FONT_BOLD = ['DIN Pro Bold', 'Arial Unicode MS Bold'];

/** Interpolate a line width across zooms, so roads thicken as you come in. */
/*
 * Ramps.
 *
 * Mapbox Streets tags a slip road as its own class — `motorway_link`,
 * `trunk_link` and so on — and the road layers matched the class exactly, so
 * every ramp in the country was missing from this style while showing up fine
 * on Street. An interchange drawn without its ramps is two roads crossing.
 *
 * They are drawn at roughly half the width of the road they serve: a ramp is
 * part of the interchange, not a second motorway.
 */
const LINK_SCALE = 0.55;

const linkOf = (className) => `${className}_link`;

/** Matches a road class and the ramps that belong to it. */
const roadFilter = (className) => [
  'match', ['get', 'class'], [className, linkOf(className)], true, false,
];

/**
 * Full width on the mainline, narrower on its ramps.
 *
 * The interpolation has to be the outermost expression — GL rejects a `zoom`
 * expression nested inside anything but a top-level `step` or `interpolate`,
 * and rejecting means the style does not load at all — so the choice between
 * ramp and mainline happens at each stop rather than around the whole curve.
 */
const roadWidth = (className, base, top) => {
  const isLink = ['==', ['get', 'class'], linkOf(className)];
  const pick = (value) => ['case', isLink, value * LINK_SCALE, value];
  return [
    'interpolate', ['linear'], ['zoom'],
    5, pick(base * 0.5),
    10, pick(base),
    14, pick((base + top) / 2),
    18, pick(top),
  ];
};

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
  /*
   * Each tileset's own depth, not one number for both.
   *
   * This said 14 for everything, and 14 is neither tileset's real limit —
   * streets-v8 goes to 16 and terrain-v2 to 15, read from their TileJSON rather
   * than assumed. Declaring less than a tileset has does not fail, it degrades
   * silently: past the declared maxzoom GL stops fetching and stretches the last
   * tile it has.
   *
   * For a fill or a line that is merely soft. For symbols it is worse, because
   * `symbol-spacing` is resolved at the tile's own zoom and then scaled with the
   * tile. 260px of spacing baked in at z14 is about a thousand on screen at z16
   * and four thousand at z18 — far enough apart that a road can cross the whole
   * viewport without a shield landing on it. That is what "the route numbers
   * disappear when I zoom in" was.
   *
   * Overstating it would be the worse mistake in the other direction: GL would
   * request tiles that 404 and no roads would draw at all. Hence the numbers
   * come from the service, and there is a test below holding them there.
   */
  const DEPTH = { 'mapbox.mapbox-streets-v8': 16, 'mapbox.mapbox-terrain-v2': 15 };
  const vector = (tileset) => ({
    type: 'vector',
    tiles: [`https://api.mapbox.com/v4/${tileset}/{z}/{x}/{y}.vector.pbf?access_token=${key}`],
    minzoom: 0,
    maxzoom: DEPTH[tileset] ?? 14,
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
       * Shields last, which is both the draw order and the placement order.
       *
       * GL uses layer order for two things at once: symbols in an earlier layer
       * are placed first and keep their spot, and symbols in a later layer are
       * painted on top. Those pull in opposite directions here.
       *
       * They were first, so that the shields won collisions instead of giving
       * way to every water name and place label — which was the right fix for
       * the wrong lever. Winning a collision was never the issue: these layers
       * set `icon-allow-overlap` and `text-allow-overlap`, so a shield draws
       * whatever else is already there. What being first cost was the paint
       * order, and a road name painted across a route marker is exactly what
       * got reported.
       *
       * Last, then: still always drawn, and now over the road's name rather
       * than under it.
       */
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
      'source-layer': S.layers.landcover,
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
      'source-layer': S.layers.landuseOverlay,
      filter: ['==', ['get', 'class'], 'national_park'],
      paint: { 'fill-color': PALETTE.park, 'fill-opacity': 0.5 },
    },
    {
      id: 'landuse',
      type: 'fill',
      source: 'composite',
      'source-layer': S.layers.landuse,
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
      'source-layer': S.layers.hillshade,
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
      'source-layer': S.layers.contour,
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
      'source-layer': S.layers.contour,
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
      'source-layer': S.layers.contour,
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
      'source-layer': S.layers.water,
      paint: { 'fill-color': PALETTE.water },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'composite',
      'source-layer': S.layers.waterway,
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
    'source-layer': S.layers.road,
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
    'source-layer': S.layers.road,
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
      'source-layer': S.layers.road,
      filter: roadFilter(className),
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
        'line-width': roadWidth(className, spec.base + 1.6, spec.top + 3.2),
      },
    });
  }

  layers.push({
    id: 'road-street-casing',
    type: 'line',
    source: 'composite',
    'source-layer': S.layers.road,
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
      'source-layer': S.layers.road,
      filter: roadFilter(className),
      minzoom: className === 'motorway' ? 4 : className === 'trunk' ? 5 : 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': spec.colour, 'line-width': roadWidth(className, spec.base, spec.top) },
    });
  }

  layers.push({
    id: 'road-street',
    type: 'line',
    source: 'composite',
    'source-layer': S.layers.road,
    filter: ['match', ['get', 'class'], ['street', 'street_limited'], true, false],
    minzoom: 11,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 3.2, 18, 5.4],
    },
  });

  /*
   * Unpaved roads, marked on top of whatever they are.
   *
   * A gravel county road is drawn the same as a sealed one by class alone, and
   * on this map that is the difference between a drive and a decision. Tracks
   * and paths are left out: they are already dashed, and a second dash over the
   * first reads as neither.
   */
  layers.push({
    id: 'road-unpaved',
    type: 'line',
    source: 'composite',
    'source-layer': S.layers.road,
    filter: ['all', UNPAVED, ['match', ['get', 'class'], SEALED_CLASSES, true, false]],
    minzoom: 9,
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.track,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 1.5, 18, 2.6],
      'line-dasharray': [1, 2.4],
      'line-opacity': 0.9,
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
      'source-layer': S.layers.boundary,
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
      'source-layer': S.layers.boundary,
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
      'source-layer': S.layers.natural,
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
      'source-layer': S.layers.natural,
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
      'source-layer': S.layers.road,
      filter: ['match', ['get', 'class'],
        ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'track'], true, false],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        // The surface rides along with the name. A forest road's number tells
        // you nothing about whether you want to be on it; "unpaved" does.
        'text-field': ['case',
          ['all', UNPAVED, ['has', 'name']], ['concat', LABEL_NAME, ' \u00b7 unpaved'],
          LABEL_NAME],
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
      // Trails carry names worth reading — and they are the routes this map is
      // for. They come in later than roads because a trail name at z13 is
      // clutter over a county.
      id: 'label-trail',
      type: 'symbol',
      source: 'composite',
      'source-layer': S.layers.road,
      filter: ['all',
        ['match', ['get', 'class'], ['path', 'service'], true, false],
        ['has', 'name'],
      ],
      minzoom: 14,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['case',
          UNPAVED, ['concat', LABEL_NAME, ' \u00b7 unpaved'],
          LABEL_NAME],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 8.5, 18, 11],
      },
      paint: {
        'text-color': PALETTE.path,
        'text-halo-color': PALETTE.halo,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'label-place',
      type: 'symbol',
      source: 'composite',
      'source-layer': S.layers.place,
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

/*
 * Concurrencies — one road carrying two route numbers — reach us as a single
 * feature with `ref` of "23-60" and a `shield` of `us-highway-duplex`. Drawn as
 * one shield that is a marker reading 23-60, which is not a sign that exists
 * anywhere. Two markers is what the road actually has on it.
 *
 * Both halves have to be present to split: a `-duplex` shield is the tag that
 * says the hyphen is a separator rather than part of a number.
 */
/*
 * The number, without the system that issued it.
 *
 * A route marker carries a number: the shape around it is what says which
 * system numbered it, which is the whole point of a shield being a shape.
 * Tiles hand us the raw OSM ref, and in most states that carries the prefix —
 * "SR 61" in Tennessee, "KY 15", "US 27" — so the marker read "SR 61" inside a
 * state-route blank, which is a sign that exists nowhere.
 *
 * The rule used to be "one or two characters", which covers I, US, SR and the
 * state codes and stops at three — where it would start eating road names that
 * lead with a short word, "Old 61" among them, in which the first word is the
 * name rather than the system.
 *
 * That length limit left FSR 300 reading "FSR 300" in a shield sized for three
 * characters. The distinction was never really length: a route system is
 * written in capitals and a name is not. So the test is now that the first
 * token is all upper case and contains a letter — FSR, NF, CR, US, KY all
 * qualify; "Old" does not, because upcasing it changes it.
 *
 * The letter check matters: "300 Spur" would otherwise lose its 300, since
 * upcasing a number changes nothing and the token would look like a system.
 *
 * Hyphens count as separators too, so NF-9 loses its NF the same way FSR 9
 * does. Forest roads are signed both ways and neither spelling is the number.
 *
 * It also fixes the blank: the image is chosen by how many characters the
 * number has, so "SR 61" was asking for a five-character shield that no state
 * publishes.
 */
const RAW_REF = ['coalesce', ['get', 'ref'], ''];
const PREFIXLESS = ['let', 'raw', RAW_REF,
  'space', ['index-of', ' ', RAW_REF],
  'dash', ['index-of', '-', RAW_REF],
  ['let', 'cut',
    // The first separator of either kind, ignoring the one that is absent.
    ['case',
      ['<', ['var', 'space'], 0], ['var', 'dash'],
      ['<', ['var', 'dash'], 0], ['var', 'space'],
      ['min', ['var', 'space'], ['var', 'dash']]],
    ['let', 'head', ['slice', ['var', 'raw'], 0, ['max', 0, ['var', 'cut']]],
      ['case',
        ['all',
          ['>', ['var', 'cut'], 0],
          ['>', ['length', ['var', 'raw']], ['+', ['var', 'cut'], 1]],
          ['==', ['upcase', ['var', 'head']], ['var', 'head']],
          ['!=', ['downcase', ['var', 'head']], ['var', 'head']]],
        ['slice', ['var', 'raw'], ['+', ['var', 'cut'], 1]],
        ['var', 'raw']]]],
];

/*
 * The designation that rides on a banner, not in the shield.
 *
 * "US 40 Scenic" loses its US to the rule above and keeps the Scenic, so the
 * shield read "40 Scenic". On the road that word is a separate plate bolted
 * above the marker; the marker itself says 40. Business, Alternate, Bypass,
 * Truck and Spur all work the same way, which is why this is a list rather
 * than a special case for one road in Maryland.
 *
 * Only a known designation is cut. "Old 61" keeps its Old - the word carries
 * the route's identity there rather than qualifying it, and a blanket rule
 * that dropped everything after a space would have eaten it.
 */
/*
 * The leading token, on its own, so two rules can read it.
 *
 * `PREFIXLESS` throws it away and `REF_DESIGN` needs to look at it, and
 * recomputing the separator in two places is how the two would quietly come to
 * disagree about where a ref splits.
 */
const SEPARATOR = ['let',
  'space', ['index-of', ' ', RAW_REF],
  'dash', ['index-of', '-', RAW_REF],
  ['case',
    ['<', ['var', 'space'], 0], ['var', 'dash'],
    ['<', ['var', 'dash'], 0], ['var', 'space'],
    ['min', ['var', 'space'], ['var', 'dash']]],
];

const HEAD = ['let', 'cut', SEPARATOR,
  ['case', ['>', ['var', 'cut'], 0], ['slice', RAW_REF, 0, ['var', 'cut']], '']];

/*
 * Which of the two ref-chosen designs this road wants, or nothing.
 *
 * Read from the number because nothing else knows. Mapbox does not mark a
 * route as scenic, and a forest road arrives as an unclaimed number
 * indistinguishable from a county road - so "FSR 300" and "US 40 Scenic" are
 * the only evidence there is, and they are good evidence.
 *
 * Forest first: a road could in principle be both, and the trapezoid says more
 * about where you are than the brown does.
 */
const FOREST_SYSTEMS = ['FSR', 'FR', 'NF', 'FH', 'FDR', 'NFSR'];
const SCENIC_SUFFIX = ' Scenic';
const REF_DESIGN = ['case',
  ['in', HEAD, ['literal', FOREST_SYSTEMS]], 'forest',
  ['all',
    // Guarded, because slicing from a negative start on a short ref is not a
    // question worth asking of the expression evaluator.
    ['>', ['length', RAW_REF], SCENIC_SUFFIX.length],
    ['==', ['slice', RAW_REF, ['-', ['length', RAW_REF], SCENIC_SUFFIX.length]], SCENIC_SUFFIX]],
  'scenic',
  ''];

const DESIGNATIONS = ['Scenic', 'Business', 'Alternate', 'Alt', 'Bypass', 'Byp',
  'Truck', 'Spur', 'Loop', 'Connector', 'Conn', 'Bus'];
/*
 * Tested against the end of the string, not the tail after the first space.
 *
 * The first attempt cut at the first gap, which works for "40 Scenic" and
 * fails for "Old 61 Scenic" - there the tail is "61 Scenic", not a designation,
 * so nothing was stripped. Checking each designation against the ending gets
 * both, and leaves "80 East" alone because a direction is not a designation.
 *
 * A stem shorter than the word being tested slices from the end rather than
 * underflowing, which cannot match a string beginning with a space, so short
 * refs fall through untouched.
 */
const REF = ['let', 'stem', PREFIXLESS,
  ['case',
    ...DESIGNATIONS.flatMap((word) => [
      ['==', ['slice', ['var', 'stem'], ['-', ['length', ['var', 'stem']], word.length + 1]], ` ${word}`],
      ['slice', ['var', 'stem'], 0, ['-', ['length', ['var', 'stem']], word.length + 1]],
    ]),
    ['var', 'stem']],
];
const REF_CUT = ['index-of', '-', REF];
const IS_DUPLEX = ['all',
  ['>', REF_CUT, 0],
  ['in', 'duplex', ['coalesce', ['get', 'shield'], '']],
];
const FIRST_REF = ['slice', REF, 0, REF_CUT];
// A three-way concurrency would leave "60-119" behind the first hyphen, so the
// second shield stops at the next one.
const SECOND_REF = ['let', 'rest', ['slice', REF, ['+', REF_CUT, 1]],
  ['case',
    ['>', ['index-of', '-', ['var', 'rest']], 0],
    ['slice', ['var', 'rest'], 0, ['index-of', '-', ['var', 'rest']]],
    ['var', 'rest']],
];

// An interstate marker outranks a county route where they land together.
const SHIELD_ORDER = ['match', ['get', 'class'],
  'motorway', 1, 'trunk', 2, 'primary', 3, 'secondary', 4, 5];

/** Every shield layer's id, and how far off centre its number sits. */
export const SHIELD_LAYERS = [
  /*
   * The plain shield measures the number it carries, like the halves below.
   *
   * It used to pass null and fall back to the tile's `reflen`, which is the
   * length of the raw ref — and the raw ref carries the system, so a stripped
   * "SR 61" would have gone on asking for a four-wide sign to hold two digits
   * every time the map crossed a state line.
   */
  { id: 'road-shield', shift: 0, length: ['length', REF] },
  { id: 'road-shield-first', shift: -(shieldDisplayWidth(2) / 2 + 1), length: ['length', FIRST_REF] },
  { id: 'road-shield-second', shift: shieldDisplayWidth(2) / 2 + 1, length: ['length', SECOND_REF] },
];

/**
 * What to set on each shield layer when the map crosses into another state.
 *
 * The marker, the size of its number and where that number sits are one design
 * decision, and they are made here rather than at the call site — the two
 * halves of a concurrency carry a sideways shift the plain shield does not, and
 * a caller updating only the plain one is how the halves came to keep the
 * previous state's marker after a border crossing.
 */
export function shieldLayerUpdates(state = '') {
  return SHIELD_LAYERS.map(({ id, shift, length }) => ({
    id,
    layout: {
      // Sized from the number it is actually carrying, exactly as the layer
      // was built — half of a concurrency is as wide as its own half.
      'icon-image': shieldImageExpression(state, { length, override: REF_DESIGN }),
      'text-size': shieldTextSizeExpression(state, 2, length),
      'text-offset': shieldTextOffsetExpression(state, 2, shift, { override: REF_DESIGN }),
    },
    paint: { 'text-color': shieldTextColour(state, { override: REF_DESIGN }) },
  }));
}

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
function shieldLayers(state = '') {
  /*
   * Tertiary is in here, and its absence is why state route markers were
   * missing across whole states. Mapbox classes a road by what it carries, not
   * by who numbered it: a two-lane state highway through farmland is `tertiary`
   * as often as it is `secondary`, and in Kentucky, Vermont or West Virginia
   * that is most of the state network. Leaving it out meant the shields drew
   * for the interstates and US routes — which are never tertiary — and for
   * almost nothing else, which reads exactly like a broken feature.
   *
   * It costs nothing at low zoom: tertiary roads are not in the tiles until
   * z8, so the layer has nothing to draw before then anyway.
   */
  const onARoad = ['match', ['get', 'class'],
    ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false];

  /** Half a concurrency: its own number, its own image, shifted off centre. */
  const half = (id, text, shiftPx) => ({
    id,
    type: 'symbol',
    source: 'composite',
    'source-layer': S.layers.road,
    filter: ['all', ['has', 'ref'], onARoad, IS_DUPLEX],
    minzoom: 6,
    layout: {
      'symbol-placement': 'line',
      // Eased off at the top so the overzoom that still happens above the
        // tileset's own maxzoom has somewhere to go: 220 at z16 is 880 on
        // screen at z18, where 260 would have been over a thousand.
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 6, 170, 14, 220],
      'icon-image': shieldImageExpression(state, { length: ['length', text], override: REF_DESIGN }),
      'icon-size': 1,
      'icon-offset': [shiftPx, 0],
      'icon-rotation-alignment': 'viewport',
      'text-field': text,
      'text-font': FONT_BOLD,
      'text-size': shieldTextSizeExpression(state, 2, ['length', text]),
      'text-offset': shieldTextOffsetExpression(state, 2, shiftPx, { override: REF_DESIGN }),
      'text-rotation-alignment': 'viewport',
      'text-anchor': 'center',
      'icon-allow-overlap': true,
      'icon-ignore-placement': false,
      'text-allow-overlap': true,
      'text-ignore-placement': false,
      'text-optional': false,
      'icon-optional': false,
      'symbol-sort-key': SHIELD_ORDER,
    },
    paint: { 'text-color': shieldTextColour(state, { override: REF_DESIGN }) },
  });

  // Half a shield's width each way, plus a pixel so the two do not touch.
  const apart = shieldDisplayWidth(2) / 2 + 1;

  return [
    {
      id: 'road-shield',
      type: 'symbol',
      source: 'composite',
      'source-layer': S.layers.road,
      filter: ['all',
        ['has', 'ref'],
        onARoad,
        ['!', IS_DUPLEX],
      ],
      minzoom: 6,
      layout: {
        'symbol-placement': 'line',
        // Eased off at the top so the overzoom that still happens above the
        // tileset's own maxzoom has somewhere to go: 220 at z16 is 880 on
        // screen at z18, where 260 would have been over a thousand.
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 6, 170, 14, 220],
        // Images we generate and register ourselves — see lib/route-shields.js
        // for why this does not go through the Mapbox sprite.
        //
        // Built with the state, like every other property on this layer. It
        // used to be the one that ignored the argument, so a style built for a
        // known state drew the number at that state's size and offset on a
        // generic blank — half-applied, which looks like a design mistake
        // rather than a bug.
        /*
         * Sized from the number we draw, not from the tile's `reflen`.
         *
         * `reflen` is the length of the raw ref, so a stripped "SR 61" asked
         * for a four-wide blank to hold two digits — a wide sign with a small
         * number floating in the middle of it. The concurrency layers have
         * always measured their own half; this now does the same.
         */
        'icon-image': shieldImageExpression(state, { length: ['length', REF], override: REF_DESIGN }),
        // Constant, so the number's size and offset — which are fixed per
        // shield — cannot drift out of register with the marker they sit on.
        'icon-size': 1,
        'icon-rotation-alignment': 'viewport',
        // The stripped number, not the raw ref — see REF above. This was the
        // one place that read `ref` straight through, which is why a single
        // route drew "SR 61" while a concurrency drew bare numbers.
        'text-field': REF,
        'text-font': FONT_BOLD,
        // Sized and placed per shield: a third of the blanks carry the state's
        // name across the top, and a number centred in the image lands on it.
        // Sized from the number, not from a default of two characters: "21/2"
        // in a circle built for "21" is the West Virginia secondary route that
        // ran outside its own shield.
        'text-size': shieldTextSizeExpression(state, 2, ['length', REF]),
        'text-offset': shieldTextOffsetExpression(state, 2, 0, { override: REF_DESIGN }),
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
        'symbol-sort-key': SHIELD_ORDER,
      },
      paint: { 'text-color': shieldTextColour(state, { override: REF_DESIGN }) },
    },
    half('road-shield-first', FIRST_REF, -apart),
    half('road-shield-second', SECOND_REF, apart),
  ];
}
