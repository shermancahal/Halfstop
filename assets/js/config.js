/**
 * Site configuration.
 *
 * Everything an operator normally needs to change lives in this one file:
 * branding, the Mapbox token, and the basemap/overlay catalogue. No build step
 * and no secrets management — a Mapbox public token (pk.*) is designed to be
 * shipped in client code, and should be URL-restricted in your Mapbox account.
 */

export const SITE = {
  name: 'Fieldstop',
  shortName: 'Fieldstop',
  tagline: 'Field maps, tracks and waypoints from the road.',
  description:
    'A public library of GPS tracks, routes and waypoints exported from GaiaGPS — '
    + 'viewable in the browser and downloadable as GPX, KML or GeoJSON.',
  parent: { name: 'American Byways', url: 'https://americanbyways.com' },
  // Shown in the footer and in file attributions.
  copyrightHolder: 'American Byways',
  contactEmail: '',
  /*
   * Who may edit page content in place.
   *
   * A convenience for the browser, not a permission. The pencil is hidden for
   * everyone else, and hiding a button is not security - what actually decides
   * whether a save is accepted is the row-level policy on the Supabase table,
   * which checks the signed-in user's own email server-side. Anybody can edit
   * this array in their devtools; nobody can make the database take their row.
   */
  editors: ['shermancahal@gmail.com'],
  /*
   * Which "Continue with …" buttons the sign-in panel offers.
   *
   * Empty because neither is configured yet, and a button that starts an OAuth
   * round trip to a provider the project has not set up sends somebody to an
   * error page from a provider they trust - which reads as this site being
   * broken rather than unfinished. Offering nothing is the honest state.
   *
   * A list rather than two booleans so turning one on is adding its id here:
   * 'apple', 'google'. The buttons, their labels and the divider above the
   * email form all follow from it, and an empty list draws none of them.
   */
  authProviders: [],
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
  return readGlobal('ABMAP_MAPBOX_TOKEN');
}

/** Read a value token.js may have set, tolerating its absence entirely. */
function readGlobal(name) {
  const injected = typeof globalThis === 'undefined' ? '' : globalThis[name];
  return typeof injected === 'string' ? injected.trim() : '';
}

/**
 * Supabase project, for optional accounts and folder sync.
 *
 * Both values live in assets/js/token.js with the Mapbox token, gitignored for
 * the same reasons. The publishable key is designed to be readable in browser
 * code and is safe here — the SECRET key never is: it bypasses row-level
 * security entirely and must never appear in anything a browser downloads.
 *
 * Leave either empty and the app runs exactly as before, folders on the device
 * only, with no sign-in button.
 */
export const SUPABASE_URL = readGlobal('ABMAP_SUPABASE_URL');
export const SUPABASE_KEY = readGlobal('ABMAP_SUPABASE_KEY');

/**
 * The Protomaps archive Byways Topo draws from, when there is one.
 *
 * One `.pmtiles` file holding the whole basemap, read a slice at a time over
 * HTTP range requests. It is what makes the house map free to look at and
 * possible to take offline: static bytes on a bucket rather than a metered
 * tile service, and a file rather than a few hundred thousand URLs.
 *
 * Set it and Byways Topo draws from it. Leave it empty and Byways Topo falls
 * back to Mapbox exactly as before, so this switch is the whole migration.
 *
 * It lives in assets/js/token.js with the other injected values, not because
 * it is a secret - it is a public URL on a public bucket - but because it is
 * deployment configuration rather than code, and it will differ between a
 * local checkout, the site and the app bundle. See docs/protomaps.md for how
 * to build one.
 */
export const PROTOMAPS_ARCHIVE = readGlobal('ABMAP_PROTOMAPS_ARCHIVE');

/**
 * How deep that archive goes.
 *
 * Stated here rather than read from the file because the style document is
 * built before anything has been fetched. Getting it wrong is not symmetrical:
 * understating it costs detail, because GL stretches the deepest tile it has,
 * while overstating it asks for tiles the archive does not contain and draws
 * blank ground. So the app reads the archive's own header once it opens it and
 * warns when the two disagree, rather than trusting this number.
 *
 * 15 is what the Protomaps daily builds go to.
 */
export const PROTOMAPS_MAXZOOM = Number(readGlobal('ABMAP_PROTOMAPS_MAXZOOM')) || 15;

/**
 * Rendering engine.
 *   'auto'     — Mapbox GL JS when a token is set, MapLibre GL otherwise
 *   'mapbox'   — force Mapbox GL JS (requires MAPBOX_TOKEN)
 *   'maplibre' — force MapLibre GL, even with a token set
 */
export const MAP_ENGINE = 'auto';

/**
 * Where to ask for a road route.
 *
 * A URL rather than a hard-coded host, and deliberately so: FOSSGIS's own terms
 * say "the URLs of our services should not be hardcoded into the app", and
 * every route the trip planner draws is one of their requests. Setting
 * ABMAP_ROUTING_URL in token.js points this at your own Valhalla instead,
 * which is a deploy-time change rather than a code one.
 *
 * The default is the FOSSGIS demo server, which is right for development and
 * for a quiet site. It is NOT right for a product. Their terms, verbatim:
 * "Commercial use is only permitted if the use of the services does not
 * constitute a substantial part of an online offering", "Websites with high
 * traffic volumes are generally not permitted to use our services", and for
 * the routing servers specifically, "Maximum one request per second". A trip
 * planner's routing is a substantial part of the offering, so anything with a
 * paid or ad-supported tier needs its own server first. Valhalla is open
 * source and speaks the same API, so that day is this string changing.
 *
 * See docs/routing.md.
 */
export const ROUTING = {
  url: readGlobal('ABMAP_ROUTING_URL') || 'https://valhalla1.openstreetmap.de/route',
  /*
   * One request per second, because that is the published limit.
   *
   * Enforced in the client rather than trusted to good behaviour: a person
   * dragging a stop around generates a request per drag, and the limit is not
   * a suggestion. A little over a second, so clock jitter cannot put two
   * requests inside the same second.
   */
  minIntervalMs: 1100,
  /*
   * Required by the terms, and shown wherever a route is.
   *
   * The fixthemap link is not decoration: it is how somebody who finds the
   * routing wrong about a road can go and fix the road, for everybody. That is
   * the deal OSM data comes with.
   */
  attribution: 'Routing by <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener noreferrer">Valhalla</a>. '
    + 'Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors '
    + '(<a href="https://opendatacommons.org/licenses/odbl/index.html" target="_blank" rel="noopener noreferrer">ODbL</a>) — '
    + '<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">report an error</a>.',
};

/** Default camera when nothing else is specified. Centred on the Appalachians. */
/**
 * Whether any of the plan machinery is switched on.
 *
 * `live: false` means every feature is offered to everybody, which is the true
 * state of this project and not a placeholder to be quietly flipped. Turning it
 * on is not the work — the work is the server-side half, because everything in
 * assets/js/lib/tiers.js runs on the reader's computer and can be edited there.
 * See the note at the top of that file; it is the same kind of thing as
 * SITE.editors and carries the same warning.
 */
export const BILLING = {
  live: false,
};

export const DEFAULT_VIEW = { center: [-84.28, 35.96], zoom: 6.4 };

/** 'imperial' or 'metric'. Users can flip this in the viewer; this is the default. */
export const DEFAULT_UNITS = 'imperial';

const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const USGS_ATTRIBUTION = 'Map data © <a href="https://www.usgs.gov/">USGS</a> — The National Map';
const NOAA_ATTRIBUTION = 'Forecast data © <a href="https://www.weather.gov/">NOAA / National Weather Service</a>';

/*
 * One state's own services.
 *
 * Kentucky's public GIS is split across two servers: kygisserver for map
 * services and kyraster for imagery and elevation, both published in Web
 * Mercator on purpose so a web map can use them directly.
 */
const KY_RASTER = 'https://kyraster.ky.gov/arcgis/rest/services';
/* West Virginia's public services are run by the WVU GIS Technical Center,
   which is what MapWV draws from. mapwv.gov itself answers 404 to the service
   directory; this host answers with CORS open. */
const WV_GIS = 'https://services.wvgis.wvu.edu/arcgis/rest/services';
const WV_ATTRIBUTION = 'Imagery and elevation © <a href="https://wvgis.wvu.edu/">WV GIS Technical Center</a>'
  + ' / West Virginia University';
/* Tennessee's statewide base mapping programme, through TNMap. */
const TN_GIS = 'https://tnmap.tn.gov/arcgis/rest/services';
const TN_ATTRIBUTION = 'Imagery © <a href="https://www.tn.gov/finance/sts-gis.html">Tennessee STS GIS</a>';
const KY_ATTRIBUTION = 'Imagery and elevation © <a href="https://kyfromabove.ky.gov/">KyFromAbove</a>'
  + ' / Commonwealth of Kentucky';

/** The query an ArcGIS image or map service wants for one tile. */
const ESRI_IMAGE = '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857'
  + '&size=256,256&format=png32&transparent=true&f=image';

/**
 * A NOAA GeoServer layer, as a tile template and as its own colour key.
 *
 * Two hosts, one shape. nowCOAST carries the temperature and precipitation
 * forecasts; the National Weather Service's own GeoServer carries cloud cover,
 * wind and snow. Both are OGC WMS, both answer in web mercator, and both allow
 * a browser to read the answer — which is not a given, and is checked by
 * tools/check-layers.mjs rather than assumed.
 *
 * The layer names here are the services' own, read out of their GetCapabilities
 * rather than guessed: `ndfd:sky`, `ndfd_temperature:air_temperature`. Guessing
 * at a service's vocabulary is what left the cell coverage layer drawing
 * nothing for weeks.
 */
const NWS_GEOSERVER = 'https://mapservices.weather.noaa.gov/geoserver';

/*
 * MRLC publishes the National Land Cover Database, canopy included.
 *
 * The layer name is `nlcd_tcc_conus_2021_v2021-4`, read out of the service's
 * capabilities and then confirmed by drawing a tile with it. Both halves were
 * necessary: `mrlc_NLCD_Tree_Canopy` is also in that capabilities document and
 * answers a GetMap with "Could not find layer mrlc_display:mrlc_NLCD_Tree_
 * Canopy". Esri's Living Atlas copy of the same data wants a token and answers
 * a browser with 499.
 */
const MRLC_WMS = 'https://www.mrlc.gov/geoserver/mrlc_display/wms';
const MRLC_CANOPY = 'nlcd_tcc_conus_2021_v2021-4';

const wmsTile = (endpoint, layer) => `${endpoint}?service=WMS&version=1.3.0&request=GetMap`
  + `&layers=${layer}&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}`
  + '&width=256&height=256&format=image/png&transparent=true';

/*
 * The service draws its own key.
 *
 * A continuous ramp has no list of colours to write out by hand, and a
 * hand-written approximation of one is worse than none: it would be wrong the
 * first time NOAA restyled a layer.
 *
 * The options are not decoration. A GeoServer legend defaults to a tall thin
 * column of tiny black type — the sky cover key comes back 38 pixels wide and
 * 302 tall — which in a 320px panel is a stripe you cannot read. `horizontal`
 * turns it into a scale that reads left to right like the ramp it describes,
 * `dpi:180` renders the type at three times the size before it is scaled to
 * fit, and `rows:1` keeps a long ramp on one line instead of wrapping it into
 * a block. Every one of these was measured from CI rather than assumed: the
 * same key goes from 38x302 to 312x56.
 */
const LEGEND_OPTIONS = 'layout:horizontal;fontSize:13;fontAntiAliasing:true'
  + ';dpi:180;forceLabels:on;fontColor:0x2a2a2a';

