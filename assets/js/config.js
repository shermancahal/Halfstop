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
const NOAA_ATTRIBUTION = 'Forecast data © <a href="https://www.weather.gov/">NOAA / National Weather Service</a>';

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
const NOWCOAST = 'https://nowcoast.noaa.gov/geoserver';
const NWS_GEOSERVER = 'https://mapservices.weather.noaa.gov/geoserver';

const wmsTile = (endpoint, layer) => `${endpoint}?service=WMS&version=1.3.0&request=GetMap`
  + `&layers=${layer}&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}`
  + '&width=256&height=256&format=image/png&transparent=true';

// The service draws its own key. A continuous ramp has no list of colours to
// write out by hand, and a hand-written approximation of one is worse than
// none: it would be wrong the first time NOAA restyled a layer.
const wmsLegend = (endpoint, layer) => `${endpoint}?service=WMS&version=1.3.0`
  + `&request=GetLegendGraphic&layer=${layer}&format=image/png`;

const nowcoastLayer = (workspace, layer) => ({
  tiles: [wmsTile(`${NOWCOAST}/${workspace}/wms`, `${workspace}:${layer}`)],
  legendImage: wmsLegend(`${NOWCOAST}/${workspace}/wms`, `${workspace}:${layer}`),
});

const ndfdLayer = (layer) => ({
  tiles: [wmsTile(`${NWS_GEOSERVER}/ndfd/wms`, `ndfd:${layer}`)],
  legendImage: wmsLegend(`${NWS_GEOSERVER}/ndfd/wms`, `ndfd:${layer}`),
});
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
    description: 'OSM rendered for the outdoors — tracks and surfaces.',
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
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © OpenStreetMap',
  },
  {
    id: 'mapbox-satellite-streets',
    name: 'Mapbox Satellite Streets',
    group: 'Imagery',
    description: 'Mapbox imagery with road and place labels.',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    requiresToken: true,
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
export const DEFAULT_BASEMAP = 'byways-topo';
export const DEFAULT_BASEMAP_WITH_TOKEN = 'byways-topo';

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
    id: 'recreation',
    legend: [
      { color: '#1B5E20', label: 'BLM recreation site' },
      { color: '#4E342E', label: 'USGS: campground, trailhead, cabin or shelter' },
      { color: '#6D4C41', label: 'USGS: ranger station, visitor center or headquarters' },
      { color: '#8D6E63', label: 'USGS: historic site, monument or point of interest' },
    ],
    legendNote: 'Two services drawn together — BLM recreation sites and the USGS National Map '
      + 'structures layers. Each draws in its own agency symbology; if one is down the other '
      + 'still appears.',
    group: 'Land & access',
    name: 'Recreation sites',
    description: 'Campgrounds, trailheads, cabins, ranger stations and historic sites.',
    // Two agencies, one switch. Nobody planning a trip thinks "I want the BLM
    // campgrounds but not the Forest Service ones" — they want somewhere to
    // sleep. Each source is drawn as its own raster layer so they stack, and
    // one failing does not blank the other.
    sources: [
      {
        name: 'BLM',
        tiles: ['https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation_Site_Points/MapServer/export'
          + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image'],
      },
      {
        // The USGS structures sub-layers, read off the live service rather than
        // guessed. The first attempt at this used 16, 17 and 18 — which are
        // emergency services, so the map filled with fire and police stations.
        // The indices are listed here by name so the next person can see what
        // each number is instead of trusting the string.
        //
        //   24 Recreation            29 Picnic Areas
        //   25 Campgrounds           30 Headquarters
        //   26 Trailheads            31 Visitor / Information Centers
        //   27 Cabins                32 Ranger Stations
        //   28 Shelters              46 Historic Sites / Points of Interest
        //                            47 National Symbols / Monuments
        name: 'USGS National Map',
        tiles: ['https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer/export'
          + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true'
          + '&layers=show:24,25,26,27,28,29,30,31,32,46,47&f=image'],
        tileSize: 512,
      },
    ],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.95,
    enabled: false,
    attribution: 'Recreation sites © <a href="https://navigator.blm.gov/">BLM</a>, '
      + '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS</a>',
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
    id: 'usgs-transport',
    group: 'Routes',
    name: 'Roads & trails (USGS)',
    description: 'USGS transportation network, including forest routes.',
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
    name: 'Wildfire perimeters',
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
    // The MVUM's own categories. It is a legal document, not a trail map: the
    // distinction between "all vehicles" and "highway-legal only" is what makes
    // a road passable in a licensed truck but closed to a UTV.
    legend: [
      { color: '#2E7D32', label: 'Open to all vehicles' },
      { color: '#1565C0', label: 'Highway-legal vehicles only' },
      { color: '#F9A825', label: 'Open seasonally — check the dates' },
      { color: '#8E24AA', label: 'Width-restricted (50\" or less)' },
      { color: '#C62828', label: 'Closed to motor vehicles' },
    ],
    legendNote: 'Colors follow the Forest Service MVUM key. The MVUM is the legal '
      + 'authority for what is open — always check the current year\'s map before relying on it.',
    group: 'Land & access',
    name: 'Forest roads (MVUM)',
    description: 'Which Forest Service roads are legally open, and to what.',
    // Every tile here is a render request the Forest Service answers on demand
    // rather than a cached image, so the cost is per-tile and the wait is real.
    // Two things help: 512px tiles, which cover the same screen in a quarter of
    // the requests, and a minzoom, since a national view of forest roads is
    // both illegible and the most expensive thing you can ask this service for.
    tiles: ['https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer/export'
      + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image'],
    tileSize: 512,
    minzoom: 10,
    maxzoom: 16,
    opacity: 0.9,
    enabled: false,
    attribution: 'Motor Vehicle Use Maps © <a href="https://www.fs.usda.gov/">USDA Forest Service</a>',
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
    ...nowcoastLayer('ndfd_temperature', 'air_temperature'),
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
    ...nowcoastLayer('ndfd_precipitation', '12hr_precipitation_probability'),
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
  {
    name: 'BLM surface management',
    url: 'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer/0',
  },
  {
    name: 'PAD-US',
    url: 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/PADUS4_0Fee/FeatureServer/0',
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
};
