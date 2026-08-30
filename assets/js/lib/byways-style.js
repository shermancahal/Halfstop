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
  /*
   * The font stack, which is a property of the glyph server and not of this
   * style's taste.
   *
   * A `text-font` names fonts the style's `glyphs` URL has to be able to
   * serve, and the two schemas point at different servers. These are Mapbox's,
   * and they exist only on Mapbox's font endpoint.
   */
  font: ['DIN Pro Regular', 'Arial Unicode MS Regular'],
  fontBold: ['DIN Pro Bold', 'Arial Unicode MS Bold'],
  layers: {
    landcover: 'landcover',
    landuse: 'landuse',
    landuseOverlay: 'landuse_overlay',
    water: 'water',
    waterway: 'waterway',
    road: 'road',
    place: 'place_label',
    /*
     * Mapbox keeps the names of natural features in one layer, whatever kind
     * of feature they are. Split into two here because the other schema does
     * not: it has no natural-feature layer at all, and puts the names of lakes
     * and rivers on the water polygons themselves.
     */
    waterLabel: 'natural_label',
    summitLabel: 'natural_label',
    boundary: 'admin',
    contour: 'contour',
    hillshade: 'hillshade',
  },
  fields: {
    classField: 'class',
    // Mapbox puts every classification in one field, so roads read it too.
    roadClassField: 'class',
    ref: 'ref',
    refLength: 'reflen',
    shield: 'shield',
    // A shape name — `circle-white`, `us-interstate` — so who numbered the
    // road has to be inferred from where the map is looking.
    shieldKind: 'shape',
    // The number already stripped of its system, where the schema has one.
    shieldText: null,
    /*
     * How a road carrying two route numbers is recognised. Mapbox marks it in
     * the shield value, `us-highway-duplex`, which is the tag that says the
     * hyphen in "23-60" is a separator rather than part of a number.
     */
    duplex: 'duplex',
    name: 'name',
    nameEn: 'name_en',
    surface: 'surface',
    elevation: 'ele',
  },
  /*
   * The road hierarchy, which is what makes an atlas readable.
   *
   * Written out rather than assumed, because the other schema does not divide
   * the world at the same points and the mapping has to be explicit about
   * where it loses resolution.
   */
  roadClasses: {
    motorway: 'motorway',
    trunk: 'trunk',
    primary: 'primary',
    secondary: 'secondary',
    tertiary: 'tertiary',
    street: 'street',
    streetLimited: 'street_limited',
    service: 'service',
    track: 'track',
    path: 'path',
    pedestrian: 'pedestrian',
  },
  /*
   * Slip roads, which are their own classes rather than a property of the road
   * they serve. Named here because a schema that omitted them would draw every
   * interchange in the country as two roads crossing.
   */
  roadLinks: {
    motorway: 'motorway_link',
    trunk: 'trunk_link',
    primary: 'primary_link',
    secondary: 'secondary_link',
    tertiary: 'tertiary_link',
  },
  /** Mapbox's landuse_overlay distinguishes exactly one kind of protected ground. */
  protectedClasses: ['national_park'],
  /*
   * Ground cover, by what it is rather than by what it is called.
   *
   * A role maps onto the values a schema uses for it, and a role with no
   * values draws no arm at all - which is how one style serves two
   * vocabularies of different sizes. Mapbox distinguishes four kinds of cover
   * this map cares about; Protomaps distinguishes seven, and painting its
   * cropland and its cities in forest green because they fell through to the
   * fallback is the kind of wrong that looks deliberate.
   */
  landcover: {
    wood: ['wood'],
    scrub: ['scrub'],
    grass: ['grass'],
    snow: ['snow'],
    crop: [],
    barren: [],
    urban: [],
  },
  /** And the same for landuse polygons, which are a different layer. */
  landuse: {
    park: ['park'],
    grass: ['grass'],
    wood: ['wood'],
    scrub: ['scrub'],
    sand: ['sand'],
  },
  /*
   * A town, as opposed to everything else with a name on it.
   *
   * The only distinction this map draws among place labels: a settlement gets
   * bigger type than a district or a region, because on a road atlas the towns
   * are what you navigate by.
   */
  place: { settlement: ['settlement'] },
  /** Named water worth a label. Mapbox's natural_label vocabulary. */
  waterClasses: ['lake', 'ocean', 'sea', 'river'],
  /** And the one class that covers peaks, ridges and passes. */
  summitClasses: ['landform'],
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
  /*
   * Protomaps' own font set, which is Noto and nothing else.
   *
   * This is the single fault that made the Protomaps map look broken. The
   * style asked for Mapbox's stack from Protomaps' font server, every glyph
   * range came back 404, and a symbol layer whose font cannot be fetched draws
   * no text at all - so the map rendered water, parks and roads and not one
   * place name, road name or route number. Worse, the 404 storm kept the style
   * from finishing inside its own timeout, which then set the app rebuilding
   * its layers and re-registering shields on a loop.
   *
   * The names are measured, not guessed: Regular, Medium and Italic answer
   * 200 on that server and "Noto Sans Bold" answers 404, which is why the
   * bold stack here is Medium. tools/layer-candidates.json keeps those probes
   * so the next person does not have to find out from a blank map.
   */
  font: ['Noto Sans Regular'],
  fontBold: ['Noto Sans Medium'],
  layers: {
    landcover: 'landcover',
    landuse: 'landuse',
    /*
     * One landuse layer rather than a base and an overlay, so both read it.
     *
     * Protomaps' own style draws parks from it - `id: "landuse_park"`,
     * `"source-layer": "landuse"`, filtered on kind in national_park and the
     * rest - which is where this was read from. The documentation could not
     * answer it: its kinds section is one flat alphabetical list of every
     * value across every layer, with no layer named anywhere in it.
     */
    landuseOverlay: 'landuse',
    water: 'water',
    // Rivers and coastline are the same layer here, told apart by `kind`.
    waterway: 'water',
    road: 'roads',
    place: 'places',
    /*
     * The names ride on the water features themselves - read from Protomaps'
     * own style, whose water_label_ocean and water_label_lakes both declare
     * "source-layer": "water".
     */
    waterLabel: 'water',
    /*
     * Summits, still unplaced. `peak` is a documented kind and there is no
     * natural-feature layer to hold it, so it is in pois or in places -
     * neither of which turned up under an anchored search, because the
     * documentation lists kinds in one flat table with no layer column. Null
     * until that is read rather than guessed, which drops the layer instead of
     * pointing it at a source-layer that would silently draw nothing.
     */
    summitLabel: null,
    boundary: 'boundaries',
    contour: null,
    hillshade: null,
  },
  fields: {
    // `kind` is the universal classification field, where Mapbox uses
    // `class` - landcover, landuse and relief all read it.
    classField: 'kind',
    /*
     * Roads read `kind_detail`, not `kind`, and this is what saves the map.
     *
     * `kind` has five values, which would have collapsed motorway into trunk
     * and primary into secondary - the distinctions that make a road atlas
     * readable at speed. `kind_detail` carries the original OSM highway value,
     * so the eleven-way hierarchy survives intact.
     *
     * Confirmed present in the published schema. The values below are the
     * standard OSM highway tags, which is what kind_detail holds by
     * definition; the two that are inferred rather than read are marked.
     */
    roadClassField: 'kind_detail',
    ref: 'ref',
    refLength: null,
    // Not a shape but a network: US:I, US:US, US:KY. Richer than what it
    // replaces, and the reason the shield work mostly survives.
    shield: 'network',
    // Not a shape but a network: US:I, US:US, US:KY. Read as such.
    shieldKind: 'network',
    shieldText: 'shield_text',
    /*
     * Nothing in this schema marks a concurrency, so the split does not run
     * and a road carrying two numbers gets one shield. Left null rather than
     * guessed: the alternative is splitting on any hyphen, which would cut
     * "21/2"-style secondary numbers and every hyphenated forest road in half.
     * Whether shield_text encodes a concurrency at all is worth a probe.
     */
    duplex: null,
    name: 'name',
    nameEn: 'name:en',
    surface: null,
    elevation: null,
  },
  /*
   * The hierarchy survives, because roads read kind_detail rather than kind.
   *
   * `kind` has five values and would have collapsed motorway into trunk and
   * primary into secondary - a US highway and a county road at the same
   * weight, and the figure-ground that lets you read this map at speed gone
   * with it. `kind_detail` carries the original OSM highway tag, which is the
   * same vocabulary Mapbox derives its own classes from, so eleven classes map
   * onto eleven.
   *
   * Two are inferred rather than read, and are marked. Mapbox's `street` and
   * `street_limited` are its own groupings rather than OSM tags; residential
   * and living_street are the nearest OSM equivalents, and if they turn out to
   * be wrong the symptom is minor roads drawn at the wrong weight rather than
   * missing, which is recoverable.
   */
  roadClasses: {
    motorway: 'motorway',
    trunk: 'trunk',
    primary: 'primary',
    secondary: 'secondary',
    tertiary: 'tertiary',
    /*
     * Two values, because Protomaps splits what Mapbox groups - and because
     * `unclassified` was named nowhere in this style while sitting in the
     * Smokies tile, so every unclassified road drew nothing. In OSM that is
     * not "unknown": it is the minor public road below tertiary, which is
     * most of the rural network this map exists for.
     */
    street: ['residential', 'unclassified'],
    // Inferred: Mapbox's grouping, not an OSM tag.
    streetLimited: 'living_street',
    service: 'service',
    track: 'track',
    /*
     * Everything that is trail on the ground, for the same reason: `footway`,
     * `steps`, `bridleway` and `cycleway` were all in that tile and named
     * nowhere here. A map that draws only what OSM happens to have tagged
     * `path` draws a fraction of a national park's trails.
     */
    path: ['path', 'footway', 'bridleway', 'steps', 'cycleway'],
    pedestrian: 'pedestrian',
  },
  /*
   * Four, where Mapbox has one. Confirmed as landuse kinds from Protomaps' own
   * park layer; national forest and designated wilderness are most of the
   * ground the roads on this map run through, and drawing only national parks
   * would leave them as bare parchment.
   */
  protectedClasses: ['national_park', 'protected_area', 'nature_reserve', 'forest'],
  /*
   * Read from Protomaps' own landcover ramp, which matches on grassland,
   * barren, urban_area, farmland, glacier and scrub and lets forest fall
   * through as the default. Seven roles filled where Mapbox fills four.
   */
  landcover: {
    wood: ['forest'],
    scrub: ['scrub'],
    grass: ['grassland'],
    snow: ['glacier'],
    crop: ['farmland'],
    barren: ['barren'],
    urban: ['urban_area'],
  },
  /*
   * And its landuse kinds, from the same file. Protomaps carries both `grass`
   * and `grassland` on this layer and both `wood` and `scrub`, so most roles
   * gain a synonym rather than changing.
   */
  landuse: {
    park: ['park', 'village_green', 'playground', 'recreation_ground', 'golf_course'],
    grass: ['grass', 'grassland'],
    wood: ['wood'],
    scrub: ['scrub'],
    sand: ['sand', 'beach'],
  },
  /*
   * Protomaps' water kinds, read from the schema documentation: ocean, lake,
   * river, riverbank, reservoir and playa. Riverbank and reservoir are named
   * bodies of water like any other; playa is left out, because a dry lake bed
   * labelled as water is worse than not labelling it.
   */
  /*
   * `water` is the one that matters, and it is why no lake on this map had a
   * name on it. Protomaps tags a lake `kind: water`; this list said `lake`,
   * which nothing in the archive has ever been. The tile that proved it held
   * nineteen distinctly-named water features and drew zero labels.
   *
   * `stream` is here because this is a map for the outdoors and a named creek
   * is worth reading. It costs nothing low down: streams are not in the tiles
   * until deep in, so the layer's own minzoom never has them to draw.
   */
  waterClasses: ['ocean', 'lake', 'water', 'river', 'riverbank', 'reservoir', 'stream'],
  // Nothing to filter while summitLabel is null; the layer is dropped anyway.
  summitClasses: [],
  /*
   * Protomaps calls a town a locality - read from its places_locality layer,
   * which filters on exactly that and carries `capital` and `sort_key`
   * alongside. Its other place kinds are country, region, province,
   * neighbourhood and macrohood, none of which are towns.
   */
  place: { settlement: ['locality'] },
  // The same OSM tags, since kind_detail is the OSM highway value.
  roadLinks: {
    motorway: 'motorway_link',
    trunk: 'trunk_link',
    primary: 'primary_link',
    secondary: 'secondary_link',
    tertiary: 'tertiary_link',
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
const labelName = () => ['coalesce', ['get', S.fields.nameEn], ['get', S.fields.name]];

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
/*
 * A function rather than a constant, because a constant is evaluated once at
 * module load - with whatever schema happened to be in force then, which is
 * always the Mapbox one. Three expressions here were written as constants and
 * every one of them silently baked `name_en`, `surface` and `class` into the
 * Protomaps style, where those fields do not exist. The style validated, the
 * map drew, and the labels were simply gone.
 */
const unpaved = () => ['==', ['get', S.fields.surface], 'unpaved'];

/** Whether this schema says anything at all about surfaces. */
const hasSurface = () => Boolean(S.fields.surface);

/*
 * A road class, as the schema in force names it.
 *
 * Every filter below goes through this rather than writing the value out. The
 * two vocabularies agree on more than they disagree on, which is exactly what
 * makes writing the literal dangerous: `motorway` is right in both, so a
 * hard-coded `street` sat unnoticed among them and would have matched nothing
 * at all over Protomaps geometry - a whole class of road missing from the map
 * with every other class present and correct.
 */
const R = (name) => S.roadClasses[name];

/**
 * The values for a set of road roles, flattened.
 *
 * A role used to be one value, because under Mapbox Streets it is: one class
 * per role, every time. Protomaps splits several of them - what Mapbox calls a
 * street is `residential` and `unclassified` there, and what it calls a path is
 * `path`, `footway`, `bridleway`, `steps` and `cycleway` - so a role has to be
 * able to name more than one, and a `match` label list has to stay flat to be
 * valid.
 *
 * The gaps this closes were not found by reading: they came from reading a real
 * tile and asking which of its `kind_detail` values the style never mentions.
 * `unclassified` is the minor public road that connects rural places, and
 * `footway` is most of a national park's trail network. Both were drawing
 * nothing at all, on a map for driving byways and walking trails.
 *
 * For Mapbox every role is still a single string, so this produces exactly the
 * list it always did - which the style snapshot holds to.
 */
const classes = (...roles) => roles.flatMap((role) => [].concat(S.roadClasses[role] ?? []));

/** The ramps belonging to a class, same reasoning. */
const RL = (name) => S.roadLinks[name];

/**
 * The values this schema uses for a set of roles, in order, skipping the roles
 * it has no values for.
 *
 * @param {string} group  `landcover` or `landuse`.
 * @param {string[]} roles
 * @returns {string[]}
 */
const kinds = (group, roles) => roles.flatMap((role) => S[group][role] || []);

/**
 * A `match` over a classification, built from roles rather than values.
 *
 * @param {string} group
 * @param {Array<[string[], *]>} arms  Roles, and what they resolve to.
 * @param {*} fallback
 */
const byKind = (group, arms, fallback) => [
  'match', ['get', S.fields.classField],
  ...arms.flatMap(([roles, value]) => {
    const values = kinds(group, roles);
    // A role this schema has no values for produces no arm. An empty match arm
    // is a spec error, and an arm listing a value the tiles never carry is
    // worse - it is valid, and it is dead.
    return values.length ? [values.length === 1 ? values[0] : values, value] : [];
  }),
  fallback,
];

/** Roads that are drawn solid, and so have something for a dash to sit on. */
const sealedClasses = () => [
  ...classes('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'streetLimited'),
];

/*
 * Functions, not constants, and for the reason three other things in this file
 * are functions.
 *
 * A module-level constant is evaluated once at import and freezes whatever
 * schema happened to be current - which here means every symbol layer would
 * carry Mapbox's font names into a Protomaps style no matter what the schema
 * said. That exact mistake has now been made four times in this file, and it
 * is invisible under Mapbox every time, because under Mapbox the frozen value
 * is the right one.
 */
const font = () => S.font;
const fontBold = () => S.fontBold;

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

/** Matches a road class and the ramps that belong to it. */
const roadFilter = (className) => [
  'match', ['get', S.fields.roadClassField], [R(className), RL(className)], true, false,
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
  const isLink = ['==', ['get', S.fields.roadClassField], RL(className)];
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
export function bywaysStyle(token, { schema = MAPBOX_SCHEMA, archive = '', maxzoom = 0 } = {}) {
  /*
   * The schema is set before the layer builders run, and restored after.
   *
   * They are nullary functions called once each from the list below, so a
   * module binding is enough - but leaving it set would make the next call
   * depend on the last one, which is the kind of thing that works until two
   * styles are built in one page. Restored in a finally so a throw cannot
   * leave it pointing at the wrong schema either.
   */
  const previous = S;
  S = schema;
  try {
    return buildStyle(token, schema, { archive, maxzoom });
  } finally {
    S = previous;
  }
}

/**
 * Drop the layers a schema cannot draw.
 *
 * A source-layer of null is how a schema says "this source has no contours".
 * Left in, GL would ask for a source-layer named `null`, find nothing, and
 * draw nothing - no error, no warning, just a map missing its contour lines
 * and no indication why. Removing the layer is the same visual result with an
 * honest cause, and it keeps the style valid.
 */
function drawable(layers) {
  return layers.filter((layer) => {
    if (layer.source === null || layer.source === undefined) return layer.type === 'background';
    return !('source-layer' in layer) || Boolean(layer['source-layer']);
  });
}

function buildStyle(token, schema, { archive, maxzoom }) {
  if (schema.id === 'mapbox' && !token) return null;
  /*
   * A Protomaps style with no archive to read is a map of nothing.
   *
   * Returning null puts it in the same place as Mapbox with no token: the
   * caller substitutes a raster basemap and says so. Building the style anyway
   * would produce a document that validates, loads, reports success and draws
   * an empty parchment rectangle, which is the failure this file keeps having
   * to be defended against.
   */
  if (schema.id !== 'mapbox' && !archive) return null;
  const key = encodeURIComponent(token || '');
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
    /*
     * Glyphs are required for any symbol layer, and a style with labels and no
     * glyphs URL does not fail visibly - the labels simply never appear.
     *
     * Protomaps publishes a font set for exactly this. No sprite: every image
     * this style uses is a shield drawn on a canvas at runtime and registered
     * by id, so there is nothing for a sprite sheet to supply.
     */
    glyphs: schema.id === 'mapbox'
      ? `https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${key}`
      : 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    ...(schema.id === 'mapbox'
      ? { sprite: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite?access_token=${key}` }
      : {}),
    sources: schema.id === 'mapbox'
      ? {
        composite: vector('mapbox.mapbox-streets-v8'),
        terrain: vector('mapbox.mapbox-terrain-v2'),
      }
      : {
        /*
         * One archive, read a slice at a time through the pmtiles protocol.
         *
         * The URL is a placeholder until the archive is hosted; what matters
         * for now is the shape - a single file rather than a tile endpoint,
         * which is what makes this downloadable and what the existing per-tile
         * cache cannot handle.
         */
        /*
         * Declared as a tile template rather than a TileJSON `url`, which is
         * the form the reference reader uses.
         *
         * Both work, and this one has a property worth having: the protocol
         * handler then only ever answers tile requests, so there is one code
         * path rather than two and no negotiation before the map draws. The
         * cost is that the zoom range has to be stated here instead of read
         * from the archive - and an overstated maxzoom means blank tiles, so
         * it is checked against the archive's own header at runtime.
         */
        [schema.source]: {
          type: 'vector',
          tiles: [`pmtiles://${archive}/{z}/{x}/{y}`],
          minzoom: 0,
          maxzoom: maxzoom || 15,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      },
    layers: drawable([
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
    ]),
    attribution: schema.id === 'mapbox'
      ? '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> '
        + '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> '
        + '· <a href="https://protomaps.com">Protomaps</a>',
  };
}

/* ---- ground ---- */

function groundLayers() {
  return [
    { id: 'background', type: 'background', paint: { 'background-color': PALETTE.land } },
    {
      id: 'landcover',
      type: 'fill',
      source: S.source,
      'source-layer': S.layers.landcover,
      paint: {
        'fill-color': byKind('landcover', [
          [['wood'], PALETTE.forestDeep],
          [['scrub'], PALETTE.forest],
          [['grass'], PALETTE.park],
          [['snow'], PALETTE.snow],
          // The three a schema may not have. Cropland is pale open ground on an
          // atlas, bare rock paler still, and a city is the wicker tone the
          // built-up areas already use - none of them are forest green.
          [['crop'], PALETTE.landPale],
          [['barren'], PALETTE.landAlt],
          [['urban'], PALETTE.urban],
        ], PALETTE.forest),
        // Fades in rather than switching on, so zooming out does not produce a
        // hard edge where the source's maxzoom stops.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 0.85],
        'fill-antialias': false,
      },
    },
    {
      id: 'national-park',
      type: 'fill',
      source: S.source,
      'source-layer': S.layers.landuseOverlay,
      /*
       * Every kind of protected ground this schema distinguishes, not just the
       * one word Mapbox uses. Mapbox's landuse_overlay has a single
       * national_park class; Protomaps separates national_park,
       * protected_area, nature_reserve and forest, and drawing only the first
       * would leave a wilderness or a national forest as bare parchment - on a
       * back-roads map, the ground most of the roads are in.
       */
      filter: ['match', ['get', S.fields.classField], S.protectedClasses, true, false],
      paint: { 'fill-color': PALETTE.park, 'fill-opacity': 0.5 },
    },
    {
      id: 'landuse',
      type: 'fill',
      source: S.source,
      'source-layer': S.layers.landuse,
      filter: ['match', ['get', S.fields.classField],
        kinds('landuse', ['park', 'grass', 'wood', 'scrub', 'sand']), true, false],
      paint: {
        'fill-color': byKind('landuse', [
          [['sand'], PALETTE.landAlt],
          [['wood'], PALETTE.forestDeep],
        ], PALETTE.park),
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
      source: S.reliefSource,
      'source-layer': S.layers.hillshade,
      paint: {
        'fill-color': PALETTE.hillshade,
        // Terrain-v2 ships six shadow classes; only the darker ones earn their
        // keep here, since heavy shading buries the contours drawn over it.
        'fill-opacity': [
          'match', ['get', S.fields.classField],
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
      source: S.reliefSource,
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
      source: S.reliefSource,
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
      source: S.reliefSource,
      'source-layer': S.layers.contour,
      filter: ['==', ['get', 'index'], 5],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'],
        'text-font': font(),
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
      source: S.source,
      'source-layer': S.layers.water,
      paint: { 'fill-color': PALETTE.water },
    },
    {
      id: 'waterway',
      type: 'line',
      source: S.source,
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
    source: S.source,
    'source-layer': S.layers.road,
    filter: ['match', ['get', S.fields.roadClassField], classes('track', 'service'), true, false],
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
    source: S.source,
    'source-layer': S.layers.road,
    filter: ['match', ['get', S.fields.roadClassField], classes('path', 'pedestrian'), true, false],
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
      source: S.source,
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
    source: S.source,
    'source-layer': S.layers.road,
    filter: ['match', ['get', S.fields.roadClassField], classes('street', 'streetLimited'), true, false],
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
      source: S.source,
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
    source: S.source,
    'source-layer': S.layers.road,
    filter: ['match', ['get', S.fields.roadClassField], classes('street', 'streetLimited'), true, false],
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
  /*
   * Skipped entirely where the schema has no surface field, rather than drawn
   * with a filter that matches nothing. Both are invisible; only one of them
   * is honest, and only one of them shows up when the styles are compared.
   */
  if (hasSurface()) layers.push({
    id: 'road-unpaved',
    type: 'line',
    source: S.source,
    'source-layer': S.layers.road,
    filter: ['all', unpaved(), ['match', ['get', S.fields.roadClassField], sealedClasses(), true, false]],
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
      source: S.source,
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
      source: S.source,
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
      source: S.source,
      'source-layer': S.layers.waterLabel,
      filter: ['all',
        ['has', S.fields.name],
        ['match', ['get', S.fields.classField], S.waterClasses, true, false],
      ],
      minzoom: 7,
      layout: {
        'text-field': labelName(),
        'text-font': font(),
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
      source: S.source,
      'source-layer': S.layers.summitLabel,
      filter: ['match', ['get', S.fields.classField], S.summitClasses, true, false],
      minzoom: 11,
      layout: {
        'text-field': labelName(),
        'text-font': font(),
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
      source: S.source,
      'source-layer': S.layers.road,
      /*
       * Reads the road classification field, not the general one.
       *
       * These were the same field under Mapbox, where everything is `class`,
       * so writing the wrong one cost nothing and looked correct. Protomaps
       * classifies roads in `kind_detail` and everything else in `kind`, and
       * this filter would have matched nothing at all - every road name gone
       * from the map, with no error anywhere.
       */
      filter: ['match', ['get', S.fields.roadClassField],
        classes('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'track'),
        true, false],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        // The surface rides along with the name. A forest road's number tells
        // you nothing about whether you want to be on it; "unpaved" does.
        'text-field': hasSurface()
          ? ['case',
            ['all', unpaved(), ['has', 'name']], ['concat', labelName(), ' \u00b7 unpaved'],
            labelName()]
          : labelName(),
        'text-font': font(),
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
      source: S.source,
      'source-layer': S.layers.road,
      filter: ['all',
        ['match', ['get', S.fields.roadClassField], classes('path', 'service'), true, false],
        ['has', 'name'],
      ],
      minzoom: 14,
      layout: {
        'symbol-placement': 'line',
        'text-field': hasSurface()
          ? ['case', unpaved(), ['concat', labelName(), ' \u00b7 unpaved'], labelName()]
          : labelName(),
        'text-font': font(),
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
      source: S.source,
      'source-layer': S.layers.place,
      layout: {
        'text-field': labelName(),
        'text-font': fontBold(),
        /*
         * Towns bigger than everything else, at both ends of the ramp.
         *
         * Written through the schema because the value differs: Mapbox calls a
         * town a settlement and Protomaps calls it a locality, and a literal
         * here would have drawn every place name in the country at the smaller
         * size - a state capital and a crossroads in the same type, which
         * reads as a design decision rather than as a filter matching nothing.
         */
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          4, byKind('place', [[['settlement'], 11]], 9),
          12, byKind('place', [[['settlement'], 16]], 12),
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
/*
 * The raw route number, as the tiles carry it.
 *
 * Functions from here down, not constants. A constant is evaluated once at
 * module load, with whatever schema is in force then - always the Mapbox one -
 * and every expression built from it would silently read Mapbox field names
 * out of Protomaps tiles. That failure draws a map with no shields on it and
 * reports nothing.
 *
 * A schema that hands us the number already stripped of its system is used in
 * preference: shield_text is Protomaps' own answer to the question the whole
 * prefixless machinery below exists to answer, and it knows things we cannot
 * infer from the string.
 */
const rawRef = () => ['coalesce', ['get', S.fields.shieldText || S.fields.ref], ''];
const prefixless = () => ['let', 'raw', rawRef(),
  'space', ['index-of', ' ', rawRef()],
  'dash', ['index-of', '-', rawRef()],
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
 * `prefixless` throws it away and `refDesign` needs to look at it, and
 * recomputing the separator in two places is how the two would quietly come to
 * disagree about where a ref splits.
 */
const separator = () => ['let',
  'space', ['index-of', ' ', rawRef()],
  'dash', ['index-of', '-', rawRef()],
  ['case',
    ['<', ['var', 'space'], 0], ['var', 'dash'],
    ['<', ['var', 'dash'], 0], ['var', 'space'],
    ['min', ['var', 'space'], ['var', 'dash']]],
];

const head = () => ['let', 'cut', separator(),
  ['case', ['>', ['var', 'cut'], 0], ['slice', rawRef(), 0, ['var', 'cut']], '']];

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
const refDesign = () => ['case',
  ['in', head(), ['literal', FOREST_SYSTEMS]], 'forest',
  ['all',
    // Guarded, because slicing from a negative start on a short ref is not a
    // question worth asking of the expression evaluator.
    ['>', ['length', rawRef()], SCENIC_SUFFIX.length],
    ['==', ['slice', rawRef(), ['-', ['length', rawRef()], SCENIC_SUFFIX.length]], SCENIC_SUFFIX]],
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
const ref = () => ['let', 'stem', prefixless(),
  ['case',
    ...DESIGNATIONS.flatMap((word) => [
      ['==', ['slice', ['var', 'stem'], ['-', ['length', ['var', 'stem']], word.length + 1]], ` ${word}`],
      ['slice', ['var', 'stem'], 0, ['-', ['length', ['var', 'stem']], word.length + 1]],
    ]),
    ['var', 'stem']],
];
const refCut = () => ['index-of', '-', ref()];
/*
 * Whether this feature carries two route numbers.
 *
 * Both halves have to be present to split: the duplex marker is the tag that
 * says the hyphen is a separator rather than part of a number. A schema with
 * no such marker answers false everywhere, and the pair of half-shields is
 * dropped from the style rather than drawn empty.
 */
const canSplit = () => Boolean(S.fields.duplex);
const isDuplex = () => (canSplit() ? ['all',
  ['>', refCut(), 0],
  ['in', S.fields.duplex, ['coalesce', ['get', S.fields.shield], '']],
] : false);
const firstRef = () => ['slice', ref(), 0, refCut()];
// A three-way concurrency would leave "60-119" behind the first hyphen, so the
// second shield stops at the next one.
const secondRef = () => ['let', 'rest', ['slice', ref(), ['+', refCut(), 1]],
  ['case',
    ['>', ['index-of', '-', ['var', 'rest']], 0],
    ['slice', ['var', 'rest'], 0, ['index-of', '-', ['var', 'rest']]],
    ['var', 'rest']],
];

// An interstate marker outranks a county route where they land together.
const shieldOrder = () => ['match', ['get', S.fields.roadClassField],
  R('motorway'), 1, R('trunk'), 2, R('primary'), 3, R('secondary'), 4, 5];

/**
 * How a shield expression should read the road's system under this schema.
 *
 * Empty for Mapbox, which names a shape and leaves the network to be inferred;
 * the field name for Protomaps, which names the network outright.
 */
const shieldNetwork = () => (S.fields.shieldKind === 'network' ? S.fields.shield : '');

/**
 * Every shield layer's id, and how far off centre its number sits.
 *
 * A function, and only the layers this schema can actually draw. Where nothing
 * marks a concurrency the two halves never match anything, and shipping them
 * anyway would leave the runtime updating layers that are not in the style.
 */
export function shieldLayerSpecs() {
  return SHIELD_LAYER_SPECS.slice(0, canSplit() ? 3 : 1);
}

const SHIELD_LAYER_SPECS = [
  /*
   * The plain shield measures the number it carries, like the halves below.
   *
   * It used to pass null and fall back to the tile's `reflen`, which is the
   * length of the raw ref — and the raw ref carries the system, so a stripped
   * "SR 61" would have gone on asking for a four-wide sign to hold two digits
   * every time the map crossed a state line.
   */
  { id: 'road-shield', shift: 0, get length() { return ['length', ref()]; } },
  { id: 'road-shield-first', shift: -(shieldDisplayWidth(2) / 2 + 1), get length() { return ['length', firstRef()]; } },
  { id: 'road-shield-second', shift: shieldDisplayWidth(2) / 2 + 1, get length() { return ['length', secondRef()]; } },
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
export function shieldLayerUpdates(state = '', { schema = MAPBOX_SCHEMA } = {}) {
  /*
   * The schema has to be set here too, and it is the one place that is easy to
   * miss: this runs at runtime, long after `bywaysStyle` returned and put the
   * module binding back. Without this the border crossing would rewrite every
   * shield layer with Mapbox field names, on a map drawing Protomaps tiles -
   * and it would do it several minutes into a drive rather than at load.
   */
  const previous = S;
  S = schema;
  try {
    const network = shieldNetwork();
    return shieldLayerSpecs().map(({ id, shift, length }) => ({
      id,
      layout: {
        // Sized from the number it is actually carrying, exactly as the layer
        // was built — half of a concurrency is as wide as its own half.
        'icon-image': shieldImageExpression(state, { length, override: refDesign(), network }),
        'text-size': shieldTextSizeExpression(state, 2, length, { network }),
        'text-offset': shieldTextOffsetExpression(state, 2, shift, { override: refDesign(), network }),
      },
      paint: { 'text-color': shieldTextColour(state, { override: refDesign(), network }) },
    }));
  } finally {
    S = previous;
  }
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
  const onARoad = ['match', ['get', S.fields.roadClassField],
    classes('motorway', 'trunk', 'primary', 'secondary', 'tertiary'), true, false];

  /** Half a concurrency: its own number, its own image, shifted off centre. */
  const half = (id, text, shiftPx) => ({
    id,
    type: 'symbol',
    source: S.source,
    'source-layer': S.layers.road,
    filter: ['all', ['has', S.fields.shieldText || S.fields.ref], onARoad, isDuplex()],
    minzoom: 6,
    layout: {
      'symbol-placement': 'line',
      // Eased off at the top so the overzoom that still happens above the
        // tileset's own maxzoom has somewhere to go: 220 at z16 is 880 on
        // screen at z18, where 260 would have been over a thousand.
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 6, 170, 14, 220],
      'icon-image': shieldImageExpression(state, { length: ['length', text], override: refDesign(), network: shieldNetwork() }),
      'icon-size': 1,
      'icon-offset': [shiftPx, 0],
      'icon-rotation-alignment': 'viewport',
      'text-field': text,
      'text-font': fontBold(),
      'text-size': shieldTextSizeExpression(state, 2, ['length', text], { network: shieldNetwork() }),
      'text-offset': shieldTextOffsetExpression(state, 2, shiftPx, { override: refDesign(), network: shieldNetwork() }),
      'text-rotation-alignment': 'viewport',
      'text-anchor': 'center',
      'icon-allow-overlap': true,
      'icon-ignore-placement': false,
      'text-allow-overlap': true,
      'text-ignore-placement': false,
      'text-optional': false,
      'icon-optional': false,
      'symbol-sort-key': shieldOrder(),
    },
    paint: { 'text-color': shieldTextColour(state, { override: refDesign(), network: shieldNetwork() }) },
  });

  // Half a shield's width each way, plus a pixel so the two do not touch.
  const apart = shieldDisplayWidth(2) / 2 + 1;

  return [
    {
      id: 'road-shield',
      type: 'symbol',
      source: S.source,
      'source-layer': S.layers.road,
      filter: ['all',
        ['has', S.fields.shieldText || S.fields.ref],
        onARoad,
        /*
         * Where nothing marks a concurrency this is `['!', false]`, so the
         * plain shield draws every numbered road and the two halves below are
         * not in the style at all.
         */
        ['!', isDuplex()],
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
        'icon-image': shieldImageExpression(state, { length: ['length', ref()], override: refDesign(), network: shieldNetwork() }),
        // Constant, so the number's size and offset — which are fixed per
        // shield — cannot drift out of register with the marker they sit on.
        'icon-size': 1,
        'icon-rotation-alignment': 'viewport',
        // The stripped number, not the raw ref — see `ref` above. This was the
        // one place that read `ref` straight through, which is why a single
        // route drew "SR 61" while a concurrency drew bare numbers.
        'text-field': ref(),
        'text-font': fontBold(),
        // Sized and placed per shield: a third of the blanks carry the state's
        // name across the top, and a number centred in the image lands on it.
        // Sized from the number, not from a default of two characters: "21/2"
        // in a circle built for "21" is the West Virginia secondary route that
        // ran outside its own shield.
        'text-size': shieldTextSizeExpression(state, 2, ['length', ref()], { network: shieldNetwork() }),
        'text-offset': shieldTextOffsetExpression(state, 2, 0, { override: refDesign(), network: shieldNetwork() }),
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
        'symbol-sort-key': shieldOrder(),
      },
      paint: { 'text-color': shieldTextColour(state, { override: refDesign(), network: shieldNetwork() }) },
    },
    ...(canSplit() ? [
      half('road-shield-first', firstRef(), -apart),
      half('road-shield-second', secondRef(), apart),
    ] : []),
  ];
}