const wmsLegend = (endpoint, layer, options = LEGEND_OPTIONS) => `${endpoint}?service=WMS&version=1.3.0`
  + `&request=GetLegendGraphic&layer=${layer}&format=image/png`
  // Not encoded: semicolons are legal in a query value, and this is the exact
  // form that was measured working rather than a re-encoded cousin of it.
  + `&legend_options=${options}`;

/*
 * The same key as data rather than as a picture.
 *
 * GeoServer will describe a raster's colormap as JSON, which lets the panel
 * draw the swatch list the radar layer already draws instead of scaling a PNG
 * of somebody else's typography into a 320px column. Same source of truth, so
 * a restyle at NOAA still reaches the panel; it just arrives as colours and
 * labels rather than as pixels.
 */
const wmsLegendScale = (endpoint, layer) => `${endpoint}?service=WMS&version=1.3.0`
  + `&request=GetLegendGraphic&layer=${layer}&format=application/json`;

const ndfdLayer = (layer) => ({
  tiles: [wmsTile(`${NWS_GEOSERVER}/ndfd/wms`, `ndfd:${layer}`)],
  // `legendScale`, not `legendJSON`: that name is already the ArcGIS form,
  // which is an object naming a sublayer. Two different services, two
  // different shapes, and one name over both is how the wrong key gets drawn.
  legendScale: wmsLegendScale(`${NWS_GEOSERVER}/ndfd/wms`, `ndfd:${layer}`),
});
/** USGS structures — one sublayer per kind of place, which is why it is here. */
const USGS_STRUCTURES = 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer';

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
    id: 'byways-topo',
    name: 'Byways Topo',
    // The one basemap this project owns. With a Mapbox token it renders from
    // vector tiles through assets/js/lib/byways-style.js — our palette, our
    // road hierarchy, real route shields. Without a token there is nothing to
    // render vector tiles from, so it falls back to the CyclOSM raster below:
    // the same idea, drawn by somebody else.
    custom: 'byways',
    group: 'Topographic',
    /*
     * What it says has to be true on every foundation.
     *
     * This used to promise "tracks and surfaces", and surfaces stopped being
     * true the day the Protomaps path went live: that schema has no surface
     * field at all, so unpaved roads are not drawn differently from paved
     * ones. The description is one line in a list and the reader has no way
     * to know which of three foundations is under it, so it can only claim
     * what all three do. Whether the paving is shown is a property of the
     * source, and the source's own note is where that belongs.
     */
    description: 'OSM rendered for the outdoors — trails, tracks and route shields.',
    /*
     * Which geometry it draws from is decided at style time, not here.
     *
     * With PROTOMAPS_ARCHIVE set it reads our own archive: free to look at,
     * and downloadable, because the whole basemap is one file. Without one it
     * reads Mapbox, as it always has. Without either it is the CyclOSM raster
     * below, and the panel says so rather than pretending.
     *
     * Same cartography either way — the palette, the road hierarchy and the
     * shields are this app's and are applied to whichever geometry arrives.
     */
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
    id: 'usgs-topo',
    name: 'USGS Topo',
    group: 'Topographic',
    description: 'US Topo quads. Best all-round backcountry base.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'usgs-imagery-topo',
    name: 'USGS Imagery + Topo',
    group: 'Topographic',
    description: 'Aerial imagery with contours and labels burned in.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'usgs-classic',
    name: 'USGS Topo (classic)',
    group: 'Topographic',
    description: 'Scanned 7.5-minute quads — the classic 20th-century paper topo.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/USA_Topo_Maps/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 15,
    attribution: 'USGS quadrangles via <a href="https://www.esri.com/">Esri</a>',
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
    id: 'usgs-imagery',
    name: 'USGS Imagery',
    group: 'Imagery',
    description: 'Aerial imagery, no labels.',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'osm',
    name: 'Street',
    group: 'Road',
    description: 'Standard OSM — the most current road data.',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19,
    attribution: OSM_ATTRIBUTION,
  },

  /*
   * The same map drawn from Mapbox geometry, for comparing the two side by
   * side while the port settles.
   *
   * Editors only, and deliberately so: every view of it is metered, and the
   * point of the Protomaps archive is that the default should not be. It stays
   * because a difference you cannot see is a difference you cannot fix - and
   * because if this app ever draws natively on the phone, Mapbox is where
   * proper offline downloads would come from.
   */
  {
    id: 'byways-topo-mapbox',
    name: 'Byways Topo (Mapbox)',
    custom: 'byways-mapbox',
    audience: 'editors',
    group: 'Topographic',
    description: 'The house map drawn from Mapbox geometry, for comparison.',
    tiles: [
      'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    ],
    tileSize: 256,
    maxzoom: 18,
    attribution: `${OSM_ATTRIBUTION}, tiles by <a href="https://www.cyclosm.org/">CyclOSM</a>`,
  },

  /* ---- Vector styles: shown only when MAPBOX_TOKEN is set ---- */
  {
    id: 'mapbox-outdoors',
    name: 'Mapbox Outdoors',
    // Grouped by what it shows, not by who makes it: a reader looking for a
    // topo map looks under Topographic.
    group: 'Topographic',
    description: 'Vector terrain with contours and trails.',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    requiresToken: true,
    audience: 'editors',
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © OpenStreetMap',
  },
  {
    id: 'mapbox-satellite-streets',
    name: 'Mapbox Satellite Streets',
    group: 'Imagery',
    description: 'Mapbox imagery with road and place labels.',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    requiresToken: true,
    audience: 'editors',
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © OpenStreetMap © Maxar',
  },
];

/**
 * Default basemap when the URL does not name one.
 *
 * Byways Topo either way. It is global, it shows unpaved surfaces and tracks
 * better than the alternatives, and it is the one being refined — so it should
 * be what people see first rather than something they have to find. The two
 * constants are kept separate because a token still changes what is available.
 */
/*
 * `audience: 'editors'` hides a basemap from the picker for everyone else.
 *
 * Decluttering, not access control. The token is in the page either way and
 * anybody can call the tileset directly; what this does is keep two Mapbox
 * maps out of a list that is meant to offer things people can actually rely
 * on - and let one account keep them visible to evaluate against.
 *
 * Byways Topo is deliberately NOT gated yet. It is the only drawn map here,
 * and hiding it before its Protomaps twin exists would leave the public site
 * with no drawn map at all. It joins them when there is something to replace
 * it with.
 */
export const DEFAULT_BASEMAP = 'byways-topo';
export const DEFAULT_BASEMAP_WITH_TOKEN = 'byways-topo';

/**
 * The states whose own data this app carries, spelled out.
 *
 * A state layer declares its two-letter code and the panel writes the name, so
 * adding the next state is one entry here and one in OVERLAYS rather than the
 * state's name repeated across four layer definitions.
 */
export const STATE_NAMES = {
  AR: 'Arkansas',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  HI: 'Hawaii',
  IA: 'Iowa',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  KY: 'Kentucky',
  MA: 'Massachusetts',
  MD: 'Maryland',
  ME: 'Maine',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MT: 'Montana',
  NC: 'North Carolina',
  ND: 'North Dakota',
  NE: 'Nebraska',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VA: 'Virginia',
  VT: 'Vermont',
  WA: 'Washington',
  WI: 'Wisconsin',
  WV: 'West Virginia',
  WY: 'Wyoming',
};

/** The heading every state's own layers sit under, whichever state it is. */
export const STATE_GROUP = 'State data';

/**
 * Overlays drawn on top of the basemap. Each is independently toggleable with
 * its own opacity. Add your own by appending to this list — nothing else needs
 * to change.
 */
// `legend` is a hand-written colour key. These are third-party raster tiles —
// pixels, with no attribute data to read a key out of — so a layer whose
// colours carry meaning has to say what they mean, or it is decoration.
export const OVERLAYS = [
  {
    /*
     * Sites you can actually use, drawn as the thing they are.
     *
     * This was two raster services stacked on top of each other, which meant
     * the map filled with server-drawn names in somebody else's typeface and
     * nothing on it could be clicked. Queried as points instead: an icon per
     * site, and a tap gives you its name and what kind of place it is.
     *
     * The icon comes from *which sublayer answered*, not from a code inside
     * the row. USGS splits its structures service by type — 25 is literally
     * "Campgrounds", 29 is "Picnic Areas" — so the type is known before the
     * data arrives and no code lookup can go stale.
     *
     * The BLM half is gone rather than repaired. Its service answered
     * `{"error":{"code":404,"message":"Service not found"}}`: that half of the
     * old switch had been drawing nothing, invisibly, exactly as the wildfire
     * and cell-coverage layers once did. The replacements BLM now publishes —
     * BLM_Natl_Recs_pts among them — are a separate piece of work, and half a
     * layer that works beats a whole one that lies.
     */
    id: 'recreation',
    group: 'Land & access',
    // "Recreation sites" was wrong: a trailhead is not a site, and neither is a
    // boat launch. It is recreation.
    name: 'Recreation',
    description: 'Campgrounds, trailheads, cabins and picnic areas. Tap one for details.',
    legendNote: 'Symbols are the National Park Service map set — the ones on the signs.',
    query: {
      // `{layer}` is filled per sublayer, `{bbox}` per view. GeoJSON output
      // lower-cases field names, so the popup reads `name`, not `NAME`.
      url: `${USGS_STRUCTURES}/{layer}/query`
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=NAME'
        + '&returnGeometry=true&outSR=4326&resultRecordCount=200&f=geojson',
      // The icon ids are the National Park Service symbol set, not this app's
      // pin glyphs. See assets/js/lib/nps-icons.js for why.
      points: [
        { layer: 25, icon: 'campground', label: 'Campground' },
        { layer: 26, icon: 'trailhead', label: 'Trailhead' },
        { layer: 27, icon: 'cabin', label: 'Cabin' },
        { layer: 28, icon: 'cabin', label: 'Shelter' },
        { layer: 29, icon: 'picnic', label: 'Picnic area' },
        { layer: 31, icon: 'information', label: 'Visitor center' },
        { layer: 32, icon: 'ranger', label: 'Ranger station' },
        { layer: 46, icon: 'historic', label: 'Historic site' },
      ],
      /*
       * Eight requests a view is the cost of eight types, so this does not
       * start until the view is a region rather than a continent. Below it the
       * icons would overlap into a smear anyway.
       */
      minzoom: 9,
    },
    opacity: 1,
    enabled: false,
    attribution: 'Recreation © <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS</a>'
      + ' · symbols © <a href="https://github.com/nationalparkservice/symbol-library">NPS</a>',
  },
  {
    /*
     * Where the sky is dark, which for a photography app is as much a
     * trip-planning layer as the weather is.
     *
     * VIIRS Black Marble, from NASA's GIBS. Every part of this URL was read
     * out of the service's own capabilities rather than guessed: the format is
     * png and not jpg, which is the entire difference between this and the two
     * 400s the first attempts returned, and the path is z/y/x — row before
     * column — which is WMTS convention and the reverse of every other tile
     * service in this file.
     *
     * `GoogleMapsCompatible_Level8` means the layer stops at z8. That is the
     * data, not a choice: light pollution is a regional fact, and the sensor's
     * pixel is about half a kilometre across.
     */
    id: 'light-pollution',
    group: 'Conditions',
    name: 'Light pollution',
    description: 'Night lights from VIIRS. Dark ground is dark sky.',
    legendNote: 'Brightness as the satellite sees it, not a Bortle class — '
      + 'a useful proxy for where to point a camera away from.',
    tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble'
      + '/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'],
    tileSize: 256,
    maxzoom: 8,
    opacity: 0.65,
    enabled: false,
    attribution: 'Night lights © <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>, VIIRS',
  },
  {
    /*
     * The same question as the layer above, answered the way a photographer
     * asks it.
     *
     * Black Marble is a photograph of streetlights — radiance as the satellite
     * sees it looking down. What you actually want to know is how dark the sky
     * will be looking *up*, which is a different quantity: it folds in how that
     * light scatters through the atmosphere above you, so a town twenty miles
     * away matters and one behind a ridge matters less.
     *
     * David Lorenz's atlas models that, and colours it on the scale amateur
     * astronomers already use. Both layers are here because they answer
     * different questions and disagreeing with each other is informative.
     *
     * The tiles are 1024px covering the ordinary XYZ extent, so `tileSize` is
     * 256 — that is the size the tile is *drawn* at, not the size of the image,
     * and getting it wrong would spread each tile over sixteen others' ground.
     */
    id: 'sky-brightness',
    group: 'Conditions',
    name: 'Sky brightness (Bortle)',
    description: 'Modelled night-sky brightness, on the Bortle scale.',
    legend: [
      { color: '#000000', label: 'Bortle 1–2 · truly dark' },
      { color: '#303e8c', label: 'Bortle 3 · rural' },
      { color: '#2e7d5b', label: 'Bortle 4 · rural/suburban' },
      { color: '#c8b93b', label: 'Bortle 5 · suburban' },
      { color: '#c8752e', label: 'Bortle 6–7 · bright suburban' },
      { color: '#c03a2b', label: 'Bortle 8–9 · city' },
    ],
    legendNote: 'Colours follow the atlas own scale. Modelled sky brightness, '
      + 'not a measurement — a ridge between you and a town is not in it.',
    tiles: ['https://djlorenz.github.io/astronomy/image_tiles/tiles2022/tile_{z}_{x}_{y}.png'],
    tileSize: 256,
    maxzoom: 8,
    opacity: 0.55,
    enabled: false,
    attribution: 'Sky brightness © <a href="https://djlorenz.github.io/astronomy/lp/">David J. Lorenz</a>, from VIIRS',
  },
  {
    id: 'public-lands',
    legend: [
      { color: '#FFE799', label: 'BLM' },
      { color: '#9FD08F', label: 'Forest Service' },
      { color: '#7FB2E5', label: 'National Park Service' },
      { color: '#C9A0DC', label: 'Fish & Wildlife' },
      { color: '#E8A87C', label: 'State' },
      { color: '#D9D9D9', label: 'Private or unknown' },
    ],
    group: 'Land & access',
    name: 'Public lands',
    description: 'Who manages this land — BLM, USFS, NPS, state, private.',
    // BLM's cached Surface Management Agency layer: a proper tile service, not
    // a per-request export, so it is fast and behaves like any other basemap.
    tiles: ['https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.45,
    enabled: false,
    attribution: 'Surface management © <a href="https://navigator.blm.gov/">BLM</a>',
  },
  {
    id: 'usgs-contours',
    group: 'Terrain',
    name: 'Contours',
    description: 'USGS contour lines — drape over imagery for relief.',
    tiles: ['https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.75,
    enabled: false,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'forest-cover',
    // Terrain, not a group of its own. Canopy is a property of the ground the
    // hillshade and contours describe, and a heading with one layer under it
    // is a heading that costs more than it explains.
    group: 'Terrain',
    name: 'Forest cover',
    description: 'Percentage of ground under tree canopy, from 30 m satellite data. Source: MRLC / NLCD',
    /*
     * Canopy as an overlay rather than a change to the basemap.
     *
     * Byways Topo paints its greens from Mapbox's own landcover, where wood,
     * scrub and grass all come out green and brown is simply the background
     * showing through where no polygon exists. Replacing that with canopy
     * would mean rebuilding the style around a source that can go down, and a
     * basemap that can go down is a basemap you cannot rely on. As an overlay
     * an outage costs one switch, and the map underneath is untouched.
     *
     * Thirty-metre data, so it is honest to about zoom 14 and no further.
     */
    tiles: [wmsTile(MRLC_WMS, MRLC_CANOPY)],
    tileSize: 256,
    maxzoom: 14,
    opacity: 0.55,
    enabled: false,
    attribution: 'Canopy © <a href="https://www.mrlc.gov/">MRLC</a> / NLCD',
  },
  {
    id: 'faa-restrictions',
    legend: [
      { color: '#C0392B', label: 'No fly' },
      { color: '#D9A441', label: 'Permit or caution' },
    ],
    /*
     * One layer, two severities, because that is the only distinction that
     * changes what you do.
     *
     * A prohibited area and a national park are both worth seeing before you
     * drive somewhere, and they are not the same fact. Red is "do not fly
     * here"; amber is "you can, with permission, or with care". Colouring by
     * agency instead would have made six categories out of one question.
     *
     * Hatched rather than washed, for the reason Ohio's lands are: these
     * overlap each other and everything else, and a flat fill stacked twice
     * reads as a third colour that means nothing.
     *
     * MOAs are excluded, and until now that was only a comment.
     *
     * A military operating area does not restrict civilian flight - it is an
     * advisory, generally based above 1,000 AGL, which is 600 feet above
     * anything this map's users are flying. This paragraph has said so since
     * the layer was written, while the query said `where=1=1` and drew them
     * anyway, in the red reserved for a prohibition.
     *
     * Measured, because the size of it is the argument: MOAs are 718 of the
     * 1,542 features in that service - 46.6% of everything the layer draws.
     * Not a stray polygon; half the warnings on screen were ones that do not
     * apply. Counted with tools/probe-service.mjs.
     *
     * Alert and Warning areas were red too, and are amber now.
     *
     * The same argument as the MOAs, and it took a second reading of my own
     * comment to notice I had written it down as a decision and left it. An
     * Alert area is airspace with a high volume of pilot training or unusual
     * aerial activity: nothing is restricted, and every pilot in it carries
     * the ordinary responsibility for seeing and avoiding. A Warning area is
     * over water, generally beyond three nautical miles from the coast, and
     * warns of activity hazardous to aircraft - it does not prohibit entry,
     * and it is not ground anybody launches from.
     *
     * Measured over the whole layer rather than a sample, counted by the
     * service: A 39, D 5, MOA 718, P 13, R 555, W 212, of 1,542. So Alert and
     * Warning together are 251 of the 824 features this layer was drawing in
     * the colour reserved for "do not fly" - three in ten of every warning on
     * screen, saying a thing that was not true of them.
     *
     * D stays red, and that is deliberate rather than settled: five features,
     * a code this probe did not identify, and red is the conservative
     * direction for a category nobody has read. Worth identifying before
     * anyone relies on it.
     */
    legendNote: 'Standing and scheduled restrictions only. Same-day TFRs — fires, VIP '
      + 'movements — are NOTAMs and are not in this layer; use the link on any feature to '
      + 'check the current list before you fly. Red is where flight is prohibited or '
      + 'restricted. Amber is everything that asks for care rather than permission: '
      + 'wilderness and Park Service land, where flying over is not itself prohibited but '
      + 'taking off, landing or operating from the ground is — so it means find somewhere '
      + 'else to stand, not somewhere else to fly — and alert and warning areas, which '
      + 'restrict nothing but mark where other aircraft are doing something unusual.',
    group: 'Airspace',
    name: 'Restrictions & advisories',
    description: 'Where drones may not fly, and where you would need permission. Source: FAA, NPS, USFS',
    query: {
      /*
       * The FAA services share a host and a query shape, so they differ only
       * by the name in `{layer}`. Anything on another host carries its own
       * `url` instead - the sublayer machinery takes either.
       */
      url: 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/{layer}/FeatureServer/0/query'
        + '?where={where}&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=300&f=geojson',
      uses: [
        {
          layer: 'Special_Use_Airspace',
          use: 'Prohibited or restricted airspace',
          nameField: 'NAME',
          tag: { severity: 'No fly' },
          // Named rather than excluded. `<> 'MOA'` swept in every code the FAA
          // adds later at the severity reserved for a prohibition, which is
          // the wrong default for a filter nobody will revisit.
          where: "TYPE_CODE IN ('P','R','D')",
        },
        /*
         * The same service, asked a second time for the advisories.
         *
         * Two requests rather than one filtered afterwards, because each
         * sublayer answer carries its own severity tag and the layer caps at
         * 300 records — sorting them out after the fetch would spend the cap
         * on features that then get recoloured anyway.
         */
        {
          layer: 'Special_Use_Airspace',
          use: 'Alert or warning area',
          nameField: 'NAME',
          tag: { severity: 'Permit or caution' },
          where: "TYPE_CODE IN ('A','W')",
        },
        {
          layer: 'National_Defense_Airspace_TFR_Areas',
          use: 'National defence area',
          nameField: 'NAME',
          tag: { severity: 'No fly' },
        },
        // A stadium TFR is real but not permanent: it runs from an hour before
        // an event to an hour after, for venues seating 30,000 or more. Red,
        // because when it is on it is a genuine prohibition, and the panel
        // says when.
        {
          layer: 'Stadiums',
          use: 'Stadium — during events',
          nameField: 'NAME',
          tag: { severity: 'No fly' },
        },
        /*
         * Wilderness, on its own host, and the first amber this layer can draw.
         *
         * Reported from Dolly Sods: Aloft shows a Caution there and this map
         * showed nothing. It was not a broken request - the layer queried
         * three FAA services and no wilderness service of any kind, while its
         * legend offered a 'Permit or caution' band nothing could produce and
         * its description named USFS. An advisory layer that silently omits a
         * whole category of advisory is worse than one that never claimed it.
         *
         * The service is the Forest Service's, and holds the whole National
         * Wilderness Preservation System rather than only the acres USFS
         * manages. Measured over that box before it was written in: 200,
         * application/geo+json, one Polygon, CORS for our origin, and
         * "wildernessname":"Dolly Sods Wilderness". f=geojson is not universal
         * on a MapServer, so that was worth asking rather than assuming.
         *
         * Amber, not red. Wilderness overflight is an advisory - the FAA asks
         * for 2,000 feet AGL over it - and the land manager's own rules on
         * taking off and landing are what actually bite. Drawing it in the
         * no-fly red would put it beside prohibited airspace, which is the
         * mistake the MOA exclusion above exists to avoid.
         */
        {
          url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer/0/query'
            + '?where={where}&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
            + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
            + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=300&f=geojson',
          layer: 'Wilderness',
          use: 'Wilderness area',
          /*
           * Which column this service calls a name, declared beside the
           * service rather than inferred at the label.
           *
           * Lower-case, measured off a returned row: ArcGIS lower-cases field
           * names in GeoJSON output whatever displayFieldName says. The label
           * below has to name every one of these, and a test asserts that
           * equality - so a service added later without this line fails
           * rather than drawing unlabelled shapes nobody can identify.
           */
          nameField: 'wildernessname',
          tag: { severity: 'Permit or caution' },
        },
        /*
         * Every acre the Park Service administers, and the second amber.
         *
         * Reported alongside Dolly Sods: New River Gorge showed nothing.
         * Wilderness does not cover it - it is a park with no designated
         * wilderness in it - so this is a separate service and a separate
         * question, and the layer's description claimed NPS for months
         * without querying it.
         *
         * Layer 2 of that FeatureServer is the unit boundary. Measured over
         * New River Gorge before it was written in: 200, CORS for any origin,
         * GeoJSON, and "UNIT_NAME":"New River Gorge National Park and
         * Preserve".
         *
         * UPPER case, and that is the point of having asked. The wilderness
         * service above answers lower case from the same kind of query; this
         * one is a hosted FeatureServer and keeps the case it was defined
         * with. There is no rule to infer here, only two services that had to
         * be asked separately - and a label taking its case from the other
         * one renders nothing while looking like a park with no name.
         *
         * All unit types, not only the ones called National Park. Launching,
         * landing and operating from NPS land is prohibited under 36 CFR 1.5
         * and Policy Memorandum 14-05, and that rule does not soften for a
         * parkway or a scenic trail. Drawing only the famous ones would be
         * the map choosing which prohibitions to mention.
         *
         * Amber rather than red, deliberately, and this is a judgement rather
         * than a reading of the data. What is prohibited is taking off,
         * landing and operating from the ground; NPS does not control the
         * airspace, and flying over at altitude is not itself an offence.
         * Red is reserved here for airspace you may not be in at all. The
         * identify card names the actual rule, because a colour cannot.
         */
        {
          url: 'https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/'
            + 'NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2/query'
            + '?where={where}&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
            + '&spatialRel=esriSpatialRelIntersects&outFields=UNIT_NAME,UNIT_TYPE'
            + '&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0005'
            + '&resultRecordCount=300&f=geojson',
          layer: 'NPS_Boundary',
          use: 'National Park Service land',
          nameField: 'UNIT_NAME',
          tag: { severity: 'Permit or caution' },
        },
      ],
      /*
       * The same floor the drone grid has, and now for the same two reasons.
       *
       * Asked for: restrictions should be a zoomed-in layer like Drone
       * ceilings. It is also what the layer needs. Five services now answer
       * this one switch, each capped at 300 records, and a state-wide view
       * asks all five for everything inside it - so the cap starts truncating
       * and the map draws a confident partial answer, which on this layer is
       * the worst kind of wrong. A view that cannot be complete is better not
       * drawn.
       *
       * And it is the FAA's org quota, measured today at 6,006 request units
       * against a 6,000-per-minute ceiling: wide views are the expensive ones.
       *
       * Below the floor the layer draws nothing and the panel says why, which
       * is the part that makes a floor honest rather than a silent gap.
       */
      minzoom: 10,
      color: '#C0392B',
      /*
       * Two names for one thing. The FAA's three services answer NAME; the
       * wilderness service answers `wildernessname`, lower-case, because
       * ArcGIS GeoJSON output lower-cases field names whatever the service's
       * own displayFieldName says - measured off a row rather than read off
       * the field list, which is how LOCAL_TYPE survived here for months.
       */
      label: ['NAME', 'wildernessname', 'UNIT_NAME'],
      fields: {
        severity: { label: 'Status' },
        use: { label: 'Kind' },
        wildernessname: { label: 'Wilderness' },
        UNIT_NAME: { label: 'Park unit' },
        UNIT_TYPE: { label: 'Designation' },
        TYPE_CODE: { label: 'Type' },
        UPPER_VAL: { label: 'Ceiling', suffix: ' ft' },
        LOWER_VAL: { label: 'Floor', suffix: ' ft' },
        WKHR_CODE: { label: 'Hours' },
        WKHR_RMK: { label: 'Hours note' },
        CITY: { label: 'City' },
      },
      links: [
        { label: 'Current TFRs', href: 'https://tfr.faa.gov/tfr2/list.html' },
        { label: 'B4UFLY', href: 'https://www.faa.gov/uas/getting_started/b4ufly' },
      ],
      fillBy: {
        field: 'severity',
        hatch: true,
        colors: { 'No fly': '#C0392B', 'Permit or caution': '#D9A441' },
        fallback: '#B08A4A',
      },
    },
    opacity: 0.45,
    enabled: false,
    attribution: 'Restrictions © <a href="https://www.faa.gov/">FAA</a>, '
      + 'wilderness © <a href="https://www.fs.usda.gov/">USFS</a>, '
      + 'park boundaries © <a href="https://www.nps.gov/">NPS</a>',
  },
  {
    id: 'faa-uas-grid',
    legend: [
      { color: '#B33A3A', label: '0 ft — no instant approval' },
      { color: '#C9704A', label: 'up to 100 ft' },
      { color: '#C9A44A', label: 'up to 200 ft' },
      { color: '#7FA84A', label: 'up to 300 ft' },
      { color: '#4A8FA8', label: 'up to 400 ft' },
    ],
    /*
     * What the number is, stated in the panel, because getting it wrong is
     * easy and consequential.
     *
     * It is not a speed limit for the sky. Every cell on this grid is inside
     * controlled airspace, and inside controlled airspace a Part 107 flight
     * needs authorisation regardless of what the cell says. The number is how
     * high LAANC will grant that authorisation instantly. Zero does not mean
     * the airspace is closed - it means nothing there is pre-approved and the
     * request goes the slow way instead.
     *
     * The first draft of this legend read "0 ft — authorisation needed",
     * which implied the other four values do not need one. They do.
     */
    legendNote: 'Authorisation is required anywhere this grid appears. The ceiling is how '
      + 'high LAANC grants it instantly; 0 means the request goes to further coordination '
      + 'or FAA DroneZone instead. Not a flight authorisation — check before you fly.',
    group: 'Airspace',
    name: 'Drone ceilings',
    description: 'How high LAANC instantly approves a drone flight, in feet above ground. Source: FAA',
    /*
     * The UAS Facility Map: the grid LAANC reads when it approves a flight.
     *
     * Outside controlled airspace there is no grid at all, which is not a
     * failure - it is the answer, and it means Class G where you need no
     * authorisation. Reading its absence as a broken layer cost a round: a box
     * drawn in open country east of Lexington came back empty and looked
     * exactly like a dead service, until a count with no geometry filter
     * returned 370,441 rows and a box over Blue Grass Airport returned a
     * ceiling.
     *
     * Expect it to be intermittent, and not because of anything here. The
     * FAA's ArcGIS Online org has a shared per-minute request quota already
     * being exceeded by its other consumers - a three-request probe run came
     * back "API calls quota exceeded (6138 request units)! maximum allowed
     * request units (6000) per Minute". That arrives as a 200 with an error
     * object, which the refresh tells apart from an empty view, so the layer
     * badges itself as not responding and keeps what it last drew.
     */
    query: {
      url: 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=CEILING%2CAPT1_NAME%2CAPT1_FAAID%2CAPT1_LAANC%2CAPT2_NAME'
        + '&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=1000&f=geojson',
      // The grid is dense - a metro area is hundreds of cells - so it stays
      // off the map until the view is small enough for the cells to read.
      minzoom: 10,
      color: '#4A8FA8',
      label: 'CEILING',
      /*
       * The order these are declared is the order the panel reads them, and
       * the coded columns are spelled out rather than printed as 1 and 0.
       *
       * APT1_LAANC is whether that airport takes LAANC requests at all. It is
       * a separate question from the ceiling: an airport outside LAANC sends
       * every request to DroneZone however high its grid says.
       *
       * UNIT is dropped. It reads FT for every row in the service, and a
       * column that never varies is a row in the panel that never informs.
       */
      fields: {
        CEILING: {
          label: 'Ceiling',
          suffix: ' ft AGL',
          values: { 0: '0 ft — no instant approval' },
        },
        APT1_NAME: { label: 'Airport' },
        APT1_FAAID: { label: 'FAA ID' },
        APT1_LAANC: {
          label: 'LAANC',
          values: { 1: 'Airport participates', 0: 'Airport does not participate' },
        },
        APT2_NAME: { label: 'Also under' },
      },
      /*
       * Every 50-foot step, not only the hundreds.
       *
       * Version 5 of the grid publishes 50-foot increments, so a map covering
       * only 0/100/200/300/400 would send 50, 150, 250 and 350 to the fallback
       * colour - which is exactly the failure fillBy already had once, silent
       * and looking like a colour scheme rather than a bug. A step that never
       * occurs costs nothing; one that is missing costs a wrong colour.
       */
      /*
       * Where a pilot goes to actually ask.
       *
       * The FAA's supplier list rather than one company's app: it is the
       * FAA's own page, it stays current without us, and it keeps this map
       * out of the business of recommending a vendor.
       *
       * No phone number. The FAA's airport layer publishes identity, position,
       * elevation and operating hours and carries no contact column at all -
       * checked field by field rather than assumed - and a control tower's
       * number would be the wrong answer even if it were there. Part 107
       * authorisation is not granted over the phone, and offering a number
       * invites a call that cannot do what the caller wants.
       */
      links: [
        { label: 'Request authorisation', href: 'https://faadronezone-access.faa.gov/' },
        { label: 'Instant approval (LAANC)', href: 'https://www.faa.gov/uas/programs_partnerships/data_exchange' },
        { label: 'B4UFLY', href: 'https://www.faa.gov/uas/getting_started/b4ufly' },
      ],
      fillBy: {
        field: 'CEILING',
        colors: {
          0: '#B33A3A',
          50: '#C1573F', 100: '#C9704A',
          150: '#C98A4A', 200: '#C9A44A',
          250: '#A3A64A', 300: '#7FA84A',
          350: '#5E9B7A', 400: '#4A8FA8',
        },
        fallback: '#6E8CA8',
      },
    },
    opacity: 0.4,
    enabled: false,
    attribution: 'UAS facility map © <a href="https://www.faa.gov/">FAA</a>',
  },
  {
    id: 'usgs-transport',
    group: 'Routes',
    name: 'Roads & trails (USGS)',
    description: 'USGS transportation network, including forest routes.',
    /*
     * Worth saying out loud, because it cost four rounds of debugging.
     *
     * This is a finished picture from USGS, and USGS draws its own route
     * markers into it. Over Byways Topo, which draws markers of its own, a
     * numbered highway ends up with two shields in different styles a few
     * hundred metres apart — which reads as the app rendering the same road
     * twice, and was chased as exactly that through three wrong explanations
     * before the real one turned up.
     *
     * Nothing here can suppress theirs; the shields are pixels by the time they
     * arrive. So the note says it instead.
     */
    legendNote: 'USGS draws its own route markers into these tiles, so numbered '
      + 'highways will carry two shields when Byways Topo is underneath.',
    tiles: ['https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: 'wildfire',
    legend: [
      { color: '#D84315', label: 'Active perimeter' },
      { color: '#8D6E63', label: 'Recently burned' },
    ],
    group: 'Conditions',
    name: 'Wildfire',
    description: 'Current large-fire perimeters from NIFC. Zoom in to a region to load them.',
    legendNote: 'The mapped edge of a fire as last flown or walked, which can be hours old '
      + 'and is never a closure map. Check the responsible agency before travelling.',
    /*
     * Queried rather than tiled, because NIFC publishes this as a feature
     * service and nothing else. The previous URL asked that service for
     * `f=image`, which a feature service cannot produce: it answered 400 to
     * every tile, so this layer drew nothing from the day it was added and
     * nothing said so. tools/check-layers.mjs is what finally caught it.
     */
    query: {
      url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/'
        + 'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=attr_IncidentName,attr_GACC'
        + '&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0005'
        + '&resultRecordCount=400&f=geojson',
      // Below this, "every fire in the country" is both unreadable and an
      // unkind thing to ask of the service.
      minzoom: 6,
      color: '#D84315',
    },
    opacity: 0.6,
    enabled: false,
    attribution: 'Fire perimeters © <a href="https://www.nifc.gov/">NIFC</a>',
  },
  {
    id: 'usfs-mvum',
    /*
     * The service's own key, not a written-out one.
     *
     * This used to list five colours — green for open to all vehicles, blue for
     * highway-legal only, and so on — described as "the Forest Service MVUM
     * key". The service draws the roads in black. So the panel was explaining a
     * map that does not exist, which is worse than explaining nothing: a reader
     * looking for the green roads concludes the layer is broken.
     *
     * No sublayer named, because the export renders roads and trails together
     * and naming one would describe half of what is drawn.
     */
    legendJSON: {
      // The same service the tiles come from, so the key cannot describe a
      // different rendering than the one on screen.
      url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/legend?f=pjson',
    },
    legendNote: 'The MVUM is the legal authority for what is open — always check '
      + 'the current year\'s map before relying on it.',
    group: 'Land & access',
    name: 'Forest roads (MVUM)',
    description: 'Which Forest Service roads are legally open, and to what.',
    // Every tile here is a render request the Forest Service answers on demand
    // rather than a cached image, so the cost is per-tile and the wait is real.
    // Two things help: 512px tiles, which cover the same screen in a quarter of
    // the requests, and a minzoom, since a national view of forest roads is
    // both illegible and the most expensive thing you can ask this service for.
    /*
     * Roads and trails only, from the newer service.
     *
     * The old request drew every sublayer this service has — two symbology
     * layers, a status polygon set and several scale-banded copies — and then
     * discarded most of it as transparent. That is thirty seconds of somebody
     * else's CPU per view for pixels nobody sees, which is what "it took about
     * thirty seconds to get eighty percent of the lines" was paying for.
     *
     * `layers=show:1,2` is Motor Vehicle Use Map: Roads and Trails, named by
     * the service itself. Checked drawing before being switched to.
     */
    /*
     * What a tap on one of these lines can ask.
     *
     * The same sublayers the raster draws, so the card can only describe a
     * line that is actually on screen. `identify` rather than a spatial query
     * because it takes a tolerance in screen pixels, and the whole difficulty
     * is that a road is drawn thinner than a finger is wide.
     */
    identify: {
      url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/identify',
      layers: '1,2',
      source: 'Forest Service MVUM',
      /*
       * The MVUM schema is one column per vehicle class, each with a matching
       * `<class>_datesopen`: motorcycle / motorcycle_datesopen,
       * otherwheeled_ohv / otherwheeled_ohv_datesopen, and so on. Read off the
       * service rather than from the printed legend.
       *
       * So there is no useful fixed field list here — `vehicles: true` tells
       * the card to pair them up instead, which answers "what may I drive on
       * this, and when" in one block however many classes a district
       * publishes.
       */
      vehicles: true,
      /*
       * `decode` turns the agency's own vocabulary into a sentence.
       *
       * These are codes written for the people who maintain the data, and read
       * straight out they mislead: "yearlong" sounds like a year-long
       * restriction rather than a road that is open all year, and "2 - HIGH
       * CLEARANCE VEHICLES" is a maintenance level whose number means nothing
       * to anybody who has not read the handbook. Anything not listed falls
       * through to a generic tidy-up rather than being hidden.
       */
      fields: [
        { name: 'name', label: 'Road' },
        {
          name: 'seasonal',
          label: 'Open',
          decode: {
            yearlong: 'All year',
            seasonal: 'Part of the year — see the dates per vehicle below',
          },
        },
        {
          name: 'surfacetype',
          label: 'Surface',
          decode: {
            'nat - native material': 'Dirt — native material, no surfacing',
            'imp - improved native material': 'Improved dirt',
            'agg - crushed aggregate or gravel': 'Gravel',
            'p - paved': 'Paved',
            'pav - paved': 'Paved',
          },
        },
        {
          name: 'operationalmaintlevel',
          label: 'Road standard',
          decode: {
            '1 - basic custodial care (closed)': 'Level 1 — not maintained for vehicles',
            '2 - high clearance vehicles': 'Level 2 — high clearance needed',
            '3 - suitable for passenger cars': 'Level 3 — passenger cars',
            '4 - moderate degree of user comfort': 'Level 4 — maintained, comfortable',
            '5 - high degree of user comfort': 'Level 5 — paved or fully maintained',
          },
        },
        { name: 'jurisdiction', label: 'Managed by', decode: { 'fs - forest service': 'Forest Service' } },
      ],
    },
    tiles: ['https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32'
      + '&transparent=true&layers=show:1,2&f=image'],
    tileSize: 512,
    minzoom: 10,
    maxzoom: 16,
    opacity: 0.9,
    enabled: false,
    attribution: 'Motor Vehicle Use Maps © <a href="https://www.fs.usda.gov/">USDA Forest Service</a>',
  },
  {
    /*
     * The other half of legal off-road, and the bigger half out west.
     *
     * The Forest Service layer above covers national forest. Most of the
     * driveable public land in Nevada, Utah and Arizona is BLM, and until now
     * this app had nothing for it — which made "where am I allowed to drive"
     * answerable in half the country and silent in the other half.
     *
     * GTLF's sublayers *are* the designation: 0 and 1 are roads managed for
     * public and for limited public motorized use, 2 and 3 the same for trails.
     * That is why only those four are drawn. Sublayers 4 to 7 are the
     * non-motorized and unassessed trails, which belong on a hiking map rather
     * than this one.
     */
    id: 'blm-routes',
    group: 'Land & access',
    name: 'BLM routes (GTLF)',
    description: 'BLM roads and trails managed for motor vehicles.',
    legendJSON: {
      url: 'https://gis.blm.gov/arcgis/rest/services/transportation/'
        + 'BLM_Natl_GTLF_Public_Display/MapServer/legend?f=pjson',
    },
    legendNote: 'Ground Transportation Linear Features. BLM travel management '
      + 'plans are the authority for what is open; this is their published map of it.',
    /*
     * GTLF publishes the designation as the sublayer NAME, not as a field:
     * "Roads Managed for Public Motorized Use", "…for Limited Public Motorized
     * Use", and six more. So which sublayer answers is the answer, and the
     * card reads it off `layerName` rather than hunting for a column.
     *
     * The four asked here are the four the raster draws. The other four are
     * non-motorised and unassessed trails, which are a different question from
     * "can I drive this".
     */
    identify: {
      url: 'https://gis.blm.gov/arcgis/rest/services/transportation/'
        + 'BLM_Natl_GTLF_Public_Display/MapServer/identify',
      layers: '0,1,2,3',
      source: 'BLM travel management',
      /*
       * Read off the service's own field list. GTLF names its designations
       * rather than spreading them over a column per vehicle the way the MVUM
       * does, so a fixed order works here — and the order is the reader's:
       * what is it, may I drive it, when, and what does the limit actually
       * say. OHV_DSGNTN_LIM_EXPLAIN is the one worth surfacing; it is where a
       * "limited" designation stops being a word and says what the limit is.
       */
      /*
       * Cut to what decides whether you drive it.
       *
       * GTLF publishes about thirty columns and the first pass showed eleven,
       * which is a wall on a phone. Gone: the administrative state (you can see
       * where you are), the NEPA document number, the FLTP and external
       * distribution flags, the designating authority and the route management
       * objective — all real data, none of it an answer to "can I take this
       * road". Route ownership went too: the card is already headed BLM.
       */
      fields: [
        { name: 'ROUTE_PRMRY_NM', label: 'Route' },
        {
          name: 'PLAN_ASSET_CLASS',
          label: 'Type',
          decode: {
            'transportation system - road': 'Road',
            'transportation system - trail': 'Trail',
            'transportation system - primitive road': 'Primitive road',
          },
        },
        {
          name: 'PLAN_OHV_ROUTE_DSGNTN',
          label: 'Off-highway use',
          decode: {
            open: 'Open',
            limited: 'Limited — see below',
            closed: 'Closed to off-highway vehicles',
          },
        },
        { name: 'OHV_DSGNTN_LIM_EXPLAIN', label: 'The limit' },
        { name: 'PLAN_ALLOW_MODE_TRNSPRT', label: 'Allowed' },
        { name: 'PLAN_SEASON_RSTRCT_CODE', label: 'Season' },
        {
          name: 'OBSRVE_SRFCE_TYPE',
          label: 'Surface',
          decode: {
            'nat - native material': 'Dirt — native material, no surfacing',
            'imp - improved native material': 'Improved dirt',
            'agg - crushed aggregate or gravel': 'Gravel',
            'p - paved': 'Paved',
            'pav - paved': 'Paved',
          },
        },
      ],
    },
    tiles: ['https://gis.blm.gov/arcgis/rest/services/transportation/'
      + 'BLM_Natl_GTLF_Public_Display/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32'
      + '&transparent=true&layers=show:0,1,2,3&f=image'],
    tileSize: 512,
    // Rendered per request like the MVUM, so the same floor applies: a national
    // view of every BLM route is illegible and the most expensive thing anyone
    // can ask this service for.
    minzoom: 10,
    maxzoom: 16,
    opacity: 0.9,
    enabled: false,
    attribution: 'Routes © <a href="https://navigator.blm.gov/">BLM</a>',
  },
  /*
   * Weather, as a group rather than a single radar switch.
   *
   * The forecast layers are here for two different readers. One is planning a
   * drive and wants to know whether the pass will be snowed in; the other is
   * planning a photograph, and for them cloud cover is the whole question — a
   * clear night is the difference between the Milky Way and a grey frame. Both
   * are answered by the same NDFD grids the Photography panel already reads
   * numbers from, drawn instead of tabulated.
   *
   * All of them are forecasts, not observations: a temperature layer shows what
   * the National Weather Service expects, not what a thermometer says.
   */
  {
    id: 'radar',
    legend: [
      { color: '#7FD4F5', label: 'Light' },
      { color: '#2E9BD6', label: 'Moderate' },
      { color: '#1F6FB2', label: 'Heavy' },
      { color: '#F2C744', label: 'Very heavy' },
      { color: '#D9534F', label: 'Intense / hail' },
    ],
    group: 'Weather',
    name: 'Radar',
    description: 'Current precipitation from NOAA. Click a point for storm tracks.',
    tiles: ['https://nowcoast.noaa.gov/geoserver/weather_radar/wms'
      + '?service=WMS&version=1.3.0&request=GetMap&layers=base_reflectivity_mosaic'
      + '&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true'],
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.6,
    enabled: false,
    attribution: 'Radar © <a href="https://www.noaa.gov/">NOAA</a>',
  },
  {
    id: 'weather-sky',
    group: 'Weather',
    name: 'Cloud cover',
    description: 'Forecast sky cover — the layer that decides whether a night shoot is worth driving to.',
    legendNote: 'Percentage of the sky the National Weather Service expects to be covered. '
      + 'Under about 20% is a clear night.',
    ...ndfdLayer('sky'),
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.5,
    enabled: false,
    attribution: NOAA_ATTRIBUTION,
  },
  {
    id: 'weather-temp',
    group: 'Weather',
    name: 'Temperature',
    description: 'Forecast air temperature, 2 m above the ground.',
    // The National Weather Service's own GeoServer rather than nowCOAST, which
    // publishes the same NDFD grid: its legend honours the horizontal layout
    // and nowCOAST's does not, so this way the whole group's keys match.
    ...ndfdLayer('temp'),
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.5,
    enabled: false,
    attribution: NOAA_ATTRIBUTION,
  },
  {
    id: 'weather-wind',
    group: 'Weather',
    name: 'Wind speed',
    description: 'Forecast sustained wind at 10 m. Gusts run higher.',
    legendNote: 'Knots. A tripod starts arguing at about 15, and a high-sided vehicle at about 30.',
    ...ndfdLayer('wspd'),
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.5,
    enabled: false,
    attribution: NOAA_ATTRIBUTION,
  },
  {
    id: 'weather-rain-chance',
    group: 'Weather',
    name: 'Chance of rain',
    description: 'Probability of precipitation over the next 12 hours.',
    ...ndfdLayer('pop12'),
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.5,
    enabled: false,
    attribution: NOAA_ATTRIBUTION,
  },
  {
    id: 'weather-snowfall',
    group: 'Weather',
    name: 'Forecast snowfall',
    description: 'Snow accumulation the National Weather Service expects.',
    legendNote: 'The next forecast period rather than a running total.',
    seasonal: true,
    ...ndfdLayer('snow'),
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.6,
    enabled: false,
    attribution: NOAA_ATTRIBUTION,
  },
  {
    id: 'snow-depth',
    group: 'Weather',
    name: 'Snow on the ground',
    description: 'Modelled snow depth from the National Snow Analyses.',
    legendNote: 'NOHRSC models this at 1 km from gauges, satellite and radar.',
    // Empty out of season, which is the layer working rather than failing.
    // tools/check-layers.mjs reads this so a summer run does not report a
    // snow map with no snow on it as a broken layer.
    seasonal: true,
    // Sublayer 3 is the depth raster itself; 0 is the group it sits inside,
    // and 1 and 2 are its boundary and footprint. The legend comes from the
    // same service's WMS endpoint, which is the only one of the two that can
    // draw a key.
    tiles: ['https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true'
      + '&layers=show:3&f=image'],
    // This service publishes no legend graphic — asking for one returns an
    // empty image — but it will describe its key as JSON, which is better
    // anyway: the depths come with it.
    legendJSON: {
      url: 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/legend?f=pjson',
      layer: 3,
    },
    tileSize: 256,
    maxzoom: 12,
    opacity: 0.65,
    enabled: false,
    attribution: 'Snow analysis © <a href="https://www.nohrsc.noaa.gov/">NOAA NOHRSC</a>',
  },
  /*
   * Cell coverage was here, and drew nothing from the day it was added.
   *
   * broadbandmap.fcc.gov answers 403 to anything that is not its own page —
   * from a script, from a CI runner, and from this site — and sends no CORS
   * header even then, so a browser could not read the tile if it arrived. That
   * is not a URL that needs correcting; it is a service that is not open.
   *
   * Per carrier is a further step again. The FCC's public mobile coverage
   * layers do exist on ArcGIS Online, and they are readable — but their columns
   * are `technology, mindown, minup, environmnt, h3_res9_id` and nothing else.
   * There is no provider field: what is published is coverage by technology,
   * with the carrier behind it stripped. Per-carrier maps live in the
   * downloadable Broadband Data Collection files, which are gigabytes of
   * hexagons and not something a static site can serve.
   *
   * So there is no layer here rather than a switch that does nothing. A dead
   * switch is worse than an absent one: it costs somebody the time it takes to
   * work out that the map is not broken.
   */
  /*
   * Kentucky's own data.
   *
   * The commonwealth publishes aerial photography at three inches and hillshade
   * derived from five-foot lidar, statewide, in Web Mercator, with CORS open —
   * all of which is better than any national service in this list, and none of
   * which exists a foot over the state line. That is what `states` is for: the
   * panel offers these only while the map is over Kentucky, so the layer list
   * does not become fifty states of switches that draw nothing.
   *
   * These are ImageServers, which export through `exportImage` rather than the
   * MapServer's `export`. Every one was checked over Hardyville rather than
   * over the Smokies, because a Kentucky service is correctly empty in
   * Tennessee and the default probe tile said "blank" for all of them.
   */
  {
    id: 'ky-aerial',
    // Probed over Kentucky rather than the default tile in Tennessee, where this
    // layer is correctly empty and looked broken for it.
    at: [-84.5, 37.8],
    states: ['KY'],
    name: 'Aerial (3 in)',
    description: 'Three-inch imagery — close enough to tell a gate from a turnout. Source: KyFromAbove',
    tiles: [`${KY_RASTER}/ImageServices/Ky_KYAPED_Phase3_3IN_WGS84WM/ImageServer/exportImage${ESRI_IMAGE}`],
    tileSize: 256,
    maxzoom: 19,
    opacity: 1,
    enabled: false,
    attribution: KY_ATTRIBUTION,
  },
  {
    id: 'ky-hillshade',
    // Probed over Kentucky rather than the default tile in Tennessee, where this
    // layer is correctly empty and looked broken for it.
    at: [-84.5, 37.8],
    states: ['KY'],
    name: 'Lidar hillshade (5 ft)',
    description: 'Five-foot lidar relief — old grades and benches the contours smooth away. Source: KyFromAbove',
    tiles: [`${KY_RASTER}/ElevationServices/Ky_DEM_KYAPED_5FT_MultiDirectionalHillshade/ImageServer/exportImage${ESRI_IMAGE}`],
    tileSize: 256,
    maxzoom: 18,
    opacity: 0.7,
    enabled: false,
    attribution: KY_ATTRIBUTION,
  },
  /*
   * West Virginia's own data.
   *
   * Leaf-off rather than the state's NAIP mosaic, which also answers and is
   * also good: NAIP is flown in summer, and summer over West Virginia is a
   * green ceiling. The leaf-off mosaic shows the roadbed under the canopy,
   * which is the entire reason to look at aerial photography over a forest.
   *
   * These are MapServers, so they export through `export` rather than the
   * ImageServer's `exportImage` — the same trap the Kentucky block notes in
   * reverse. Probed over Canaan Valley, because a West Virginia service is
   * correctly blank in Tennessee and the default probe tile would call every
   * one of them empty.
   */
  {
    id: 'wv-aerial',
    at: [-79.42, 39.06],
    states: ['WV'],
    name: 'Aerial, leaf-off',
    description: 'Flown with the leaves down, so the ground under the canopy shows. Source: WV GIS Technical Center',
    tiles: [`${WV_GIS}/Imagery_BaseMaps_EarthCover/wv_imagery_WVGISTC_leaf_off_mosaic/MapServer/export${ESRI_IMAGE}`],
    tileSize: 256,
    maxzoom: 18,
    opacity: 1,
    enabled: false,
    attribution: WV_ATTRIBUTION,
  },
  {
    id: 'wv-hillshade',
    at: [-79.42, 39.06],
    states: ['WV'],
    name: 'Lidar hillshade (1 m)',
    description: 'One-metre lidar relief — old grades and benches the contours smooth away. Source: WV GIS Technical Center',
    tiles: [`${WV_GIS}/Elevation/wv_hillshade_1m_mosaic/MapServer/export${ESRI_IMAGE}`],
    tileSize: 256,
    maxzoom: 17,
    opacity: 0.7,
    enabled: false,
    attribution: WV_ATTRIBUTION,
  },
  /*
   * Tennessee's own data, which is one layer rather than two.
   *
   * TNMap's basemap folder holds exactly two services and the other is the
   * USGS topo the national basemap already draws. Its elevation folder holds
   * flood water-surface elevations and no hillshade, so there is nothing there
   * worth a switch — and a switch that draws the same map twice is a choice
   * nobody can make correctly.
   */
  {
    id: 'tn-aerial',
    at: [-85.03, 35.95],
    states: ['TN'],
    name: 'Aerial',
    description: 'Aerial photography flown for the state rather than mosaicked nationally. Source: Tennessee STS GIS',
    tiles: [`${TN_GIS}/BASEMAPS/IMAGERY_WEB_MERCATOR/MapServer/export${ESRI_IMAGE}`],
    tileSize: 256,
    maxzoom: 18,
    opacity: 1,
    enabled: false,
    attribution: TN_ATTRIBUTION,
  },
  /*
   * Ohio and Indiana have no layer here, and that is the finding rather than an
   * omission.
   *
   * Both of Ohio's OGRIP hostnames are gone — gis1.oit.ohio.gov answers 404 to
   * its own service directory and ogrip.oit.ohio.gov does not resolve — as is
   * the transport department's server. Indiana's clearing house answers, but
   * what it publishes is county-scale odds and ends: bathymetry for two lakes,
   * a handful of thematic rasters, no statewide imagery and no lidar
   * derivative. Neither state gets a switch until one of them publishes
   * something a switch could draw.
   */
  /*
   * Kentucky's topo sheets were here, and are gone.
   *
   * They are the USGS 2016 series republished by the state — the same sheets
   * the national topo basemap already draws, at a lower maximum zoom. Two
   * switches for one map is a choice nobody can make correctly, and the one to
   * remove is the one that only works in one state.
   */
  {
    id: 'trails-hiking',
    group: 'Routes',
    name: 'Hiking routes',
    description: 'Waymarked hiking and long-distance routes.',
    tiles: ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 18,
    opacity: 0.9,
    enabled: false,
    attribution: `${OSM_ATTRIBUTION}, routes by <a href="https://hiking.waymarkedtrails.org/">Waymarked Trails</a> (CC-BY-SA)`,
  },
  {
    id: 'trails-cycling',
    group: 'Routes',
    name: 'Cycling routes',
    description: 'Waymarked cycle route networks.',
    tiles: ['https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 18,
    opacity: 0.9,
    enabled: false,
    attribution: `${OSM_ATTRIBUTION}, routes by <a href="https://cycling.waymarkedtrails.org/">Waymarked Trails</a> (CC-BY-SA)`,
  },
  {
    id: 'hillshade',
    group: 'Terrain',
    name: 'Hillshade',
    /*
     * One relief layer, not two.
     *
     * There was also a USGS "Shaded relief". The two looked alike because they
     * are the same idea, and this is the better of them: Esri's is global and
     * assembled from the best elevation model available for each region —
     * down to lidar where there is lidar — while the USGS one is a single
     * national product at a coarser resolution and stops at the border.
     */
    description: 'Terrain relief, from the best elevation data available per region.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.35,
    enabled: false,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'places',
    group: 'Reference',
    name: 'Labels & boundaries',
    description: 'Place names and boundaries — good over bare imagery.',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 1,
    enabled: false,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'usgs-hydro',
    group: 'Terrain',
    name: 'Hydrography',
    description: 'Streams, rivers and water bodies (NHD).',
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.8,
    enabled: false,
    attribution: USGS_ATTRIBUTION,
  },
  /*
   * What the states publish about their own land, one entry each.
   *
   * These were found by asking every state in turn through
   * tools/check-layers.mjs and recorded in docs/state-layers.md. Only a
   * handful have had their fields read; the rest answered that they exist and
   * nothing more, which is why they ship switched off. A layer that draws
   * nothing is a layer to delete, and the probe list is what will say which.
   *
   * Every wrong answer during that sweep came from asking the wrong address,
   * never from a state that had nothing - so when one of these goes dead, look
   * for a moved URL before concluding the data is gone.
   */
  {
    legend: [{ color: '#6D4C41', label: 'Route: State trails' }],
    id: 'nc-trails',
    states: ['NC'],
    name: 'State trails',
    description: 'Trails the state park system maintains, with their names. Source: North Carolina State Parks',
    query: {
      url: 'https://services6.arcgis.com/nRIB86xC7kq6wavB/arcgis/rest/services/State_Trails/FeatureServer/1/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      road: true,
      color: '#6D4C41',
      label: 'TRAILNAME',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Trails © <a href="https://www.ncparks.gov/">North Carolina State Parks</a>',
  },
  {
    legend: [{ color: '#6D4C41', label: 'Route: Recreation routes' }],
    id: 'id-routes',
    states: ['ID'],
    name: 'Recreation routes',
    description: 'Motorised and non-motorised routes, with seasons of use. Source: Idaho Parks and Recreation',
    query: {
      url: 'https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Idaho_Recreation_Trails/FeatureServer/128/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      road: true,
      color: '#6D4C41',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Routes and closures © <a href="https://parksandrecreation.idaho.gov/">Idaho Parks and Recreation</a>',
  },
  {
    legend: [{ color: '#EF6C00', label: 'Area: Area restrictions' }],
    id: 'id-restrictions',
    states: ['ID'],
    name: 'Area restrictions',
    description: 'Where the state has closed or limited travel, and to what. Source: Idaho Parks and Recreation',
    query: {
      url: 'https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Idaho_Recreation_Trails/FeatureServer/123/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#EF6C00',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Routes and closures © <a href="https://parksandrecreation.idaho.gov/">Idaho Parks and Recreation</a>',
  },
  {
  /*
   * What asking Vermont for its layer list turned up beside the roads.
   *
   * The roads layer was already correct at index 10 - the table in
   * docs/state-layers.md said otherwise and the table was wrong, because the
   * health probe reads a MapServer's root and reports layer zero rather than
   * the sublayer actually drawn. Asking properly also produced primitive
   * camping areas, which is the thing this app most wants and almost nobody
   * publishes.
   */
    id: 'vt-camping',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-72.8, 44.2],
    states: ['VT'],
    name: 'Primitive camping areas',
    description: 'The sites the state designates for primitive camping. Source: Vermont ANR',
    tiles: ['https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASFPR_WM_NOCACHE/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:22'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Recreation data © <a href="https://anr.vermont.gov/">Vermont Agency of Natural Resources</a>',
  },
  {
    id: 'vt-trails',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-72.8, 44.2],
    states: ['VT'],
    name: 'Trails',
    description: 'Trails on Agency of Natural Resources land. Source: Vermont ANR',
    tiles: ['https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASFPR_WM_NOCACHE/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:3'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Recreation data © <a href="https://anr.vermont.gov/">Vermont Agency of Natural Resources</a>',
  },
  {
    id: 'vt-recreation',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-72.7, 44.4],
    states: ['VT'],
    name: 'Recreation sites',
    description: 'Recreation sites the Agency of Natural Resources runs. Source: Vermont ANR',
    tiles: ['https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASFPR_WM_NOCACHE/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:2'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Recreation data © <a href="https://anr.vermont.gov/">Vermont Agency of Natural Resources</a>',
  },
  {
    /*
     * The name rides along the line, which is the option asked for over a key.
     *
     * Tapping the raster reported Nada Tunnel Rd - the basemap road underneath,
     * because a picture has nothing under it to hit.
     *
     * The label is ROAD, which is the byway's own name: Cumberland Cultural
     * Heritage Highway, Great River Road, Cordell Hull. RT_DESCR was the first
     * guess and it holds a road description - NADA TUNNEL RD+FORESTRY RD -
     * which is the name of the pavement, not of the byway running over it.
     */
    legend: [{ color: '#8D6E63', label: 'Route: Scenic byways' }],
    id: 'ky-byways',
    states: ['KY'],
    name: 'Scenic byways',
    description: 'The routes Kentucky has designated scenic, end to end. Source: Kentucky DGI',
    query: {
      url: 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Scenic_Byways_WGS84WM/MapServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=ROAD%2CDESC_OF_ROUTE%2CRT_DESCR%2CMILES%2CCNTY_NAME%2COBJECTID&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=400&f=geojson',
      minzoom: 7,
      road: true,
      color: '#8D6E63',
      label: 'ROAD',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Recreation data © <a href="https://technology.ky.gov/gis/">Kentucky Division of Geographic Information</a>',
  },
  {
    /*
     * Twelve endpoints, one layer, coloured by who may travel it.
     *
     * Kentucky publishes its trails split by use - federal hiking, federal ATV,
     * KDFWR horse, state park, rails to trails - and as a raster each arrived
     * in the agency's colour and the agency's dash pattern, which is where the
     * mixture of dashed and solid lines came from. Merging the sublayers and
     * tagging each feature with its use turns that into a column, so six key
     * entries cover the lot instead of a list per trail.
     *
     * All of them dashed, because a path is dashed on every map that draws one
     * and a dash cannot be driven by a column anyway. The colour carries the
     * use; the width is narrower than a road, which is what a trail should be.
     *
     * Zoom floor of ten: twelve requests per pan is a real cost and not one to
     * pay while somebody is looking at half a state.
     */
    legend: [
      { color: '#2E7D32', label: 'Hiking' },
      { color: '#6D4C41', label: 'Horse' },
      { color: '#1565C0', label: 'Bicycle' },
      { color: '#B45309', label: 'ATV' },
      { color: '#8E24AA', label: 'Motorcycle' },
      { color: '#0097A7', label: 'Water' },
      { color: '#546E7A', label: 'Mixed use' },
    ],
    id: 'ky-trails',
    states: ['KY'],
    name: 'Recreational trails',
    description: 'Trails by permitted use: foot, horse, bicycle, ATV, motorcycle, water. Source: Kentucky DGI',
    query: {
      url: 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Recreational_Trails_WGS84WM/MapServer/{layer}/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0002&resultRecordCount=300&f=geojson',
      minzoom: 10,
      trail: true,
      color: '#546E7A',
      uses: [
        { layer: 0, use: 'Hiking' },
        { layer: 1, use: 'Hiking' },
        { layer: 11, use: 'Hiking' },
        { layer: 4, use: 'Horse' },
        { layer: 10, use: 'Horse' },
        { layer: 9, use: 'Bicycle' },
        { layer: 3, use: 'Bicycle' },
        { layer: 7, use: 'ATV' },
        { layer: 8, use: 'Motorcycle' },
        { layer: 5, use: 'Water' },
        { layer: 6, use: 'Mixed use' },
        { layer: 2, use: 'Mixed use' },
      ],
      fillBy: {
        field: 'use',
        colors: {
          Hiking: '#2E7D32',
          Horse: '#6D4C41',
          Bicycle: '#1565C0',
          ATV: '#B45309',
          Motorcycle: '#8E24AA',
          Water: '#0097A7',
          'Mixed use': '#546E7A',
        },
        fallback: '#546E7A',
      },
    },
    opacity: 0.7,
    enabled: false,
    attribution: 'Recreation data © <a href="https://technology.ky.gov/gis/">Kentucky Division of Geographic Information</a>',
  },
  {
    /*
     * Held as features rather than taken as a picture.
     *
     * As a raster this drew the agency's own palette, repeated its labels
     * across every tile, put a StoryMap point in the middle of each forest,
     * and answered a tap with whatever basemap road lay underneath. None of
     * that was fixable from outside. The service hands over polygons with a
     * NAME on each - Kentenia State Forest, and so on - so it draws one label
     * per forest and a tap reports the forest.
     */
    legend: [{ color: '#2E7D32', label: 'Area: State forests' }],
    id: 'ky-forests',
    states: ['KY'],
    name: 'State forests',
    description: 'The forest boundary, which is where the access and fire rules change. Source: Kentucky DGI',
    query: {
      url: 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_StateForests_WGS84WM/MapServer/1/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=NAME%2COBJECTID%2CACRES&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=400&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
      label: 'NAME',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Recreation data © <a href="https://technology.ky.gov/gis/">Kentucky Division of Geographic Information</a>',
  },
  {
    legend: [{ color: '#6D4C41', label: 'Route: Forest roads' }],
    id: 'mi-roads',
    states: ['MI'],
    name: 'Forest roads',
    description: 'State forest roads, with surface and condition. Source: Michigan DNR',
    query: {
      url: 'https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/DNR_ROADS/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      road: true,
      color: '#6D4C41',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Recreation data © <a href=\"https://www.michigan.gov/dnr\">Michigan DNR</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Site: State forest campgrounds' }],
    id: 'mi-campgrounds',
    states: ['MI'],
    name: 'State forest campgrounds',
    description: 'Campgrounds on state forest land. Source: Michigan DNR',
    query: {
      url: 'https://services3.arcgis.com/Jdnp1TjADvSDxMAX/ArcGIS/rest/services/dnrParksAndRecreation/FeatureServer/3/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      icon: 'campground',
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Recreation data © <a href=\"https://www.michigan.gov/dnr\">Michigan DNR</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: Wildlife management areas' }],
    id: 'tn-wma',
    states: ['TN'],
    name: 'Wildlife management areas',
    description: 'Land the wildlife agency manages — open to the public under its own seasons and rules. Source: Tennessee Wildlife Resources Agency',
    query: {
      url: 'https://tnmap.tn.gov/arcgis/rest/services/ENVIRONMENTAL/TWRA/MapServer/3/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=NAME%2CMANAGEMENT%2CCONAME%2CACRES%2CREGION&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=400&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
      label: 'NAME',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Wildlife management areas © <a href="https://www.tn.gov/twra">Tennessee Wildlife Resources Agency</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: TVA dispersed recreation' }],
    id: 'tva-dispersed',
    states: ['TN'],
    name: 'TVA dispersed recreation',
    description: 'TVA dispersed recreation areas, with restrictions. Source: Tennessee Valley Authority',
    query: {
      url: 'https://services.arcgis.com/w8auYAijfGK1Mydj/arcgis/rest/services/Dispersed_Recreation_Areas/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Dispersed recreation © <a href=\"https://www.tva.com/\">Tennessee Valley Authority</a>',
  },
  {
    id: 'pa-parks',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-77.8, 41.2],
    states: ['PA'],
    name: 'State parks & amenities',
    description: 'State park boundaries and amenities. Source: Pennsylvania DCNR',
    tiles: ['https://www.gis.dcnr.pa.gov/agsprod/rest/services/Parks/State_Parks/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:3,9'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Parks © <a href=\"https://www.dcnr.pa.gov/\">Pennsylvania DCNR</a>',
  },
  {
    id: 'vt-routes',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-72.8, 44.2],
    states: ['VT'],
    name: 'ANR travel routes',
    description: 'Forest and park access roads. Source: Vermont ANR',
    tiles: ['https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASFPR_WM_NOCACHE/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:10'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Travel routes © <a href=\"https://anr.vermont.gov/\">Vermont Agency of Natural Resources</a>',
  },
  {
    legend: [{ color: '#6D4C41', label: 'Route: Park & forest maintained roads' }],
    id: 'md-roads',
    states: ['MD'],
    name: 'Park & forest maintained roads',
    description: 'Roads maintained inside state parks and forests. Source: Maryland DNR',
    query: {
      url: 'https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/State_Park_Forest_Recreation_Maintained_Roads/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      road: true,
      color: '#6D4C41',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Roads © <a href=\"https://dnr.maryland.gov/\">Maryland DNR</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State parks' }],
    id: 'mt-parks',
    states: ['MT'],
    name: 'State parks',
    description: 'The park boundary, which is where the camping, fire and vehicle rules change. Source: Montana Fish, Wildlife and Parks',
    query: {
      url: 'https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/FWPLND_STATEPARKS/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://fwp.mt.gov/\">Montana Fish, Wildlife & Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: Wildlife management areas' }],
    id: 'tx-wma',
    states: ['TX'],
    name: 'Wildlife management areas',
    description: 'Land the wildlife agency manages — open to the public under its own seasons and rules. Source: Texas Parks and Wildlife',
    query: {
      url: 'https://services1.arcgis.com/1mtXwieMId59thmg/arcgis/rest/services/WMA_Boundaries_4PublicDistribution/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Wildlife management areas © <a href=\"https://tpwd.texas.gov/\">Texas Parks and Wildlife</a>',
  },
  {
    legend: [{ color: '#C62828', label: 'Site: State parks' }],
    id: 'wi-closures',
    states: ['WI'],
    name: 'State parks',
    description: 'The park boundary, which is where the camping, fire and vehicle rules change. Source: Wisconsin DNR',
    query: {
      url: 'https://services5.arcgis.com/Ul9AyFFeFTjf08DW/arcgis/rest/services/WI_Park_Closures_PUBLIC_VIEW/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#C62828',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Closures © <a href=\"https://dnr.wisconsin.gov/\">Wisconsin DNR</a>',
  },
  {
    /*
     * Coloured by the division that manages it, which is the distinction the
     * agency's own raster drew and we could not reach.
     *
     * Two of these strings are read from real records - Hocking Hills State
     * Park under Parks and Watercraft, Conkles Hollow State Nature Preserve
     * under Natural Areas and Preserves. Forestry and Wildlife are not: the
     * service's renderer names those divisions and the sample bbox held
     * neither, so they are written as the agency spells the other two and will
     * fall through to the default colour if that guess is wrong. A wrong guess
     * costs a shade here; it does not mislabel anything.
     *
     * Name_Label is the agency's own field, aliased "Field for labeling on
     * maps" - Hocking Hills SP, Conkles Hollow DNP - so the label is short by
     * their choice rather than truncated by ours.
     */
    legend: [
      { color: '#5E9E5A', label: 'Parks and Watercraft' },
      { color: '#3F7F6E', label: 'Natural Areas and Preserves' },
      { color: '#2F6B33', label: 'Forestry' },
      { color: '#9A7B3A', label: 'Wildlife' },
    ],
    id: 'oh-lands',
    states: ['OH'],
    name: 'ODNR lands',
    description: 'State land by managing division: parks, forestry, wildlife, nature preserves. Source: Ohio DNR',
    query: {
      url: 'https://gis.ohiodnr.gov/arcgis/rest/services/OIT_Services/ODNR_ODNR_Lands_External/MapServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=Name_Label%2CLANDS_NAME%2CDIV_CODE_desc%2CPROP_TYPE%2CCOUNTY&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=400&f=geojson',
      minzoom: 8,
      color: '#5E9E5A',
      label: 'Name_Label',
      fillBy: {
        field: 'DIV_CODE_desc',
        colors: {
          'Division of Parks and Watercraft': '#5E9E5A',
          'Division of Natural Areas and Preserves': '#3F7F6E',
          'Division of Forestry': '#2F6B33',
          'Division of Wildlife': '#9A7B3A',
        },
        fallback: '#7E8C6A',
      },
    },
    opacity: 0.5,
    enabled: false,
    attribution: 'Lands © <a href="https://ohiodnr.gov/">Ohio DNR</a>',
  },
  {
    id: 'ia-recreation',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-93.6, 42.0],
    states: ['IA'],
    name: 'Recreation lands',
    description: 'Public land the department manages for recreation. Source: Iowa DNR',
    tiles: ['https://programs.iowadnr.gov/geospatial/rest/services/Recreation/Recreation/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:11'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Recreation © <a href=\"https://www.iowadnr.gov/\">Iowa DNR</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State forests' }],
    id: 'fl-forests',
    states: ['FL'],
    name: 'State forests',
    description: 'The forest boundary, which is where the access and fire rules change. Source: Florida Forest Service',
    query: {
      url: 'https://services3.arcgis.com/XYg2eF8UuxZVuVmF/arcgis/rest/services/Florida_State_Forests/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'State forests © <a href=\"https://www.fdacs.gov/Divisions-Offices/Florida-Forest-Service\">Florida Forest Service</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: DEEP property' }],
    id: 'ct-deep',
    states: ['CT'],
    name: 'DEEP property',
    description: 'State forests, parks and wildlife areas. Source: Connecticut DEEP',
    query: {
      url: 'https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/Connecticut_DEEP_Property/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'DEEP property © <a href=\"https://portal.ct.gov/deep\">Connecticut DEEP</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: Protected & recreational open space' }],
    id: 'ma-openspace',
    states: ['MA'],
    name: 'Protected & recreational open space',
    description: 'Protected land whoever holds it — state, town, or land trust. Source: MassGIS',
    query: {
      url: 'https://gis.eea.mass.gov/server/rest/services/Protected_and_Recreational_OpenSpace_Polygons/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Open space © <a href=\"https://www.mass.gov/orgs/massgis-bureau-of-geographic-information\">MassGIS</a>',
  },
  {
    id: 'hi-trails',
    legendNote: 'Drawn by the agency, so the colours are theirs. Tap a feature to see what it is.',
    at: [-155.5, 19.6],
    states: ['HI'],
    name: 'Na Ala Hele trails',
    description: 'State trails and public access points. Source: Hawaii DLNR',
    tiles: ['https://geodata.hawaii.gov/arcgis/rest/services/Terrestrial/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'
      + '&layers=show:34'],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.85,
    enabled: false,
    attribution: 'Trails © <a href=\"https://hawaiitrails.hawaii.gov/\">Na Ala Hele</a>, Hawaii DLNR',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State park boundaries' }],
    id: 'de-parks',
    states: ['DE'],
    name: 'State park boundaries',
    description: 'The park boundary, which is where the camping, fire and vehicle rules change. Source: Delaware DNREC',
    query: {
      url: 'https://services2.arcgis.com/JSw5FPLGACZknOZv/arcgis/rest/services/State_Park_Boundaries_Consolidated/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://dnrec.delaware.gov/\">Delaware DNREC</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Site: CPW facilities' }],
    id: 'co-cpw',
    states: ['CO'],
    name: 'CPW facilities',
    description: 'Campgrounds, trailheads and other facilities on CPW land. Source: Colorado Parks and Wildlife',
    query: {
      url: 'https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      icon: 'ranger',
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Administered land © <a href=\"https://cpw.state.co.us/\">Colorado Parks and Wildlife</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State park management areas' }],
    id: 'ut-parks',
    states: ['UT'],
    name: 'State park management areas',
    description: 'The ground each park manages, which reaches wider than the signed entrance. Source: Utah State Parks',
    query: {
      url: 'https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_State_Park_Management_Areas/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://stateparks.utah.gov/\">Utah State Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: Wildlife management areas' }],
    id: 'ok-recreation',
    states: ['OK'],
    name: 'Wildlife management areas',
    description: 'Land the wildlife department manages — open to the public under its own seasons and rules. Source: Oklahoma Department of Wildlife Conservation',
    query: {
      url: 'https://services6.arcgis.com/RBtoEUQ2lmN0K3GY/arcgis/rest/services/OklahomaRecreationalAreas/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Recreation © <a href=\"https://www.travelok.com/state-parks\">Oklahoma Tourism and Recreation</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State parks' }],
    id: 'sc-parks',
    states: ['SC'],
    name: 'State parks',
    description: 'The park boundary, which is where the camping, fire and vehicle rules change. Source: South Carolina State Parks',
    query: {
      url: 'https://services.arcgis.com/uj05BKeH0fZwqTNZ/arcgis/rest/services/SC_State_Parks/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://southcarolinaparks.com/\">South Carolina State Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State forest' }],
    id: 'nd-forest',
    states: ['ND'],
    name: 'State forest',
    description: 'The forest boundary, which is where the access and fire rules change. Source: North Dakota GIS Hub',
    query: {
      url: 'https://services1.arcgis.com/GOcSXpzwBHyk2nog/arcgis/rest/services/NDGISHUB_State_Forest/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'State forest © <a href=\"https://www.gis.nd.gov/\">North Dakota GIS Hub</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State park boundaries' }],
    id: 'wy-parks',
    states: ['WY'],
    name: 'State park boundaries',
    description: 'The park boundary, which is where the camping, fire and vehicle rules change. Source: Wyoming State Parks',
    query: {
      url: 'https://services6.arcgis.com/cWzdqIyxbijuhPLw/arcgis/rest/services/StateParkBoundaries/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://wyoparks.wyo.gov/\">Wyoming State Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Site: State parks' }],
    id: 'sd-parks',
    states: ['SD'],
    name: 'State parks',
    description: 'Where each park is — points, not boundaries. Source: South Dakota Game, Fish and Parks',
    query: {
      url: 'https://services2.arcgis.com/1sM9tpOC8N7GGkbw/arcgis/rest/services/South_Dakota_State_Parks/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      icon: 'ranger',
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://gfp.sd.gov/\">South Dakota Game, Fish and Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State parks & WMAs' }],
    id: 'ms-parks',
    states: ['MS'],
    name: 'State parks & WMAs',
    description: 'State parks and wildlife management areas. Source: Mississippi Wildlife, Fisheries and Parks',
    query: {
      url: 'https://services3.arcgis.com/OYP7N6mAJJCyH6hd/arcgis/rest/services/Mississippi_State_Parks_and_WMAs/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks and WMAs © <a href=\"https://www.mdwfp.com/\">Mississippi Wildlife, Fisheries and Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: State parks' }],
    id: 'ar-parks',
    states: ['AR'],
    name: 'State parks',
    description: 'The park boundary, which is where the camping, fire and vehicle rules change. Source: Arkansas State Parks',
    query: {
      url: 'https://services5.arcgis.com/bPacKTm9cauMXVfn/arcgis/rest/services/Arkansas_State_Parks/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://www.arkansasstateparks.com/\">Arkansas State Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Area: Park areas' }],
    id: 'ne-parks',
    states: ['NE'],
    name: 'Park areas',
    description: 'State park and recreation areas. Source: Nebraska Game and Parks',
    query: {
      url: 'https://services5.arcgis.com/IOshH1zLrIieqrNk/arcgis/rest/services/Park_Areas/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Parks © <a href=\"https://outdoornebraska.gov/\">Nebraska Game and Parks</a>',
  },
  {
    legend: [{ color: '#2E7D32', label: 'Site: Bureau of Parks & Lands sites' }],
    id: 'me-bpl',
    states: ['ME'],
    name: 'Bureau of Parks & Lands sites',
    description: 'State parks and the public reserved lands, which are the wilder half. Source: Maine Bureau of Parks and Lands',
    query: {
      url: 'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/BPL_Properties_Points_for_MaineFoliage/FeatureServer/0/query'
        + '?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true'
        + '&outSR=4326&maxAllowableOffset=0.0005&resultRecordCount=600&f=geojson',
      minzoom: 7,
      icon: 'information',
      color: '#2E7D32',
    },
    opacity: 0.55,
    enabled: false,
    attribution: 'Public lands © <a href=\"https://www.maine.gov/dacf/parks/\">Maine Bureau of Parks and Lands</a>',
  },
];

/**
 * Services asked "who manages the land here" when a pin is selected.
 *
 * Tried in order; the first that returns a feature wins. Any ArcGIS
 * FeatureServer or MapServer layer works — append `/query` is added for you, so
 * give the URL down to the layer index (…/FeatureServer/0).
 *
 * None of these could be reached from the sandbox this was built in. If the
 * Details panel reports a service error, open the URL in a browser: agency GIS
 * endpoints move, and the fix is almost always a new URL here.
 */
export const LAND_LOOKUPS = [
  // Tried in order; the first that returns a feature at the point wins.
  //
  // These endpoints move between service versions, and when one does, ArcGIS
  // answers HTTP 200 with {"error":{"message":"Invalid URL"}} rather than a
  // 404 — which is why a stale path here looks like a broken feature rather
  // than a bad address. The panel now reports what every candidate said, so a
  // wrong URL names itself.
  //
  // To repair one: open the service root in a browser (drop the /query and the
  // parameters). A working layer shows its name and field list; a dead one
  // shows that same "Invalid URL". Then correct the entry below.
  //
  // PAD-US used to sit between these two and was removed rather than repaired.
  // PADUS4_0Fee answers "Invalid URL", the service has moved at least twice,
  // and a search of the publisher's organisation returns several hundred
  // kilobytes of unrelated layers without it. A fallback that never answers
  // costs a round trip on every click and tells the reader nothing.
  {
    /*
     * Layer 1, not 0.
     *
     * Layer 0 of this service is a group called IDENTIFY, and a group layer
     * answers every query with a 200 carrying "Invalid or missing input
     * parameters" - which is indistinguishable from a malformed request, and
     * was read as one for a long time. Layer 1 is the Surface Management
     * Agency itself and returns ADMIN_DEPT_CODE, ADMIN_AGENCY_CODE and
     * ADMIN_UNIT_NAME, which is what the panel below reads.
     *
     * Confirmed by probing 1, 2 and 3 with this exact request: only 1 answers.
     */
    name: 'BLM surface management',
    url: 'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer/1',
  },
  {
    name: 'USFS administrative forests',
    url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_BasicOwnership_01/MapServer/0',
  },
];

/** Colour ramp for tracks that carry no colour of their own. */
export const TRACK_COLORS = [
  '#c2410c', '#1d4ed8', '#15803d', '#a21caf', '#0f766e',
  '#b45309', '#4338ca', '#be123c', '#3f6212', '#0369a1',
];

export default {
  SITE, MAPBOX_TOKEN, SUPABASE_URL, SUPABASE_KEY, MAP_ENGINE, DEFAULT_VIEW, DEFAULT_UNITS,
  BASEMAPS, DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN, OVERLAYS, TRACK_COLORS, LAND_LOOKUPS,
  STATE_NAMES, STATE_GROUP,
};
