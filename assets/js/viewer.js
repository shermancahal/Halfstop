/**
 * Map viewer.
 *
 * Loads maps from the published catalogue (?m=slug,slug) or from files the user
 * drops in, renders them over a switchable basemap with independent overlays,
 * and reports distance/elevation statistics with an interactive profile.
 *
 * Written against the Mapbox GL JS API, which MapLibre GL also implements — see
 * lib/engine.js for why.
 */

import {
  SITE, BASEMAPS, DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN, OVERLAYS,
  DEFAULT_VIEW, DEFAULT_UNITS, TRACK_COLORS, STATE_NAMES, STATE_GROUP, PROTOMAPS_ARCHIVE,
  PROTOMAPS_MAXZOOM,
} from './config.js';
import {
  loadEngine, buildRasterStyle, hasMapboxToken, mapboxToken, overlayParts, overlayIdFromLayer, overlayRows,
  overlayLinks, styleFor, styleHasGlyphs, engineFor, schemaFor, sourceNoteFor,
} from './lib/engine.js';
import { loadCatalog, findMap } from './lib/catalog.js';
import { parseMapFile, linePositions } from './lib/parse.js';
import {
  boundsAreValid, cumulativeDistances, formatDistance, formatDuration, formatElevation,
  formatTemperature, geojsonBounds, mergeBounds, padBounds,
} from './lib/geo.js';
import { el, escapeHTML, createToaster, downloadText, saveBlob, initTheme, formatDate } from './lib/ui.js';
import { icons } from './lib/icons.js';
import {
  FolderStore, FOLDER_COLORS, readTrip, tripStanding, localDay,
} from './lib/folders.js';
import {
  PIN_ICONS, DEFAULT_PIN_ICON, pinIconGroups, pinIconSVG, pinImageId, registerPinImages, rasterizePinIcon,
} from './lib/pin-icons.js';
import { toGPX } from './lib/gpx-write.js';
import {
  TRIP_DEFAULTS, planTrip, optimiseOrder, spellHours,
} from './lib/trip-plan.js';
import {
  registerShieldImages, shieldRegistrationReport, shieldImageIds, stateDesign, rasterizeShieldById,
  shieldImageIdFor, loadShieldBlank, shieldImageId, hasShieldBlank,
} from './lib/route-shields.js';
import { shieldLayerUpdates, PALETTE, MAPBOX_SCHEMA, PROTOMAPS_SCHEMA } from './lib/byways-style.js';
import { PMTilesArchive } from './lib/pmtiles.js';
import { openTileStore } from './lib/pmtiles-store.js';
import { previewFor, swatchSVG, tileURL } from './lib/preview.js';
import { Account, isConfigured as accountsAvailable } from './lib/account.js';
import {
  formatDD, formatDMS, formatDDM, toUTM, distanceBearing, compassPoint, reverseGeocode, searchPlaces,
} from './lib/place.js';
import {
  sunTimes, sunPosition, moonTimes, moonPosition, moonIllumination,
  lightPhases, lightDirections, currentDirections, destinationPoint, milkyWayGround, milkyWayTrack,
  moonTrack, sunTrack, milkyWayNight, bestMilkyWayNights, nightQuality, galacticCentre,
} from './lib/sky.js';
import { activeAlerts, describeMotion, alertsToGeoJSON } from './lib/storms.js';
import {
  runtimeLayers, runtimeSources, IS_LINE, IS_POLY, IS_POINT,
  FOLDER_SOURCE, REGION_SOURCE, LIGHT_SOURCE, STORM_SOURCE, STORM_ARROW_IMAGE,
} from './lib/runtime-layers.js';
import {
  landManager, forecast, weatherClass, publicLand, elevation, skyCover,
  parseWMSLegend, arcgisLegendRows,
} from './lib/lookup.js';
import { registerNPSImages, npsIconSVG } from './lib/nps-icons.js';
import { kpNow, auroraChance, describeKp } from './lib/aurora.js';
import { lunarEclipses, describeEclipse, shadowGeometry } from './lib/eclipse.js';
import { describeSync } from './lib/sync.js';
import { registerServiceWorker, applyServiceWorkerUpdate } from './lib/pwa.js';
import { mayEdit } from './lib/editable.js';
import {
  OfflineStore, MAX_ZOOM as OFFLINE_MAX_ZOOM, TILE_BUDGET,
  mayCacheTiles, tileURLsFor, downloadTiles, clearTiles, tileKeysFor, downloadArchiveTiles,
  regionTileKeys,
  measureRegion, regionsToGeoJSON, formatBytes as formatTileBytes,
} from './lib/offline.js';
import {
  putPhoto, photoURL, deletePhoto, pruneUnreferenced, fetchLinkedPhoto, formatBytes, PHOTO_TYPES,
  listSnapshots, SNAPSHOT_SOURCE,
} from './lib/photos.js';

/* ------------------------------------------------------------------ state */

// Declared up here with the other module constants, not beside the function
// that uses it. `state` reads it while the module is still evaluating, and a
// `const` further down the file is in the temporal dead zone at that moment —
// which threw a ReferenceError that the storage try/catch swallowed, so the
// remembered sections silently came back empty on every load.
const DETAIL_SECTIONS_KEY = 'ab-maps-details-closed-v1';
const SKY_PANEL_KEY = 'ab-maps-sky-panel-v1';
const COORD_FORMATS_KEY = 'ab-maps-coord-formats-v1';

/**
 * The directory the page's own assets are served from.
 *
 * The site runs at the origin root locally and under /Map/ on GitHub Pages, and
 * a shield fetched from an absolute /assets path works in the first case and
 * 404s in the second. Derived from the document rather than configured, so it
 * cannot disagree with where the page actually is.
 */
function assetBase() {
  const path = globalThis.location?.pathname || '/';
  return path.endsWith('/') ? path : `${path.slice(0, path.lastIndexOf('/') + 1)}`;
}

/**
 * A remembered display preference.
 *
 * Units used to live only in the URL, which meant they reset every time you
 * opened the site fresh and travelled with every link you shared. Both are
 * wrong in opposite directions: the choice is about the reader, not the view.
 * So it is stored, and a URL that names one still wins for that visit.
 */
function readSetting(key, fallback) {
  try {
    return globalThis.localStorage?.getItem(`ab-maps-${key}`) || fallback;
  } catch {
    return fallback;
  }
}

function rememberSetting(key, value) {
  try {
    globalThis.localStorage?.setItem(`ab-maps-${key}`, value);
  } catch {
    // Storage refused; the preference lasts for this session only.
  }
}

/** Which sky panel was last left open. '' means none. */
function readSkyPanel() {
  try {
    return globalThis.localStorage?.getItem(SKY_PANEL_KEY) || '';
  } catch {
    return '';
  }
}

function rememberSkyPanel() {
  try {
    globalThis.localStorage?.setItem(SKY_PANEL_KEY, state.skyPanel || '');
  } catch {
    // Storage refused; the preference lasts for this session only.
  }
}

/**
 * Whether the extra coordinate formats were left showing.
 *
 * Anyone who needs UTM or degrees-and-minutes needs them on every pin, not
 * once — so the disclosure is a preference, not a per-pin state.
 */
function readCoordFormats() {
  try {
    return globalThis.localStorage?.getItem(COORD_FORMATS_KEY) === 'open';
  } catch {
    return false;
  }
}

function rememberCoordFormats(open) {
  try {
    globalThis.localStorage?.setItem(COORD_FORMATS_KEY, open ? 'open' : '');
  } catch {
    // Storage refused; the preference lasts for this session only.
  }
}

const state = {
  // Tapping the map asks what is there. The pin has its own button, because
  // inspecting is what you do repeatedly and dropping a pin is deliberate.
  probing: true,
  gl: null,
  map: null,
  engine: null,
  catalog: { maps: [] },
  /** key -> { key, name, doc, color, visible, origin, slug } */
  documents: new Map(),
  basemapId: DEFAULT_BASEMAP,
  overlays: new Map(OVERLAYS.map((o) => [o.id, { visible: !!o.enabled, opacity: o.opacity ?? 1 }])),
  units: readSetting('units', DEFAULT_UNITS),
  // Kept apart from distance on purpose. Plenty of people want miles and
  // Celsius, or kilometres and Fahrenheit; one switch for both would be
  // somebody else's idea of a pair.
  temperature: readSetting('temp', 'F'),
  scaleControl: null,
  shieldStateName: '',
  activeKey: null,
  colorCursor: 0,
  profile: null,
  folders: null,
  dragItem: null,
  /** `${folderId}:${itemId}` for pins ticked for bulk styling. */
  selection: new Set(),
  /** Tile health per configured layer id, so dead sources can be flagged. */
  layerHealth: new Map(),
  /** { folderId, itemIds } while the pin editor is open, so re-renders keep it. */
  openEditor: null,
  account: null,
  /** Typed email, kept across re-renders so an error does not clear the form. */
  accountEmail: '',
  /** { folderId, itemId } for the pin the Details tab is describing. */
  selectedPin: null,
  waypointQuery: '',
  /** Which page of the waypoint list is showing. Reset by search and filter. */
  waypointPage: 0,
  /** folderId -> how many of its items are currently revealed in the tree. */
  folderReveal: new Map(),
  waypointFolderFilter: '',
  /** Saved offline regions, defined here and downloaded by the mobile app. */
  offline: null,
  /** Region id whose outline is emphasised on the map, or ''. */
  highlightRegion: '',
  /** Overlay category headings the user has opened, so re-renders keep them. */
  openLayerGroups: new Set(),
  /** Which trips have their drive breakdown open, so a re-render keeps it. */
  openTripPlans: new Set(),
  /** Details sections the reader has collapsed, remembered across pins. */
  closedDetailSections: new Set(readClosedSections()),
  /** Set when the chosen basemap could not render as itself, and why. */
  basemapFallback: '',
  /** Which of the sky panels — twilight, moon, milkyway, lines — is open. */
  skyPanel: readSkyPanel(),
  /** Active NWS warnings for the selected pin, or null while unasked. */
  storms: null,
  /** Layer ids that answer clicks, so a map click can tell "empty" from "a pin". */
  interactiveLayers: new Set(),
  /** Set once the out-of-range glyph warning has been logged, to log it once. */
  warnedGlyphRange: false,
  /** Two-letter code for the state under the map centre, for route shields. */
  shieldState: '',
  /**
   * The state whose markers the shield layers are *currently drawing*.
   *
   * Deliberately not the same field as `shieldState`, which is only what the
   * geocoder last said. Knowing the state and having applied it are different
   * facts, and collapsing them into one is what made every marker generic: the
   * lookup answers in a couple of hundred milliseconds, the vector style takes
   * longer, so the first answer arrived before `road-shield` existed, was
   * recorded as done, and never retried.
   */
  shieldsDrawnFor: '',
  /** { key, position, directions } while sun/moon bearings are drawn, else null. */
  lightLines: null,
  /** The dropped-pin popup, so a second click replaces it rather than stacking. */
  dropPopup: null,
  /** [lon, lat] of a place being described that is not a saved pin. */
  scratchPoint: null,
  // Where the last "what is here" tap landed, so the map keeps a mark on the
  // spot the card is talking about.
  probeMark: null,
};

const dom = {};
let toast = () => {};

/* ------------------------------------------------------------------ helpers */

const basemapById = (id) => BASEMAPS.find((b) => b.id === id) || BASEMAPS[0];

/** With a token configured the Mapbox style is the better default; without one it is not selectable. */
function defaultBasemapId() {
  if (!hasMapboxToken()) return DEFAULT_BASEMAP;
  return BASEMAPS.some((b) => b.id === DEFAULT_BASEMAP_WITH_TOKEN) ? DEFAULT_BASEMAP_WITH_TOKEN : DEFAULT_BASEMAP;
}

/**
 * Whether the style is loaded enough to accept sources and layers.
 *
 * Every mutation below goes through this. A style that fails spec validation
 * never loads, and Mapbox GL answers every addSource/addLayer/getStyle call
 * after that with "Style is not done loading" — which surfaces to the user as
 * an unexplained failure when they drop a file in.
 */
function styleReady() {
  try {
    return Boolean(state.map && state.map.isStyleLoaded && state.map.isStyleLoaded());
  } catch {
    return false;
  }
}

/** Run now if the style is ready, otherwise once it next finishes loading. */
function whenStyleReady(run) {
  if (styleReady()) { run(); return; }
  const map = state.map;
  if (!map) return;

  // Waiting on 'style.load' is the obvious thing and it is wrong, because this
  // is most often called from inside a 'style.load' handler: isStyleLoaded()
  // stays false there until the new style's sources have loaded too, so the
  // work defers to an event that has already fired and will not fire again.
  //
  // Every layer this app owns went through here after a basemap switch, which
  // is why switching a basemap made saved pins, imported tracks and the region
  // outlines all disappear at once, silently, with the map itself fine.
  //
  // 'styledata' fires repeatedly while a style settles, so re-checking on each
  // one gets there; 'idle' is the backstop for a style that settles without
  // another styledata.
  let done = false;
  const attempt = () => {
    if (done || !styleReady()) return;
    done = true;
    map.off('styledata', attempt);
    map.off('idle', attempt);
    run();
  };

  map.on('styledata', attempt);
  map.on('idle', attempt);
}

/** Basemaps needing a Mapbox token are hidden entirely when none is configured. */
/*
 * The basemaps this visitor is offered.
 *
 * Two filters, and they answer different questions. `requiresToken` is about
 * whether the map can render at all; `audience` is about whether it belongs in
 * the list. The second is presentation - the token ships in the page either
 * way and the tileset is one fetch away - so this keeps a map out of a menu
 * rather than out of reach, which is all it claims to do.
 */
const availableBasemaps = () => BASEMAPS.filter((basemap) => {
  if (basemap.requiresToken && !hasMapboxToken()) return false;
  if (basemap.audience === 'editors') return mayEdit(state.account?.user);
  return true;
});

const sourceIdFor = (key) => `data-${key}`;
const layerIdsFor = (key) => [
  `${key}-fill`, `${key}-fill-line`, `${key}-line-casing`, `${key}-line`, `${key}-point-halo`, `${key}-point`,
];


const FOLDER_LAYERS = [
  'folders-line-casing', 'folders-line', 'folders-point-halo', 'folders-point', 'folders-point-icon',
];


function nextColor() {
  const color = TRACK_COLORS[state.colorCursor % TRACK_COLORS.length];
  state.colorCursor++;
  return color;
}

function uniqueKey(base) {
  const slug = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  let key = slug;
  let n = 2;
  while (state.documents.has(key)) key = `${slug}-${n++}`;
  return key;
}

/* ------------------------------------------------------------------ boot */

async function main() {
  cacheDom();
  document.title = SITE.name;
  applyBranding();
  toast = createToaster(dom.toasts);
  initTheme(document.getElementById('theme-toggle'));
  state.folders = new FolderStore();
  state.offline = new OfflineStore();
  state.offline.addEventListener('change', () => {
    renderOfflineTab();
    refreshRegionData();
  });
  state.account = new Account(state.folders);
  state.account.addEventListener('change', () => {
    renderAccount();
    /*
     * The basemap list depends on who is signed in, so it has to be rebuilt
     * when that changes - otherwise an editor signs in and the maps gated to
     * them appear only after a reload, which reads as the gate not working.
     */
    renderLayersTab();
  });

  state.folders.onChange((_store, folderId) => {
    // Push the folder that changed straight away; a full sync still runs on
    // sign-in and catches anything a failed push missed.
    if (folderId && state.account?.user) {
      const folder = state.folders.get(folderId);
      if (folder) state.account.pushFolder(folder);
    }
  });
  state.folders.onChange(() => {
    renderFoldersTab();
    renderWaypointsTab();
    renderDropTarget();
    refreshFolderData();
    if (state.folders.lastError) toast(state.folders.lastError, { tone: 'error', timeout: 10000 });
  });
  // On a phone the panel covers the map, so the map is what you should land on.
  // Desktop has room for both, so it stays open there.
  /*
   * Closed until asked for, and opening lands on Layers.
   *
   * It used to open on every wide screen and show Folders, so the first thing
   * anybody saw was an empty list of their own files rather than the map they
   * came for - and the map was narrower for it. The panel is a tool you reach
   * for; the map is the thing.
   */
  selectTab('layers');
  setPanelOpen(false);

  wirePanel();
  wireFolders();
  wireDropzone();
  wireAccountMenu();
  if (!state.folders.storage) {
    const note = document.getElementById('folder-storage-note');
    if (note) {
      note.textContent = 'This browser is not allowing site storage, so folders will be lost when you '
        + 'close the tab. Export anything you want to keep as GPX.';
    }
  }

  /*
   * The URL is read before the engine is loaded, because the basemap decides
   * which engine to load.
   *
   * Protomaps and Mapbox cannot be drawn by the same library — one needs
   * MapLibre's `addProtocol` to read a `.pmtiles` archive, the other is
   * Mapbox's data and reserved to Mapbox's renderer — so "which engine" is
   * downstream of "which map", and asking in the other order picks the engine
   * before there is anything to pick it for.
   */
  const initial = readURL();
  state.basemapId = initial.basemap || defaultBasemapId();

  const { gl, engine } = await loadEngine(basemapById(state.basemapId));
  state.gl = gl;
  state.engine = engine;
  if (initial.overlays) {
    for (const [id, entry] of state.overlays) entry.visible = initial.overlays.includes(id);
  }
  if (initial.units) state.units = initial.units;

  const basemap = basemapById(state.basemapId);
  const initialStyle = styleFor(basemap, activeOverlays());
  state.basemapFallback = initialStyle.fallback || '';
  state.map = new gl.Map({
    container: 'map',
    style: initialStyle.style,
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    hash: 'view',
    attributionControl: { compact: true },
    maxPitch: 75,
    /*
     * Needed to read the map back out as an image.
     *
     * WebGL is allowed to throw away the drawing buffer after each frame, and
     * by default it does — which makes `toDataURL` return a blank rectangle
     * rather than failing, so a snapshot feature built without this looks like
     * it works and saves nothing.
     *
     * It costs a little memory and, on some mobile GPUs, a little speed. Worth
     * it: a saved picture of the map is the one form of offline that needs no
     * tiles, no token and no network at all.
     */
    preserveDrawingBuffer: true,
  });

  state.map.addControl(new gl.NavigationControl({ visualizePitch: true }), 'top-right');
  state.scaleControl = new gl.ScaleControl({ unit: state.units === 'metric' ? 'metric' : 'imperial' });
  state.map.addControl(state.scaleControl, 'bottom-left');
  state.map.addControl(new gl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }), 'top-right');
  if (gl.FullscreenControl) state.map.addControl(new gl.FullscreenControl(), 'top-right');

  /*
   * Two of our own, in the same corner and under the rest.
   *
   * A real control rather than a floating div, so it stacks with the engine's
   * own group instead of having to be positioned against it — and so it moves
   * with them if the corner ever changes.
   */
  state.map.addControl({
    onAdd: () => {
      const group = el('div', { class: 'mapboxgl-ctrl mapboxgl-ctrl-group map-tools' });

      /*
       * Inspecting first, and on by default.
       *
       * Asking what a line is turns out to be the thing you do over and over —
       * every road you consider driving — while dropping a pin is deliberate
       * and occasional. So the tap does the frequent thing, the button stays
       * lit to say so, and the pin has its own control below.
       */
      const probe = el('button', {
        class: 'map-tool is-on', type: 'button',
        title: 'Tap the map to see what is there',
        'aria-label': 'Tap the map to see what is there',
        'aria-pressed': 'true',
        html: icons.search,
      });
      probe.addEventListener('click', () => armProbe(probe));
      group.append(probe);
      state.probeButton = probe;

      // Drops the pin at the middle of the screen rather than where a finger
      // landed. On a phone that is the useful half: you can pan the map under
      // the crosshair far more precisely than you can tap a spot.
      group.append(el('button', {
        class: 'map-tool', type: 'button',
        title: 'Drop a pin at the centre of the map',
        'aria-label': 'Drop a pin at the centre of the map',
        html: icons.pin,
        onclick: () => {
          const centre = state.map.getCenter();
          showDropPin([centre.lng, centre.lat]);
        },
      }));

      /*
       * The camera on the map, not three taps into a tab.
       *
       * It was in the offline panel, which is where you go to plan a download
       * - not where you are when the map in front of you is worth keeping.
       * Taking a picture is the one export that needs no account, no network
       * and no tiles, and on a phone in a canyon it is often the whole answer,
       * so it belongs where the map is.
       */
      group.append(el('button', {
        class: 'map-tool', type: 'button',
        title: 'Save this view as a picture',
        'aria-label': 'Save this view as a picture',
        html: icons.camera,
        onclick: saveMapImage,
      }));

      return group;
    },
    onRemove: () => {},
  }, 'top-right');

  state.map.on('sourcedata', (event) => {
    if (event.sourceId && event.isSourceLoaded) noteLayerHealth(event.sourceId, true);
  });

  state.map.on('error', (event) => {
    if (event?.sourceId) noteLayerHealth(event.sourceId, false);
    const message = event?.error?.message || '';
    // Individual tile 404s are noisy and self-correcting; everything else is
    // worth seeing, because a style-level failure is otherwise silent.
    if (/Failed to fetch|NetworkError|AbortError/i.test(message)) return;

    // "glyphs > 65535 not supported" means a label contains a character outside
    // the Basic Multilingual Plane, which the glyph pipeline cannot fetch. It
    // fires once per affected tile, it is not caused by anything the reader did
    // or can fix, and the only consequence is that one label does not draw. It
    // belongs in the console, not over the map.
    if (/glyphs > \d+ not supported/i.test(message)) {
      if (!state.warnedGlyphRange) {
        state.warnedGlyphRange = true;
        console.warn('[map] a label uses characters outside the fetchable glyph range; that label will not draw.');
      }
      return;
    }
    console.error('[map]', message || event);
    if (/401|403|unauthorized|forbidden|not authorized/i.test(message)) {
      toast(
        'Mapbox refused the request — the token is missing, expired, or restricted to other '
        + 'web addresses. Check the URL restrictions on the token in your Mapbox account.',
        { tone: 'error', timeout: 16000 },
      );
      return;
    }
    if (/style|glyph|sprite|token|access/i.test(message)) {
      toast(`Map style problem: ${message}`, { tone: 'error', timeout: 12000 });
    }
  });

  const started = await waitForStyle();
  if (!started) {
    // The panel, catalogue and folders are all still usable without a rendered
    // map, so carry on rather than leaving a half-initialised page.
    toast('The basemap did not load. Try another basemap under Layers.', { tone: 'error', timeout: 14000 });
  }

  addAppLayers();
  addFolderLayers();
  refreshFolderData();
  refreshRegionData();
  refreshLightLines();
  refreshStormData();
  wireMapClicks();
  exposeMap();
  exposeRoadInspector();
  exposeShieldInspector();
  exposeOverlayInspector();
  exposeWaypointInspector();
  keepMapSized();
  healMissingImages();
  keepAppLayersAlive();
  trackShieldState();
  trackQueryOverlays();
  trackSkyScale();
  // A Mapbox vector style starts without our overlays; the raster path bakes
  // them into the initial style. The exception is a queried overlay, which
  // cannot be baked into either — it has no tiles, only an answer that depends
  // on the view — so it is added here on both paths.
  for (const overlay of activeOverlays()) {
    if (initialStyle.vector || overlay.query) addOverlayLayer(overlay);
  }
  renderBuildStamp();
  checkForNewerBuild();
  registerServiceWorker({ onUpdate: offerNewerBuild });
  renderLayersTab();
  renderOfflineTab();
  renderFoldersTab();
  renderWaypointsTab();
  renderDropTarget();
  renderAccount();
  state.account.init().catch((error) => console.warn('[account]', error.message));
  // Photos whose pin was deleted linger in IndexedDB; clear them once per load
  // rather than at deletion time, where a shared photo could be lost.
  pruneUnreferenced(state.folders.referencedPhotoIds()).catch(() => {});

  // The catalogue is optional: the viewer still works as a drop-and-view tool.
  try {
    state.catalog = await loadCatalog();
  } catch (error) {
    console.warn('[catalog]', error.message);
  }
  renderMapsTab();

  if (initial.slugs.length) {
    await Promise.all(initial.slugs.map((slug) => loadFromCatalog(slug, { fit: false })));
    fitAll();
  } else {
    setStatus(false);
  }
  renderDetailsTab();
}

/**
 * Resolve once the map has loaded, or false if it never does.
 *
 * Awaiting 'load' unconditionally means a style that fails to load hangs the
 * rest of startup forever — no catalogue, no layer list, no explanation.
 */
function waitForStyle(timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      console.error(`[map] the style did not finish loading within ${timeoutMs}ms`);
      finish(false);
    }, timeoutMs);

    if (state.map.loaded && state.map.loaded()) { finish(true); return; }
    state.map.once('load', () => finish(true));
  });
}

/** Push the configured site identity into the shared page chrome. */
function applyBranding() {
  // Both copies, from the one source. The panel carries the name on screens too
  // narrow for the header to hold it, and a rename that reached only one of
  // them would leave the old name showing on exactly the devices where it is
  // the only place the name appears at all.
  for (const id of ['brand-name', 'panel-brand-name']) {
    const node = document.getElementById(id);
    if (node) node.textContent = SITE.name;
  }
  const parent = document.getElementById('brand-parent');
  if (parent && SITE.parent?.name) parent.textContent = SITE.parent.name;
}

function cacheDom() {
  dom.app = document.querySelector('.app');
  dom.panel = document.getElementById('panel');
  dom.tabs = [...document.querySelectorAll('.panel-tab')];
  dom.tabPanels = {
    layers: document.getElementById('tab-layers'),
    waypoints: document.getElementById('tab-waypoints'),
    folders: document.getElementById('tab-folders'),
    details: document.getElementById('tab-details'),
  };
  dom.basemapList = document.getElementById('basemap-list');
  dom.overlayList = document.getElementById('overlay-list');
  dom.catalogList = document.getElementById('catalog-list');
  dom.waypointList = document.getElementById('waypoint-list');
  dom.waypointSearch = document.getElementById('waypoint-search');
  dom.waypointFolder = document.getElementById('waypoint-folder');
  dom.waypointCount = document.getElementById('waypoint-count');
  dom.loadedList = document.getElementById('loaded-list');
  dom.loadedCount = document.getElementById('loaded-count');
  dom.details = document.getElementById('details-body');
  dom.dropzone = document.getElementById('dropzone');
  dom.fileInput = document.getElementById('file-input');
  dom.toasts = document.getElementById('toasts');
  dom.status = document.getElementById('map-status');
  dom.statusText = document.getElementById('map-status-text');
  dom.folderList = document.getElementById('folder-list');
  dom.offlineSaved = document.getElementById('offline-saved');
  dom.offlineSavedCount = document.getElementById('offline-saved-count');
  dom.folderTotals = document.getElementById('folder-totals');
  dom.newFolder = document.getElementById('new-folder');
  dom.newTrip = document.getElementById('new-trip');
  dom.importIntoFolder = document.getElementById('import-into-folder');
  dom.dropTarget = document.getElementById('drop-target');
  dom.importAsk = document.getElementById('import-ask');
  dom.account = document.getElementById('account-panel');
  dom.accountMenu = document.getElementById('account-menu');
  dom.accountTrigger = document.getElementById('account-trigger');
  dom.filesBlock = document.getElementById('files-block');
  dom.offline = document.getElementById('offline-panel');
  dom.offlineCount = document.getElementById('offline-count');
  dom.buildStamp = document.getElementById('build-stamp');
  dom.placeSearch = document.getElementById('place-search');
  dom.placeResults = document.getElementById('place-results');
}

/* ------------------------------------------------------------------ URL state */

function readURL() {
  const params = new URLSearchParams(location.search);
  return {
    slugs: (params.get('m') || '').split(',').map((s) => s.trim()).filter(Boolean),
    basemap: params.get('b'),
    overlays: params.has('o') ? (params.get('o') || '').split(',').filter(Boolean) : null,
    units: params.get('u') === 'metric' ? 'metric' : params.get('u') === 'imperial' ? 'imperial' : null,
  };
}

/** Keep the address bar shareable without adding history entries on every toggle. */
function writeURL() {
  const params = new URLSearchParams();
  const slugs = [...state.documents.values()].map((d) => d.slug).filter(Boolean);
  if (slugs.length) params.set('m', slugs.join(','));
  if (state.basemapId !== defaultBasemapId()) params.set('b', state.basemapId);

  const visibleOverlays = [...state.overlays].filter(([, v]) => v.visible).map(([id]) => id);
  const defaultOverlays = OVERLAYS.filter((o) => o.enabled).map((o) => o.id);
  if (visibleOverlays.join(',') !== defaultOverlays.join(',')) params.set('o', visibleOverlays.join(','));
  if (state.units !== DEFAULT_UNITS) params.set('u', state.units);

  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

/* ------------------------------------------------------------------ panel chrome */

function wirePanel() {
  for (const tab of dom.tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  document.getElementById('panel-toggle')?.addEventListener('click', () => {
    setPanelOpen(dom.panel.hidden);
  });
  document.getElementById('panel-close')?.addEventListener('click', () => setPanelOpen(false));

  // Escape closes the panel on phones, where it is a full-screen overlay.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.panel.hidden && isNarrow()) setPanelOpen(false);
  });
  wireSettingsMenu();
  /*
   * The floating Layers and Folders buttons are gone.
   *
   * They were a second way into two tabs that the panel's own tab strip
   * already offers, sitting in the corner of the map and taking a strip of it
   * for the privilege. One route to a thing is enough; the toggle opens the
   * panel and the tabs do the rest.
   */
  dom.waypointSearch?.addEventListener('input', (event) => {
    state.waypointQuery = event.target.value;
    state.waypointPage = 0;
    renderWaypointsTab();
  });
  dom.waypointFolder?.addEventListener('change', (event) => {
    state.waypointFolderFilter = event.target.value;
    state.waypointPage = 0;
    renderWaypointsTab();
  });
  document.getElementById('share-button')?.addEventListener('click', shareView);
  wireOfflineMenu();
  wirePlaceSearch();
  document.getElementById('fit-button')?.addEventListener('click', fitAll);
}

/**
 * Type a place, go there.
 *
 * The map could already answer "what is this" for somewhere you had found; it
 * had no answer at all for "take me to Hazard" short of pinching across three
 * states. Forward geocoding, biased to where the map is looking, because "Elk
 * Creek" matches a dozen places out west and the one you mean is the one on
 * the screen.
 *
 * Requests are debounced and the previous one is aborted rather than left to
 * land later: typing "camp" fires four searches and the third answering after
 * the fourth would show results for a query nobody is looking at any more.
 */
function wirePlaceSearch() {
  const input = dom.placeSearch;
  const results = dom.placeResults;
  if (!input || !results) return;

  let timer = 0;
  let inFlight = null;

  const close = () => { results.hidden = true; results.replaceChildren(); };

  const note = (text) => {
    results.replaceChildren(el('p', { class: 'map-search-note', text }));
    results.hidden = false;
  };

  /*
   * Your own places first, and without waiting for anyone.
   *
   * A saved waypoint is the thing most often being looked for — you named it,
   * you know it is there — and it is in memory, so it can answer in the time
   * it takes to type. The geocoder's results land underneath a moment later.
   * Tracks and routes are searched too: a folder full of them is exactly where
   * "where was that forest road" gets answered.
   */
  const savedMatches = (query) => {
    const needle = query.toLowerCase();
    const found = [];

    for (const folder of state.folders.list()) {
      if (folder.name.toLowerCase().includes(needle)) {
        const centre = folderCentre(folder);
        if (centre) {
          found.push({
            kind: 'Folder',
            name: folder.name,
            context: `${folder.items.length} saved`,
            center: centre.center,
            bbox: centre.bbox,
          });
        }
      }

      for (const item of folder.items) {
        const properties = item.feature.properties || {};
        const haystack = `${properties.name || ''} ${properties.description || ''}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        const centre = featureCentre(item.feature);
        if (!centre) continue;
        found.push({
          kind: properties.kind === 'waypoint' ? 'Waypoint' : 'Track',
          name: properties.name || 'Unnamed',
          context: folder.name,
          center: centre.center,
          bbox: centre.bbox,
          saved: { folderId: folder.id, itemId: item.id },
        });
      }
    }

    // Ten of your own would fill the list and push the geocoder off it.
    return found.slice(0, 5);
  };

  const run = async (query) => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    const centre = state.map?.getCenter?.();
    let answer;
    try {
      answer = await searchPlaces(query, {
        near: centre ? [centre.lng, centre.lat] : null,
        signal: controller.signal,
      });
    } catch {
      return;   // aborted; a newer query is already running
    }
    if (controller !== inFlight) return;

    const mine = savedMatches(query);
    if (!answer.ok && !mine.length) { note(answer.reason); return; }
    if (!answer.results.length && !mine.length) { note(`Nothing found for “${query}”.`); return; }

    show([...mine, ...answer.results]);
    // Said under the results rather than instead of them: your own places
    // still answered, and the reason the rest did not is worth one line.
    if (!answer.ok) results.append(el('p', { class: 'map-search-note', text: answer.reason }));
  };

  const show = (places) => {
    results.replaceChildren(...places.map((place) => el('button', {
      class: `map-search-result${place.saved || place.kind === 'Folder' ? ' is-mine' : ''}`,
      type: 'button',
      role: 'option',
      onclick: () => { close(); input.blur(); goToPlace(place); },
    }, [
      el('span', { class: 'map-search-kind', text: place.kind }),
      el('span', { class: 'map-search-name', text: place.name }),
      place.context ? el('span', { class: 'map-search-where', text: place.context }) : null,
    ])));
    results.hidden = false;
  };

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(timer);
    if (query.length < 2) { inFlight?.abort(); close(); return; }
    // Straight away, from memory. Holding your own waypoints back for a third
    // of a second so they can arrive alongside a network answer is a delay
    // paid for nothing.
    const mine = savedMatches(query);
    if (mine.length) show(mine);
    // Long enough that a typed word is one request rather than five, short
    // enough that the list feels like it is keeping up.
    timer = window.setTimeout(() => run(query), 320);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); input.blur(); }
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(timer);
      const first = results.querySelector('.map-search-result');
      if (first) first.click();
      else if (input.value.trim().length >= 2) run(input.value.trim());
    }
  });

  // Clicking the map, or anywhere else, puts the list away. Without this it
  // hangs over the map until the next keystroke.
  document.addEventListener('pointerdown', (event) => {
    if (!results.hidden && !event.target.closest('.map-search')) close();
  });
}

/**
 * Where one saved feature is, as a point and an extent.
 *
 * A waypoint is a point and has no extent worth fitting to; a track is a line
 * whose extent is the whole answer. Returning both lets one search row handle
 * either without the caller knowing which it got.
 */
function featureCentre(feature) {
  const bounds = geojsonBounds(feature);
  if (!boundsAreValid(bounds)) return null;

  if (feature.geometry?.type === 'Point') {
    return { center: feature.geometry.coordinates, bbox: null };
  }
  return {
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    bbox: bounds,
  };
}

/** The same for a whole folder, which is the extent of everything in it. */
function folderCentre(folder) {
  const bounds = geojsonBounds({
    type: 'FeatureCollection',
    features: folder.items.map((item) => item.feature),
  });
  if (!boundsAreValid(bounds)) return null;
  return {
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    bbox: bounds,
  };
}

/**
 * Fly to a search result and say what it is.
 *
 * Marked and named rather than silently centred: the map after a jump looks
 * like any other patch of ground, and "did it find the right Elk Creek" is the
 * first thing anybody wants to know. It reuses the identify card, because the
 * answer to "what is at this spot" should not look different depending on how
 * you got there.
 */
function goToPlace(place) {
  /*
   * A saved waypoint has a home already.
   *
   * Opening the identify card on top of it would describe the ground under a
   * pin the app knows everything about — its folder, its notes, its photos —
   * so a saved result hands off to the panel that holds those instead.
   */
  if (place.saved) {
    if (place.bbox) fitTo(place.bbox);
    else state.map.flyTo({ center: place.center, zoom: Math.max(state.map.getZoom() || 0, 14), duration: 900 });
    selectPin(place.saved.folderId, place.saved.itemId);
    return;
  }

  if (place.bbox && place.bbox.length === 4) {
    fitTo([place.bbox[0], place.bbox[1], place.bbox[2], place.bbox[3]]);
  } else {
    state.map.flyTo({ center: place.center, zoom: Math.max(state.map.getZoom() || 0, 12), duration: 900 });
  }

  setProbeMark(place.center);
  showIdentifyResults(place.center, [{
    source: place.kind,
    designation: place.name,
    named: Boolean(place.name),
    attributes: null,
    rows: place.context ? [['Where', place.context]] : [],
  }]);
}

const isNarrow = () => window.matchMedia('(max-width: 820px)').matches;

/**
 * Open or close the side panel.
 *
 * The floating map buttons live in the same corner the panel covers, so they
 * are hidden whenever it is open rather than left floating on top of it.
 */
function setPanelOpen(open) {
  dom.panel.hidden = !open;
  dom.app.classList.toggle('is-panel-open', open);
  document.getElementById('panel-toggle')?.setAttribute('aria-expanded', String(open));
}

function selectTab(name) {
  for (const tab of dom.tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    dom.tabPanels[tab.dataset.tab].hidden = !selected;
  }
}

/**
 * Show a tab and make sure the panel itself is open — on narrow screens the
 * panel is collapsed by default, so selecting a tab alone would appear to do
 * nothing. This is what the floating map buttons call.
 */
function openTab(name) {
  selectTab(name);
  if (dom.panel.hidden) setPanelOpen(true);
  dom.panel.querySelector(`.panel-tab[data-tab="${name}"]`)?.focus();
}

function setStatus(busy, text = 'Loading…') {
  if (!dom.status) return;
  dom.status.hidden = !busy;
  if (busy) dom.statusText.textContent = text;
}

/* ------------------------------------------------------------------ basemaps & overlays */

/**
 * Every source id that is "the basemap" to a reader.
 *
 * Built from the schemas rather than written out, so it cannot fall behind
 * them — which is exactly how 'protomaps' came to be missing.
 */
const BASEMAP_SOURCE_IDS = new Set(['basemap', ...[MAPBOX_SCHEMA, PROTOMAPS_SCHEMA]
  .flatMap((schema) => [schema.source, schema.reliefSource])
  .filter(Boolean)]);

/**
 * Track whether a tile source is actually serving tiles.
 *
 * Third-party tile endpoints move and retire without notice, and a dead one is
 * indistinguishable from a slow one until enough requests have failed. Counting
 * outcomes per source lets the layer picker say so instead of leaving the user
 * staring at an empty map wondering what they broke.
 */
function noteLayerHealth(sourceId, ok) {
  // 'basemap' is our raster source; the rest are the vector sources the Byways
  // style declares, under whichever schema built it. All of them are the
  // basemap as far as the user is concerned, and without this line a vector
  // basemap that is failing reports nothing at all — the map is simply empty.
  //
  // 'protomaps' was missing from this list for as long as the Protomaps path
  // existed, which is how an archive that answered nothing produced a map with
  // a background colour, no roads, and a layer picker that called the basemap
  // healthy. The list is now every source either schema names, so adding a
  // third foundation cannot repeat it.
  const isBasemapSource = BASEMAP_SOURCE_IDS.has(sourceId);
  const layerId = isBasemapSource ? state.basemapId : overlayIdFromLayer(sourceId);
  if (!layerId) return;

  const health = state.layerHealth.get(layerId) || { ok: 0, failed: 0 };
  if (ok) health.ok++; else health.failed++;
  state.layerHealth.set(layerId, health);

  // Only call it dead once several requests have failed with none succeeding.
  if (ok || health.failed !== 4 || health.ok !== 0) return;
  renderLayersTab();

  /*
   * And say it out loud when it is the basemap.
   *
   * The error handler drops "Failed to fetch" on the floor, correctly: a
   * single tile 404 is noisy and self-correcting. But a whole basemap
   * answering nothing is the same message repeated, and dropping it is how a
   * map that renders its background colour and nothing else arrives with an
   * empty console and no explanation anywhere.
   *
   * The threshold is what makes this safe to shout about: four failures with
   * no successes at all is not a slow network, it is a source that is not
   * answering. And the most common reason it is not answering is the one
   * reason a browser will never print — a cross-origin refusal, which the page
   * only ever sees as a fetch that failed.
   */
  if (!isBasemapSource) return;
  toast(
    `${basemapById(state.basemapId)?.name || 'The basemap'} is not returning any tiles. `
    + 'If it reads from a map archive, the host may be refusing cross-origin range requests. '
    + 'Try another basemap under Layers.',
    { tone: 'error', timeout: 16000 },
  );
}

function layerIsBroken(id) {
  const health = state.layerHealth.get(id);
  return Boolean(health && health.ok === 0 && health.failed >= 4);
}

/**
 * The overlays that apply where the map is looking.
 *
 * Most apply everywhere. A few are one state's own data — Kentucky publishes
 * aerial imagery of a quality no national service comes near, and it stops at
 * the state line. Fifty states' worth of those in one flat list would be
 * unusable, so an overlay can name the states it covers and the panel only
 * offers it inside them.
 *
 * Before the map has been placed, state layers are held back rather than shown
 * everywhere: a layer that draws nothing is worse than one that is not there.
 */
function inScopeOverlays() {
  return OVERLAYS.filter((overlay) => !overlay.states
    || (state.shieldState && overlay.states.includes(state.shieldState)));
}

function activeOverlays() {
  return inScopeOverlays()
    .filter((o) => state.overlays.get(o.id)?.visible)
    .map((o) => ({ ...o, opacity: state.overlays.get(o.id).opacity }));
}

/**
 * Add or drop the state layers as the map crosses a line.
 *
 * A switched-on layer keeps its setting while you are outside the state it
 * covers, so coming back turns it on again rather than making you find it
 * twice — but it comes off the map, because it has nothing to draw there.
 */
function syncStateOverlays() {
  if (!state.map || !styleReady()) return;

  for (const overlay of OVERLAYS) {
    if (!overlay.states) continue;
    const wanted = state.overlays.get(overlay.id)?.visible
      && state.shieldState && overlay.states.includes(state.shieldState);
    const present = Boolean(state.map.getLayer(overlayLayerIds(overlay)[0]));
    if (wanted && !present) addOverlayLayer(overlay);
    else if (!wanted && present) removeOverlayLayer(overlay.id);
  }
}

function renderLayersTab() {
  dom.basemapList.replaceChildren();

  /*
   * Say when the map on screen is not the map that was chosen.
   *
   * Without a Mapbox token Byways Topo cannot render — it is a vector style —
   * and falls back to a raster cycling map. That is a reasonable fallback and
   * an unreasonable thing to do quietly: the panel said Byways Topo, the screen
   * showed lavender motorways and no route shields, and the only way to find
   * out why was to ask.
   */
  if (state.basemapFallback) {
    dom.basemapList.append(el('div', { class: 'basemap-fallback' }, [
      el('span', { class: 'basemap-fallback-mark', text: '!' }),
      el('div', {}, [
        el('div', { text: state.basemapFallback }),
        el('div', {
          class: 'basemap-fallback-fix',
          text: 'Set MAPBOX_TOKEN in the deploy secrets to get the real one.',
        }),
      ]),
    ]));
  }

  // Group by name rather than by position, so config order cannot produce two
  // headings with the same label.
  const grouped = new Map();
  for (const basemap of availableBasemaps()) {
    if (!grouped.has(basemap.group)) grouped.set(basemap.group, []);
    grouped.get(basemap.group).push(basemap);
  }

  for (const [group, entries] of grouped) {
    dom.basemapList.append(el('div', { class: 'layer-group-label', text: group }));
    for (const basemap of entries) {
      const selected = basemap.id === state.basemapId;
      dom.basemapList.append(layerRow({
        entry: basemap,
        selected,
        preview: true,
        control: el('input', {
          type: 'radio', name: 'basemap', value: basemap.id, checked: selected,
          onchange: () => setBasemap(basemap.id),
        }),
      }));
    }
  }

  /*
   * Counted from what the list shows, not from everything that exists.
   *
   * A state's layers stay switched on when you pan out of that state - which
   * is the right behaviour, they come back when you return - but they are
   * neither drawn nor listed while you are elsewhere. Counting all of OVERLAYS
   * therefore reported "20 on" over a list showing one, and the twenty were
   * not on any map. `activeOverlays` is scoped the same way, so this now
   * counts exactly the layers that are actually drawn.
   */
  const activeCount = inScopeOverlays().filter((o) => state.overlays.get(o.id)?.visible).length;
  const counter = document.getElementById('overlay-count');
  if (counter) counter.textContent = activeCount ? `${activeCount} on` : '';

  dom.overlayList.replaceChildren();

  // Grouped and collapsed. Fourteen overlays in one flat list is a wall you
  // scroll past rather than read; five named categories is a thing you can
  // scan. A group opens automatically when something inside it is switched on,
  // so an active layer is never hidden behind a closed heading.
  const overlayGroups = new Map();
  for (const overlay of inScopeOverlays()) {
    /*
     * One heading for every state's data, with the state on each row.
     *
     * It used to be a heading per state — "Kentucky" — which reads well with
     * one state in the list and becomes fifty headings of two layers each as
     * more are added. The subject is "this state publishes its own imagery";
     * which state is a property of the layer, so that is where it goes.
     */
    const name = overlay.states ? STATE_GROUP : (overlay.group || 'Other');
    if (!overlayGroups.has(name)) overlayGroups.set(name, []);
    overlayGroups.get(name).push(overlay);
  }

  for (const [groupName, entries] of overlayGroups) {
    const activeInGroup = entries.filter((o) => state.overlays.get(o.id)?.visible).length;
    const group = el('details', {
      class: 'layer-group',
      open: activeInGroup > 0 || state.openLayerGroups.has(groupName),
      ontoggle: (event) => {
        if (event.target.open) state.openLayerGroups.add(groupName);
        else state.openLayerGroups.delete(groupName);
      },
    }, [
      el('summary', { class: 'layer-group-summary' }, [
        el('span', { text: groupName }),
        el('span', { class: 'count', text: activeInGroup ? `${activeInGroup} on` : '' }),
      ]),
    ]);
    // Rows go in a body rather than straight into the <details>, which also
    // holds the summary - a grid over the element itself would try to lay the
    // heading out as a cell.
    const body = el('div', { class: 'layer-group-body' });
    group.append(body);
    dom.overlayList.append(group);
    renderOverlayRows(body, entries);
  }
}

/** The switch, opacity slider and colour key for each overlay in one group. */
/**
 * What "opacity" means for a layer, which depends on what kind it is.
 *
 * `raster-opacity` on a fill layer is not a dimmer, it is a spec error — and
 * the slider is one control over both kinds since queried overlays arrived. The
 * fill sits well under the slider's value so the map stays readable through it,
 * and the outline well over, so a faint area still has a findable edge.
 */
function opacityPaint(type, value) {
  if (type === 'fill') return ['fill-opacity', value * 0.45];
  if (type === 'line') return ['line-opacity', Math.min(1, value + 0.25)];
  // A circle layer has no raster-opacity, and setting one is a spec error the
  // slider was committing on every point layer.
  if (type === 'circle') return ['circle-opacity', Math.min(1, value + 0.25)];
  if (type === 'symbol') return ['icon-opacity', Math.min(1, value + 0.25)];
  return ['raster-opacity', value];
}

function renderOverlayRows(container, entries) {
  for (const overlay of entries) {
    const entry = state.overlays.get(overlay.id);
    const opacityRow = el('div', { class: 'opacity-row', hidden: !entry.visible }, [
      el('input', {
        type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(entry.opacity * 100)),
        'aria-label': `${overlay.name} opacity`,
        oninput: (event) => {
          const value = Number(event.target.value) / 100;
          entry.opacity = value;
          event.target.nextElementSibling.value = `${Math.round(value * 100)}%`;
          for (const layerId of overlayLayerIds(overlay)) {
            const layer = state.map.getLayer(layerId);
            if (!layer) continue;
            const [property, amount] = opacityPaint(layer.type, value);
            state.map.setPaintProperty(layerId, property, amount);
          }
        },
      }),
      el('output', { text: `${Math.round(entry.opacity * 100)}%` }),
    ]);

    const item = layerRow({
        entry: overlay,
        selected: entry.visible,
        control: el('input', {
          type: 'checkbox', checked: entry.visible,
          onchange: (event) => {
            entry.visible = event.target.checked;
            opacityRow.hidden = !entry.visible;
            if (entry.visible) addOverlayLayer(overlay); else removeOverlayLayer(overlay.id);
            renderLayersTab();
            writeURL();
          },
        }),
    });
    item.append(opacityRow);
    container.append(item);
  }
}

/**
 * One row per symbol, not one per sublayer.
 *
 * Cabins and shelters are different USGS sublayers drawn with the same glyph,
 * so listing every entry would put the same picture in the key twice under two
 * names — which reads as a rendering fault rather than as a shared symbol.
 */
function dedupeByIcon(points) {
  const seen = new Map();
  for (const kind of points) {
    if (seen.has(kind.icon)) continue;
    seen.set(kind.icon, kind);
  }
  return [...seen.values()];
}

/** A colour key for a raster overlay whose colours mean something. */
function legendList(entries, note = '') {
  /*
   * One column, two, or three, by how many steps there are.
   *
   * A temperature ramp is twenty-odd steps. In a 320px panel that is a stripe
   * of text taller than the panel, which pushes every layer below it out of
   * reach. Two columns fixes the merely-long ones; the longest still want
   * three, and their labels are short enough to take it — a colour ramp is
   * numbered, so the widest cell is about four characters.
   *
   * Under the first threshold it stays in one column: two columns of three
   * reads as a mistake rather than as a layout.
   */
  const columns = entries.length >= WIDE_LEGEND_AT ? ' is-wide'
    : entries.length >= SPLIT_LEGEND_AT ? ' is-split' : '';
  const list = el('ul', { class: `legend${columns}` },
    entries.map((item) => el('li', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: `background:${item.color}` }),
      el('span', { text: item.label }),
    ])));
  if (!note) return list;

  const wrap = document.createDocumentFragment();
  wrap.append(list, el('p', { class: 'legend-note', text: note }));
  return wrap;
}

/**
 * The colour key an ArcGIS service draws for itself.
 *
 * Some services publish no legend graphic to fetch — the NOHRSC snow analysis
 * is one — but every ArcGIS map service will describe its key as JSON, each
 * class carrying its own swatch as base64. That is the real scale rather than
 * an approximation of it, which matters for a depth map: a shade of blue with
 * no number beside it says nothing at all.
 *
 * Failure is silent on purpose. A missing key is a layer with no key, not an
 * error worth putting in front of somebody who just opened a description.
 */
const SPLIT_LEGEND_AT = 9;
const WIDE_LEGEND_AT = 16;

/**
 * Fetch a GeoServer colormap and draw it as the same swatch list radar uses.
 *
 * Replaces a fetched PNG of the key. The picture was legible only after being
 * asked for at three times the size and allowed to scroll sideways, and it
 * still did not match the layer sitting above it in the same group. This is the
 * service's own colours and its own labels, drawn in the panel's own type.
 */
async function fillWMSLegend(host, url) {
  if (!host || !url) return;
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const entries = parseWMSLegend(await response.json());
    if (!entries.length) return;
    host.replaceChildren(legendList(entries));
  } catch {
    // A key that will not load leaves the layer's name and nothing else, which
    // is better than a broken image where the explanation should be.
  }
}

async function fillArcGISLegend(host, { url, layer } = {}) {
  if (!host || !url) return;
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const body = await response.json();
    // Which sublayers, and whether a row is named by its class or by the
    // sublayer it came from, is decided in lookup.js beside the other
    // service-response readers — and tested there.
    const classes = arcgisLegendRows(body, layer);
    if (!classes.length) return;

    host.replaceChildren(el('ul', { class: 'legend' }, classes.map((item) => el('li', { class: 'legend-item' }, [
      el('img', {
        class: 'legend-swatch is-image',
        src: `data:${item.contentType};base64,${item.imageData}`,
        alt: '',
      }),
      el('span', { text: item.label }),
    ]))));
  } catch {
    // No key. The description above it still says what the layer is.
  }
}

/**
 * Show which build is running, at the foot of the panel.
 *
 * "The changes did not appear" has been the single most expensive question in
 * this project, and every time it was ambiguous between three causes: the
 * deploy did not run, it ran somewhere the site is not served from, or the
 * browser is still holding old JavaScript. Printing the commit in the app makes
 * the third one answerable at a glance and the other two answerable by
 * comparison — no view-source, no deployed.txt, no guessing.
 *
 * Silently absent when there is no deployed.txt, which is the normal state for
 * a local checkout.
 */
function newerBuildButton() {
  return el('button', {
    class: 'build-newer', type: 'button',
    text: 'A newer build is available — reload',
    onclick: async () => {
      // Hand over to the waiting service worker first. Reloading without this
      // comes back controlled by the old worker, still serving the old cache,
      // and the button appears to do nothing.
      await applyServiceWorkerUpdate();
      // `true` forces a fetch past the cache in the engines that still honour
      // it, and is harmless in the ones that do not.
      globalThis.location.reload(true);
    },
  });
}

/** Show the reload prompt once, however the newer build was noticed. */
function offerNewerBuild() {
  if (!dom.buildStamp || document.querySelector('.build-newer')) return;
  dom.buildStamp.after(newerBuildButton());
  dom.buildStamp.hidden = false;
}

/**
 * Say so when the page is running code older than what is deployed.
 *
 * GitHub Pages serves HTML with a ten-minute cache and there is no way to set
 * headers on it, so for a window after every deploy a hard refresh still
 * returns the previous page — and because the asset URLs are content-hashed,
 * stale HTML pins the entire bundle. Twice in one afternoon that looked exactly
 * like a deploy that had not run, and both times it was answered by reading
 * deployed.txt by hand.
 *
 * `window.ABMAP_BUILD` comes from a cache-busted script, so a stale page holds
 * the old fingerprint; build.json is fetched with no store, so it holds the
 * current one. They disagree only when the page is behind. The service worker
 * reports the same thing by a different route, through `offerNewerBuild`.
 */
async function checkForNewerBuild() {
  const running = globalThis.ABMAP_BUILD;
  if (!running || !dom.buildStamp) return;

  try {
    const response = await fetch('build.json', { cache: 'no-store' });
    if (!response.ok) return;
    const { build } = await response.json();
    if (!build || build === running) return;

    offerNewerBuild();
  } catch {
    // Offline, or no build.json because this is a source checkout rather than
    // a built package. Neither is worth saying anything about.
  }
}

/*
 * Where the build line's clock is read.
 *
 * Fixed to Indiana rather than the reader's own zone, because the only
 * question this line answers is "is the thing I am looking at the thing that
 * was just published", and that is asked against the publisher's clock. A
 * phone in another timezone showing its own local time makes two numbers that
 * have to be reconciled before they mean anything.
 */
const BUILD_ZONE = 'America/Indiana/Indianapolis';

function buildTime(value) {
  // deployed.txt writes "2026-08-26 14:10:17Z"; build.json writes ISO. The
  // space form is not required to parse, and does not in every engine.
  const date = new Date(String(value || '').trim().replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: BUILD_ZONE,
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(date);
  } catch {
    // An engine without that zone in its database. Better the raw stamp than
    // an empty line.
    return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  }
}

async function renderBuildStamp() {
  if (!dom.buildStamp) return;

  const show = (id, when) => {
    const stamp = buildTime(when);
    const text = [id && `build ${id}`, stamp].filter(Boolean).join(' · ');
    if (!text) return false;
    dom.buildStamp.textContent = text;
    dom.buildStamp.hidden = false;
    return true;
  };

  try {
    const response = await fetch('deployed.txt', { cache: 'no-cache' });
    if (response.ok) {
      const fields = Object.fromEntries(
        (await response.text()).split('\n')
          .map((line) => line.split(':').map((part) => part.trim()))
          .filter((pair) => pair.length >= 2)
          .map(([key, ...rest]) => [key, rest.join(':').trim()]),
      );

      const commit = (fields.commit || '').slice(0, 7);
      if (commit || fields.built) {
        // Also in the console, so it can be read from a screenshot of the
        // console or copied into a bug report without hunting for it.
        console.info(`[build] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        dom.buildStamp.title = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
        if (show(commit, fields.built)) return;
      }
    }
  } catch {
    // Offline, or a build with no deployed.txt — which is every app build.
  }

  /*
   * The fallback the app always has. build.json is written by build-dist for
   * every build, so the line appears inside the Capacitor shell too, where
   * there is no deployed.txt and this used to render nothing at all.
   */
  try {
    const response = await fetch('build.json', { cache: 'no-store' });
    if (!response.ok) return;
    const { build, built } = await response.json();
    show(build, built);
  } catch {
    // A source checkout rather than a built package. Nothing to say.
  }
}

/**
 * Report what the road data actually contains, on demand.
 *
 * Exposed as `abmapRoadFields()` in the browser console. It exists because the
 * two worst mistakes in this project were both the same mistake: guessing what
 * a data source called something instead of looking. Agency field names were
 * guessed and matched nothing; USGS sub-layer indices were guessed and drew
 * fire stations.
 *
 * Route shields were the next thing that needed it, and the answer is in:
 * asking the Tilequery API what Mapbox puts on KY 677 returned
 * `shield=circle-white`, not the documented `us-state`. Mapbox names a shield
 * by the shape a state's marker resembles. Two rounds of guessing preceded
 * one round of asking.
 */
/**
 * Why the route markers look the way they do.
 *
 * `abmapShields()` in the browser console. "The shields are all generic" has
 * four distinct causes and they are invisible from each other: the state was
 * never resolved, the images for that state were never registered, the layer is
 * still asking for the previous state's image, or the design genuinely has no
 * blank and fell back to the drawing. This says which.
 */
function exposeShieldInspector() {
  globalThis.abmapShields = async () => {
    const centre = state.map?.getCenter?.();
    const place = centre ? await reverseGeocode([centre.lng, centre.lat]).catch((error) => ({ error })) : null;

    const design = stateDesign(state.shieldState);
    const wanted = [2, 3, 4].map((length) => shieldImageId(design, length));
    const layer = state.map?.getLayer?.('road-shield');
    const asking = JSON.stringify(layer?.layout?.['icon-image'] || null);

    return {
      state: state.shieldState || '(never resolved)',
      /*
       * The state the layers are actually drawing, as opposed to the one above
       * that the geocoder reported. These differing is the whole of the bug
       * that made every marker generic, and it was invisible until this line
       * existed: the state was right, the images were right, and the layers
       * were still asking for the design from before anything was known.
       */
      drawnFor: state.shieldsDrawnFor || '(never applied)',
      // What the registrar last managed, and what it could not. An empty
      // `trouble` with the right state and a layer still drawing nothing is a
      // different fault from a registration that threw.
      registration: shieldRegistrationReport(),
      // How much patience the self-healer has left. Zero with images still
      // missing is the state that used to be permanent.
      healing: (() => {
        const missing = shieldImageIds({ state: state.shieldState })
          .filter((id) => !state.map?.hasImage?.(id));
        return { stillMissing: missing.length, examples: missing.slice(0, 3) };
      })(),
      geocoder: place?.error ? `failed: ${place.error.message}` : place ? `ok, ${place.regionCode || 'no region'}` : 'no answer',
      design,
      hasBlank: hasShieldBlank(design, 2),
      imagesRegistered: wanted.filter((id) => state.map?.hasImage?.(id)),
      imagesMissing: wanted.filter((id) => !state.map?.hasImage?.(id)),
      // The design the layer is currently naming, which is the one thing that
      // decides what is drawn. If this says `state` while `design` says
      // `st-KY`, the update never reached the layer.
      layerAsksFor: asking.length > 240 ? `${asking.slice(0, 240)}…` : asking,
    };
  };
}

/**
 * Why an overlay is not on the screen.
 *
 * `abmapOverlays()` in the console. A switched-on overlay drawing nothing has
 * several causes that are indistinguishable from the outside: the layer was
 * never added, the source is empty because the view is below the layer's zoom
 * floor, the service answered with no features because there genuinely are
 * none there, or the request failed. This says which.
 */
function exposeOverlayInspector() {
  globalThis.abmapOverlays = () => {
    if (!styleReady()) return 'The map style is still loading — try again in a moment.';

    const zoom = Number((state.map.getZoom?.() ?? 0).toFixed(1));
    const rows = [];

    for (const overlay of OVERLAYS) {
      // `visible` is the field the rest of the app keys on; there is no `on`.
      const entry = state.overlays.get(overlay.id);
      if (!entry?.visible) continue;

      const ids = overlayLayerIds(overlay);
      const live = ids.filter((id) => state.map.getLayer(id));
      const source = state.map.getSource(ids[0]);
      const kind = overlay.query ? (overlay.query.points ? 'points' : 'shapes') : 'raster';

      rows.push({
        id: overlay.id,
        kind,
        layersOnMap: live.length ? live : 'none — the switch is on but nothing was added',
        minzoom: overlay.query?.minzoom ?? null,
        belowZoomFloor: overlay.query?.minzoom ? zoom < overlay.query.minzoom : false,
        features: source?._data?.features?.length
          ?? source?._d?.features?.length
          ?? (kind === 'raster' ? 'n/a — raster' : 'unknown'),
        lastFetch: lastPointFetch.get(overlay.id) || (kind === 'points' ? 'never ran' : 'n/a'),
      });
    }

    return {
      zoom,
      basemap: state.basemapId,
      switchedOn: rows.length ? rows : 'nothing is switched on',
    };
  };
}

/**
 * The map itself, on the console.
 *
 * The four inspectors below answer specific questions, and they were written
 * one at a time as those questions came up. The question that had no inspector
 * was the broadest one — "is anything drawing at all, and from where" — and it
 * is the one that matters when the map is empty, because at that point every
 * narrower inspector answers "no roads on screen" and none of them says why.
 *
 * Exposing the instance is also what lets tools/check-site.mjs read the live
 * site: the sources it declares, whether each one loaded, and what is actually
 * rendered. That check is the only thing in this repo that sees the whole
 * stack at the real origin, and it needs a handle on the map to do it.
 */
function exposeMap() {
  globalThis.abmapMap = state.map;
}

function exposeRoadInspector() {
  globalThis.abmapRoadFields = () => {
    if (!styleReady()) return 'The map style is still loading — try again in a moment.';

    const layers = state.map.getStyle().layers
      .filter((layer) => layer['source-layer'] === 'road')
      .map((layer) => layer.id)
      .filter((id) => state.map.getLayer(id));

    if (!layers.length) return 'No road layers in the current style — switch to Byways Topo.';

    const features = state.map.queryRenderedFeatures({ layers });
    const shields = new Map();
    for (const feature of features) {
      const props = feature.properties || {};
      if (!props.ref) continue;
      const key = props.shield || '(no shield field)';
      if (!shields.has(key)) shields.set(key, new Set());
      shields.get(key).add(`${props.ref} [${props.class}]`);
    }

    if (!shields.size) return 'No numbered roads on screen — pan to a highway and try again.';

    /*
     * Both halves of "why is there no shield here".
     *
     * A shield needs the data to carry `shield`/`ref`/`reflen` AND the image
     * the expression builds from them to be registered AND the symbol to
     * survive collision against every other label. Each half fails silently and
     * looks identical from the outside — a road with no marker on it — so
     * asking the map which one it is beats guessing, twice over now.
     */
    const shieldLayer = state.map.getLayer('road-shield');
    const wanted = new Map();
    for (const feature of features) {
      const props = feature.properties || {};
      if (!props.ref) continue;
      const id = shieldImageIdFor(props.shield, props.reflen, state.shieldState);
      wanted.set(id, (wanted.get(id) || 0) + 1);
    }

    const missing = [...wanted.keys()].filter((id) => !state.map.hasImage?.(id));
    const drawn = shieldLayer ? state.map.queryRenderedFeatures({ layers: ['road-shield'] }).length : 0;

    return {
      zoom: Number(state.map.getZoom().toFixed(1)),
      roadsOnScreen: features.length,
      shieldLayerPresent: !!shieldLayer,
      shieldsDrawn: drawn,
      imagesWanted: Object.fromEntries(wanted),
      imagesMissing: missing.length ? missing : 'none — every image the data asks for is registered',
      verdict: !shieldLayer ? 'No shield layer — switch to Byways Topo.'
        : missing.length ? 'Images are missing; the numbers will draw without markers.'
          : drawn ? 'Shields are being drawn.'
            : 'Images are fine and nothing is drawn — the symbols are losing collisions.',
      shieldValues: Object.fromEntries(
        [...shields].map(([shield, refs]) => [shield, [...refs].slice(0, 8)]),
      ),
      allFieldsOnOneRoad: features.find((f) => f.properties?.ref)?.properties || null,
    };
  };
}

/**
 * Keep the GL canvas the same size as its container.
 *
 * GL sizes its drawing buffer when the map is created and, depending on engine
 * version, may not notice the container changing afterwards. When it misses
 * one, the canvas keeps its old dimensions and the difference shows as a dead
 * band along an edge where the map simply stops — no error, and easy to read
 * as a CSS problem when it is not one.
 *
 * A ResizeObserver on the container catches every cause at once: the window,
 * the panel opening, browser chrome retracting on a phone, a font loading and
 * shifting the header.
 */
function keepMapSized() {
  const container = state.map.getContainer?.();
  const resize = () => { try { state.map.resize(); } catch { /* torn down */ } };

  if (container && typeof ResizeObserver === 'function') {
    new ResizeObserver(resize).observe(container);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  // One more after layout settles, for the case where the observer is not
  // available and the first frame was measured too early.
  setTimeout(resize, 250);
}

/**
 * Follow which state the map is over, and swap the route shields to match.
 *
 * State route markers differ per state — California's green spade, Utah's
 * beehive, Pennsylvania's keystone — but the road data does not reliably say
 * which state a road is in. Where the map is looking does, and a marker that
 * matches the state you are panning through is correct everywhere except within
 * a few miles of a border, which is a good trade for markers that are otherwise
 * all identical rectangles.
 *
 * Debounced, cached by the geocoder, and skipped entirely when the state has
 * not changed — so panning around one state costs nothing after the first
 * lookup.
 */
function trackShieldState() {
  let timer = null;

  state.map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(refreshShieldState, 600);
  });

  /*
   * A style load rebuilds every layer from `bywaysStyle`, which is built with
   * no state in it — so the markers come back generic even though the state is
   * known and its images are registered. Forgetting what was drawn is what
   * makes the next pass re-apply it.
   */
  state.map.on('style.load', () => {
    state.shieldsDrawnFor = '';
    applyShieldState();
  });

  /*
   * The one that guarantees convergence.
   *
   * Everything above is an attempt that can arrive too early — the geocoder
   * before the style, a style load before its layers. `idle` fires after every
   * render settles, so whatever the order was, the last word is a comparison of
   * two strings and, if they differ, one more attempt. It costs a string
   * compare per idle and it is the difference between markers that are right
   * and markers that are right if the timing happened to work out.
   */
  state.map.on('idle', () => {
    if (state.shieldsDrawnFor !== state.shieldState) applyShieldState();
    healShieldImages();
  });

  refreshShieldState();
}

/**
 * Put back any shield image that is missing, whatever took it.
 *
 * A shield whose image is absent does not vanish — GL drops the icon and keeps
 * the number, so the road ends up labelled with a bare "70" floating on it.
 * That has now been reported three times, and each round chased a different
 * cause: registration running before the style was up, a style swap discarding
 * every registered image, a blank that failed to load. All three are real and
 * all three are fixed, and the symptom came back anyway.
 *
 * So this stops asking why. Every settled frame, compare the images the current
 * state could ask for against the ones the map has, and re-register if any are
 * gone. It is a set difference over about fifteen strings — cheap enough to run
 * on every idle, and it converges no matter which of the causes is responsible
 * or whether it is one nobody has thought of yet.
 *
 * The counter is not a retry limit, it is a loop guard: if an image cannot be
 * created at all, re-registering it every frame forever would be a busy loop
 * that never fixes anything.
 */
let shieldHealAt = 0;
function healShieldImages(now = Date.now()) {
  if (!styleReady() || !state.map.getLayer('road-shield')) return;

  const wanted = shieldImageIds({ state: state.shieldState });
  const missing = wanted.filter((id) => !state.map.hasImage?.(id));
  if (!missing.length) return;

  /*
   * Rate-limited, never abandoned — and the difference matters.
   *
   * The first version of this counted settled frames where anything was
   * missing and gave up after twelve. Two thirds of these images are PNG sign
   * blanks fetched over the network, so for the first second after
   * registration they are all legitimately absent, and `idle` fires several
   * times a second: the budget was gone before the first blank landed, and the
   * healer was dead for the rest of the page's life. Whatever had registered
   * by then kept working until something was lost, which is precisely "it was
   * working for a while".
   *
   * Counting successes instead of failures would fix that case and still leave
   * the shape wrong. Any cap means a page that has been open long enough, or
   * unlucky enough, stops repairing itself — and this is the one thing on the
   * map with no other line of defence, because a missing image fails silently.
   *
   * What the cap was really protecting against is re-registering on every
   * frame, so that is what this limits. Once a second at most, forever.
   */
  if (now - shieldHealAt < HEAL_INTERVAL) return;
  shieldHealAt = now;

  console.warn(`[shields] ${missing.length} image(s) missing (${missing.slice(0, 3).join(', ')}) — re-registering.`);
  registerShieldImages(state.map, { state: state.shieldState, base: assetBase() });
}

const HEAL_INTERVAL = 1000;

/**
 * Point the shield layers at a state's markers.
 *
 * Idempotent and safe to call at any time: it reports whether it managed it,
 * and records success so the caller above knows not to keep trying. Returning
 * false is normal — it means the style is not up yet — and the `idle` listener
 * will come back.
 */
function applyShieldState(code = state.shieldState) {
  if (!styleReady() || !state.map.getLayer('road-shield')) return false;

  /*
   * Registering the images belongs here, behind the same guard as the layout.
   *
   * It used to run in the geocoder callback with no guard at all, which is the
   * same too-early problem the layout had and was fixed for — except that
   * `addImage` on a style that is not up throws, and the registrar swallowed
   * it. So the state resolved, the layer was pointed at that state's markers,
   * and the markers themselves were never added: the national shields drew
   * because they come from PNGs that arrive later and land after the style is
   * ready, and every drawn state marker was silently absent. "The shields do
   * not show on the state level", exactly.
   *
   * Idempotent — it skips any image the map already has — so the `idle` loop
   * that retries the layout now retries the images with it, and the two can no
   * longer end up in different states.
   */
  registerShieldImages(state.map, { state: code, base: assetBase() });

  try {
    // Every shield layer, not just the plain one. The two halves of a
    // concurrency carry a sideways shift the plain shield does not, so what to
    // set on each is decided in byways-style.js beside the layers themselves —
    // updating only 'road-shield' left the halves showing the previous state's
    // marker after a border crossing.
    for (const update of shieldLayerUpdates(code, { schema: schemaFor(basemapById(state.basemapId)) })) {
      if (!state.map.getLayer(update.id)) continue;
      for (const [property, value] of Object.entries(update.layout)) {
        state.map.setLayoutProperty(update.id, property, value);
      }
      for (const [property, value] of Object.entries(update.paint)) {
        state.map.setPaintProperty(update.id, property, value);
      }
    }
  } catch (error) {
    console.warn('[shields] could not update:', error.message);
    return false;
  }

  state.shieldsDrawnFor = code;
  return true;
}

/** One pass: where are we, and do the markers match it? */
async function refreshShieldState() {
  const centre = state.map.getCenter();
  const place = await reverseGeocode([centre.lng, centre.lat]).catch(() => null);
  const code = place?.regionCode || '';
  if (!code) return;

  /*
   * Knowing the state is not the same as having drawn it. The early return used
   * to be `code === state.shieldState`, which meant the first lookup consumed
   * the only chance to apply it: the answer came back before the vector style
   * had built `road-shield`, the layout update was skipped, and every later
   * pass returned here — leaving correctly registered state images that nothing
   * on the map ever asked for. Panning inside one state could never recover.
   */
  if (code === state.shieldState && state.shieldsDrawnFor === code) return;

  state.shieldState = code;
  state.shieldStateName = place?.regionName || '';

  /*
   * The shields first, and everything else after.
   *
   * The panel work below used to run before this, which meant anything it threw
   * took the shields with it — the images would be registered and the layers
   * would still be asking for the previous state's, so every marker on the map
   * stayed generic with nothing in the console to say why. The two have nothing
   * to do with each other and no longer share a failure.
   */
  applyShieldState(code);

  // The layer list carries a group for whichever state the map is over, and the
  // state's own layers come off the map at the line and back on inside it.
  // Separately fenced: a panel that will not draw is not a reason for the
  // markers on the map to be wrong.
  try {
    syncStateOverlays();
    renderLayersTab();
  } catch (error) {
    console.warn('[layers] could not follow the state:', error.message);
  }
}

/**
 * Re-ask the queried overlays once the map has settled.
 *
 * Debounced rather than per-frame: these are bounding-box queries against
 * somebody else's server, and a pan across three states should be one request
 * at the end of it rather than forty on the way.
 */
/**
 * Redraw the sky when the view changes scale.
 *
 * The drawing is sized to what is on screen, so zooming out without redrawing
 * leaves a ring a centimetre across in the middle of a state, and zooming in
 * leaves it off the edge. Only when the size has actually moved by a fifth,
 * because a pan at one zoom draws the identical picture in the same place and
 * recomputing a hundred sun and moon positions for it is work for nothing.
 */
function trackSkyScale() {
  let drawnAt = 0;
  let timer = null;

  state.map.on('moveend', () => {
    if (!state.lightLines) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const reach = skyReach();
      if (drawnAt && Math.abs(reach - drawnAt) / drawnAt < 0.2) return;
      drawnAt = reach;
      refreshLightLines();
    }, 200);
  });
}

function trackQueryOverlays() {
  let timer = null;
  // Which floors the view was above last time, so the panel is only rebuilt
  // when one is actually crossed rather than on every pan.
  let floorsMet = '';
  state.map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(refreshQueryOverlays, 700);

    const zoom = state.map.getZoom?.() ?? 0;
    const met = inScopeOverlays()
      .filter((entry) => entry.query?.minzoom)
      .map((entry) => `${entry.id}:${zoom >= entry.query.minzoom ? 1 : 0}`)
      .join(',');
    if (met !== floorsMet) {
      floorsMet = met;
      renderLayersTab();
    }
  });
}

/**
 * Report why saved waypoints are or are not on the map.
 *
 * `abmapWaypointStatus()` in the browser console. "Waypoints do not show" has
 * at least six distinct causes — nothing saved, the folder hidden, the data
 * never reaching the source, the layers missing after a style swap, the pin
 * images not registered, or the pins simply being off screen — and they look
 * identical from the outside. This separates them in one call rather than one
 * round trip each.
 */
function exposeWaypointInspector() {
  /*
   * What every trip folder thinks it is.
   *
   * "The trip did not stand down" has three distinct causes — the window is
   * not actually over, the app already stood it down once, or the folder was
   * switched back on by hand — and they look identical from the outside.
   */
  globalThis.abmapTrips = () => state.folders.list()
    .filter((folder) => folder.trip)
    .map((folder) => ({
      name: folder.name,
      from: folder.trip.from,
      to: folder.trip.to,
      retired: folder.trip.retired,
      visible: folder.visible,
      standing: tripStanding(folder.trip)?.state || null,
      items: folder.items.length,
    }));

  globalThis.abmapWaypointStatus = () => {
    const folders = state.folders.list();
    const saved = folders.reduce((sum, folder) => sum + folder.items.length, 0);
    const visible = folders.filter((folder) => folder.visible);

    const report = {
      foldersSaved: folders.length,
      waypointsSaved: saved,
      foldersVisible: visible.length,
      hiddenFolders: folders.filter((f) => !f.visible).map((f) => f.name),
      storageWorking: Boolean(state.folders.storage),
    };

    if (!styleReady()) return { ...report, map: 'the style is still loading' };

    const source = state.map.getSource(FOLDER_SOURCE);
    const data = state.folders.toGeoJSON({ visibleOnly: true });
    const layers = FOLDER_LAYERS.filter((id) => state.map.getLayer(id));
    const images = PIN_ICONS.filter((icon) => state.map.hasImage?.(pinImageId(icon.id))).length;

    // Off-screen is the most common answer and the least alarming one, so say
    // it plainly rather than leaving "everything looks fine" as the verdict.
    const bounds = state.map.getBounds();
    const inView = data.features.filter((feature) => {
      const [lon, lat] = feature.geometry?.coordinates || [];
      return Number.isFinite(lon) && lon >= bounds.getWest() && lon <= bounds.getEast()
        && lat >= bounds.getSouth() && lat <= bounds.getNorth();
    }).length;

    return {
      ...report,
      sourceExists: Boolean(source),
      featuresForTheMap: data.features.length,
      featuresInView: inView,
      layersPresent: `${layers.length} of ${FOLDER_LAYERS.length}`,
      missingLayers: FOLDER_LAYERS.filter((id) => !state.map.getLayer(id)),
      pinImagesRegistered: images,
      basemap: state.basemapId,
      verdict: saved === 0 ? 'nothing is saved yet'
        : !visible.length ? 'every folder is switched off in the Folders tab'
          : !source ? 'the map has no folder source — a style swap did not finish'
            : layers.length < FOLDER_LAYERS.length ? 'some pin layers are missing'
              : !images ? 'pin images are not registered'
                : inView === 0 ? 'they are saved and drawn, but none are in the current view'
                  : 'everything checks out — pins should be visible',
    };
  };
}

/**
 * Generate any icon the style asks for and cannot find.
 *
 * A symbol layer whose `icon-image` names an image the map does not have draws
 * the label and silently omits the icon — which is exactly what happened to the
 * route shields after switching basemaps and back: numbers with no shield
 * behind them, and nothing in the console. Registering images on style load is
 * correct but racy, because the style can ask for one before, or after, or
 * during that registration.
 *
 * This closes the race from the other end. GL tells us the id it wanted; we
 * make it and hand it over. Nothing the style can name is now unavailable.
 */
function healMissingImages() {
  state.map.on('styleimagemissing', (event) => {
    const id = event?.id;
    if (!id || state.map.hasImage?.(id)) return;

    try {
      // A state with a real sign blank is a PNG rather than a drawing, and
      // arrives asynchronously. GL re-renders when an image is added, so
      // answering late is fine.
      if (id.startsWith('abmap-shield-')) {
        loadShieldBlank(state.map, id, { base: assetBase() })
          .then((loaded) => {
            if (loaded || state.map.hasImage?.(id)) return;
            const drawn = rasterizeShieldById(id, { pixelRatio: 2 });
            if (drawn) state.map.addImage(id, drawn, { pixelRatio: 2 });
          })
          .catch(() => {});
        return;
      }

      let data = null;
      if (id.startsWith('pin-')) {
        data = rasterizePinIcon(id.slice('pin-'.length), { pixelRatio: 2 });
      } else if (id === STORM_ARROW_IMAGE) {
        data = rasterizeStormArrow({ pixelRatio: 2 });
      }

      if (data) {
        state.map.addImage(id, data, { pixelRatio: 2 });
        return;
      }
      // Worth one line: an id we cannot build means the style and this file
      // disagree about what exists, which is a bug rather than a hiccup.
      console.warn(`[map] the style asked for an image nothing can build: ${id}`);
    } catch (error) {
      console.warn(`[map] could not build image ${id}:`, error.message);
    }
  });
}

/**
 * Ask where freshly imported waypoints should go.
 *
 * The drop zone has always carried a destination picker, but it sits above the
 * button you just used and defaults to leaving everything loose on the map — so
 * the common path was importing a file, seeing the waypoints, and having
 * nothing saved. Pointing at the control in a toast does not help, because the
 * moment you care about the choice is after the import, not before it.
 *
 * Dismissing is a real answer: features stay loaded and visible either way, and
 * the file can be filed later from the drop zone.
 */
function askWhereToFile(entries, waypointCount) {
  if (!dom.importAsk || !entries.length) return;

  const close = () => { dom.importAsk.hidden = true; dom.importAsk.replaceChildren(); };
  const waypointsFrom = (entry) => entry.doc.geojson.features
    .filter((feature) => feature.properties.kind === 'waypoint')
    .map((feature) => ({ ...feature, properties: { ...feature.properties, sourceName: entry.name } }));

  const fileInto = (folderId) => {
    let added = 0;
    for (const entry of entries) {
      const result = state.folders.addFeatures(folderId, waypointsFrom(entry));
      added += result.added;
    }
    const folder = state.folders.get(folderId);
    toast(`Filed ${added} waypoint${added === 1 ? '' : 's'} into “${folder.name}”.`, { tone: 'ok' });
    close();
    openTab('folders');
  };

  const folders = state.folders.list();
  const names = entries.map((entry) => entry.name).join(', ');

  const select = folders.length
    ? el('select', { class: 'import-ask-select', 'aria-label': 'Folder to file into' },
      folders.map((folder) => el('option', { value: folder.id, text: folder.name })))
    : null;

  dom.importAsk.replaceChildren(el('div', { class: 'import-ask-card' }, [
    el('h2', { class: 'import-ask-title', text: `${waypointCount} waypoint${waypointCount === 1 ? '' : 's'} from ${names}` }),
    el('p', { class: 'import-ask-text', text: 'Where should these go? Tracks and routes stay on the map either way.' }),
    el('div', { class: 'import-ask-actions' }, [
      el('button', {
        class: 'button button-primary button-small', type: 'button',
        text: folders.length ? 'New folder' : 'Save to a new folder',
        onclick: () => {
          const name = window.prompt('Name the new folder', entries[0].name) ;
          if (name === null) return;
          fileInto(state.folders.create(name.trim() || entries[0].name).id);
        },
      }),
      select,
      select ? el('button', {
        class: 'button button-secondary button-small', type: 'button', text: 'Add to this folder',
        onclick: () => fileInto(select.value),
      }) : null,
      el('button', {
        class: 'button button-ghost button-small', type: 'button', text: 'Leave on the map',
        onclick: close,
      }),
    ]),
  ]));
  dom.importAsk.hidden = false;
}

/**
 * Put our layers back whenever the map has lost them.
 *
 * A backstop, not the mechanism. The mechanism is the rebuild in setBasemap,
 * and it has now been broken twice in ways that were invisible from the outside
 * — a deferral waiting on an event that had already fired, and a style diff
 * that silently skips the event entirely. Both had the same symptom: saved pins
 * gone, map fine, console clean.
 *
 * So this watches for the state that should be impossible — a loaded style with
 * no folder source — and repairs it. If the mechanism works, this never fires.
 * If it breaks again for a third reason, the user sees a redraw instead of an
 * empty map, and the console says it happened.
 */
function keepAppLayersAlive() {
  let repairing = false;

  const check = () => {
    if (repairing || !styleReady()) return;
    if (state.map.getSource(FOLDER_SOURCE)) return;

    repairing = true;
    console.warn('[map] the app layers went missing after a style change; rebuilding them.');
    try {
      addAppLayers();
      for (const entry of state.documents.values()) addDocumentLayers(entry);
      applyVisibility();
      addFolderLayers();
      refreshFolderData();
      refreshRegionData();
      refreshLightLines();
      registerShieldImages(state.map, { state: state.shieldState, base: assetBase() });
    } catch (error) {
      console.error('[map] rebuild failed:', error.message);
    } finally {
      repairing = false;
    }
  };

  state.map.on('styledata', check);
  state.map.on('idle', check);
}

/**
 * Units and display, behind one button.
 *
 * This was a single mi/ft toggle, which answered the one conversion question
 * somebody had thought of. Distance and temperature are different questions
 * with different answers — miles and Celsius is a perfectly ordinary pair — so
 * they are separate rows, and both are remembered.
 */
const SETTINGS = [
  {
    key: 'units',
    label: 'Distance and elevation',
    options: [
      { value: 'imperial', label: 'Miles / feet' },
      { value: 'metric', label: 'Kilometers / meters' },
    ],
  },
  {
    key: 'temperature',
    label: 'Temperature',
    options: [
      { value: 'F', label: 'Fahrenheit' },
      { value: 'C', label: 'Celsius' },
    ],
  },
];

function wireSettingsMenu() {
  const trigger = document.getElementById('settings-trigger');
  const drop = document.getElementById('settings-panel');
  const menu = document.getElementById('settings-menu');
  if (!trigger || !drop) return;

  const setOpen = (open) => {
    drop.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) paint();
  };

  const paint = () => {
    drop.replaceChildren(...SETTINGS.map((setting) => el('div', { class: 'settings-row' }, [
      el('div', { class: 'settings-label', text: setting.label }),
      el('div', { class: 'settings-choices' }, setting.options.map((option) => el('button', {
        class: `settings-choice${state[setting.key] === option.value ? ' is-on' : ''}`,
        type: 'button', text: option.label,
        onclick: () => {
          if (state[setting.key] === option.value) return;
          state[setting.key] = option.value;
          rememberSetting(setting.key === 'units' ? 'units' : 'temp', option.value);
          applyUnits();
          paint();
        },
      }))),
    ])));
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(drop.hidden);
  });
  document.addEventListener('click', (event) => {
    if (drop.hidden) return;
    if (!menu?.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drop.hidden) { setOpen(false); trigger.focus(); }
  });
  drop.addEventListener('click', (event) => event.stopPropagation());
}

/**
 * Everything about taking the map away with you, behind one control.
 *
 * It used to be three separate things: a download button in the header, a
 * camera beside it, and an "Offline regions" section at the foot of the Layers
 * tab — below eleven basemaps and five overlay groups, which is the same as
 * not being there. They answer one question and now live in one place.
 */
function wireOfflineMenu() {
  const trigger = document.getElementById('offline-trigger');
  const drop = document.getElementById('offline-panel');
  const menu = document.getElementById('offline-menu');
  if (!trigger || !drop) return;

  const setOpen = (open) => {
    drop.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    // Rendered on open rather than kept live: the region list is the only
    // thing in here that changes, and nobody is watching it while it is shut.
    if (open) renderOfflineTab();
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(drop.hidden);
  });
  document.addEventListener('click', (event) => {
    if (drop.hidden) return;
    if (!menu?.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drop.hidden) { setOpen(false); trigger.focus(); }
  });
  drop.addEventListener('click', (event) => event.stopPropagation());
}

/** Redraw everything that shows a number with a unit on it. */
function applyUnits() {
  // The scale bar is the map's own control and cannot be re-configured in
  // place, so it is replaced rather than told.
  if (state.scaleControl && state.map) {
    try {
      state.map.removeControl(state.scaleControl);
      state.scaleControl = new state.gl.ScaleControl({
        unit: state.units === 'metric' ? 'metric' : 'imperial',
      });
      state.map.addControl(state.scaleControl, 'bottom-left');
    } catch {
      // A control that will not come off is not worth failing a click over.
    }
  }
  renderMapsTab();
  renderDetailsTab();
  writeURL();
}

/**
 * The account menu in the header.
 *
 * Signing in is a thing you do twice and then forget about, so it does not
 * deserve a permanent section in a panel you are reading to find a waypoint.
 * A header button says whether you are signed in; clicking it drops the rest.
 */
function wireAccountMenu() {
  const trigger = dom.accountTrigger;
  const drop = dom.account;
  if (!trigger || !drop) return;

  const setOpen = (open) => {
    drop.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(drop.hidden);
  });

  // Click-away and Escape, because a dropdown that only closes by pressing the
  // button again is a dropdown people leave open.
  document.addEventListener('click', (event) => {
    if (drop.hidden) return;
    if (!dom.accountMenu?.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drop.hidden) { setOpen(false); trigger.focus(); }
  });
  drop.addEventListener('click', (event) => event.stopPropagation());
}

/* ---------------- collapsible detail sections ---------------- */

/**
 * Which detail sections the reader has folded away.
 *
 * The Details panel grew from a few coordinate rows into eight sections — pin,
 * coordinates, elevation, sun and moon, land, weather, notes, photos — and a
 * panel you scroll past is a panel you stop reading. Which of those matters is
 * personal and stable: a photographer wants sun and moon open every time, and
 * someone planning a drive never wants it. So the choice is remembered rather
 * than reset with each pin.
 *
 * Stored as the CLOSED set, so a section added later starts open and is
 * discovered rather than hidden.
 */
function readClosedSections() {
  try {
    const raw = globalThis.localStorage?.getItem(DETAIL_SECTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    // A browser refusing storage, or a corrupt value, is expected and survivable.
    // Anything else is a bug being hidden — which is exactly what happened when
    // this catch was bare, so it says so now.
    if (!(error instanceof SyntaxError) && error.name !== 'SecurityError') {
      console.warn('[details] could not read the remembered sections:', error.message);
    }
    return [];
  }
}

function rememberClosedSections() {
  try {
    globalThis.localStorage?.setItem(
      DETAIL_SECTIONS_KEY,
      JSON.stringify([...state.closedDetailSections]),
    );
  } catch {
    // Storage refused; the preference lasts for this session only.
  }
}

/**
 * Wrap a details-panel section so it can be folded away.
 *
 * `id` is what is remembered, so it has to be stable — not the pin's name.
 */
function collapsibleSection(id, title, buildBody, { count = '', icon = '' } = {}) {
  const open = !state.closedDetailSections.has(id);

  const section = el('details', {
    class: 'detail-block',
    open,
    // `<details open>` queues a toggle event when the attribute is set, and it
    // is dispatched after this listener is attached — so every open section
    // reports a "change" it never had, once per render. Those agree with what
    // we already believe, so ignoring them costs nothing and saves a storage
    // write per section per pin.
    ontoggle: (event) => {
      const nowClosed = !event.target.open;
      if (nowClosed === state.closedDetailSections.has(id)) return;
      if (nowClosed) state.closedDetailSections.add(id);
      else state.closedDetailSections.delete(id);
      rememberClosedSections();
    },
  }, [
    el('summary', { class: 'detail-block-summary' }, [
      // A panel of eight stacked headings reads as one wall of small capitals.
      // A mark per section gives the eye somewhere to land, and turns "where is
      // the weather" into a glance rather than a read.
      icon ? el('span', { class: 'detail-block-mark', html: icon }) : null,
      el('span', { text: title }),
      count ? el('span', { class: 'count', text: count }) : null,
    ]),
  ]);

  const body = el('div', { class: 'detail-block-body' });
  section.append(body);
  buildBody(body);
  return section;
}

/* ---------------- sun and moon ---------------- */

const clockTime = (date) => (date
  ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : '—');

/** "1h 47m", or "38m" when there is no hour to speak of. */
function formatSpan(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A moon drawn at the phase it is actually at.
 *
 * The terminator is an ellipse, not a straight edge — that is the whole
 * difference between a moon and a Pac-Man — so the lit part is a half disc
 * plus or minus an ellipse whose width tracks the illuminated fraction.
 */
function moonGlyph({ phase, fraction }) {
  const size = 34;
  const r = 15;
  const cx = 17;
  const cy = 17;

  // Which limb is lit: waxing moons are lit on the right in the northern sky.
  const waxing = phase < 0.5;
  const sweepOuter = waxing ? 1 : 0;
  // The terminator bows one way before quarter and the other way after.
  const bulge = Math.abs(2 * fraction - 1) * r;
  const sweepInner = (fraction > 0.5) === waxing ? 1 : 0;

  const lit = `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${sweepOuter} ${cx} ${cy + r} `
    + `A ${bulge.toFixed(2)} ${r} 0 0 ${sweepInner} ${cx} ${cy - r} Z`;

  return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--moon-dark)"/>
    <path d="${lit}" fill="var(--moon-lit)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--moon-edge)" stroke-width="1"/>
  </svg>`;
}

/**
 * Sun, moon and the light between them.
 *
 * This replaces a two-row sunrise/sunset table. The rows were true and nearly
 * useless: the times that decide a photograph are the ones either side of them
 * — when blue hour starts, how long golden hour lasts, whether the moon will be
 * up and how much of it will be lit.
 *
 * All of it is arithmetic on the device. It works with no signal, which is the
 * condition under which someone is standing on a ridge deciding whether to wait.
 */
function skySection(position) {
  const [lon, lat] = position;
  const date = new Date();
  const sun = sunTimes(date, lat, lon);
  const phases = lightPhases(date, lat, lon);

  let section = null;
  // No date beside the heading. Everything under it is about tonight, the bar
  // says so in times, and a date in the header only invited the question of
  // whether it could be changed — which it cannot.
  const outer = collapsibleSection('sky', 'Photography', (body) => { section = body; }, {
    icon: icons.camera,
  });

  if (sun.polar) {
    section.append(el('p', {
      class: 'hint', style: 'margin:0 0 10px',
      text: sun.polar === 'day'
        ? 'The sun does not set here today — midnight sun.'
        : 'The sun does not rise here today — polar night.',
    }));
  }

  section.append(dayBar(phases, date));
  section.append(lightHero(sun, phases, lat, lon));
  section.append(...skyPanels(position, date, phases));

  return outer;
}

/**
 * The day as a bar: night, twilight, golden, daylight, and back.
 */
function dayBar(phases, date) {
  if (!phases.length) return el('div');

  const first = phases[0].from.valueOf();
  const last = phases[phases.length - 1].to.valueOf();
  const total = last - first || 1;

  const bar = el('div', { class: 'sky-bar' }, phases.map((phase) => el('span', {
    class: `sky-band is-${phase.id.replace('-pm', '')}`,
    style: `flex:${((phase.to - phase.from) / total) * 100}`,
    title: `${phase.name} · ${clockTime(phase.from)}–${clockTime(phase.to)} · ${formatSpan(phase.minutes)}`,
  })));

  // Where we are in the day, so the bar reads as "now" rather than a diagram.
  const elapsed = (date.valueOf() - first) / total;
  if (elapsed >= 0 && elapsed <= 1) {
    bar.append(el('span', { class: 'sky-now', style: `left:${elapsed * 100}%` }));
  }

  return el('div', {}, [
    bar,
    el('div', { class: 'sky-bar-ends' }, [
      el('span', { text: clockTime(phases[0].from) }),
      el('span', { text: clockTime(phases[phases.length - 1].to) }),
    ]),
  ]);
}

/**
 * The four times worth setting an alarm for, on two lines over a sky wash.
 *
 * The wash is the same device the weather card uses, and for the same reason:
 * the panel should read before the text does. Here it runs dawn-warm on the
 * left to dusk-blue on the right, so the two halves are the two ends of the
 * day without needing to be labelled as such.
 */
function lightHero(sun, phases, lat, lon) {
  const bearing = (when) => (when ? `${Math.round(sunPosition(when, lat, lon).azimuth)}°` : '');
  const golden = phases.filter((phase) => phase.id.startsWith('golden'));
  const blue = phases.filter((phase) => phase.id.startsWith('blue'));
  const evening = (list) => (list.length ? list[list.length - 1] : null);

  const goldenPM = evening(golden);
  const bluePM = evening(blue);

  const half = (kind, glyph, label, time, note) => el('div', { class: `light-half is-${kind}` }, [
    el('span', { class: 'light-glyph', html: glyph }),
    el('div', { class: 'light-text' }, [
      el('div', { class: 'light-label', text: label }),
      el('div', { class: 'light-time', text: time }),
      note ? el('div', { class: 'light-note', text: note }) : null,
    ]),
  ]);

  return el('div', { class: 'light-hero' }, [
    el('div', { class: 'light-row' }, [
      half('rise', sunGlyph('rise'), 'Sunrise', clockTime(sun.sunrise), bearing(sun.sunrise)),
      half('set', sunGlyph('set'), 'Sunset', clockTime(sun.sunset), bearing(sun.sunset)),
    ]),
    el('div', { class: 'light-row is-secondary' }, [
      half('golden', sunGlyph('golden'), 'Golden hour',
        goldenPM ? formatSpan(goldenPM.minutes) : '—',
        goldenPM ? `${clockTime(goldenPM.from)}–${clockTime(goldenPM.to)}` : ''),
      half('blue', sunGlyph('blue'), 'Blue hour',
        bluePM ? formatSpan(bluePM.minutes) : '—',
        bluePM ? `${clockTime(bluePM.from)}–${clockTime(bluePM.to)}` : ''),
    ]),
  ]);
}

/** Small sun/horizon marks for the hero. Drawn, not typed — no glyph coverage. */
function sunGlyph(kind) {
  const disc = kind === 'blue' ? '#5b82b5' : kind === 'golden' ? '#f0a500' : '#f5b942';
  const rays = kind === 'rise' || kind === 'set';
  const spokes = rays
    ? [0, 45, 90, 135, 180, 225, 270, 315]
      .map((angle) => {
        const rad = angle * Math.PI / 180;
        const x1 = 12 + Math.cos(rad) * 7.5;
        const y1 = 12 + Math.sin(rad) * 7.5;
        const x2 = 12 + Math.cos(rad) * 10.5;
        const y2 = 12 + Math.sin(rad) * 10.5;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
                 stroke="${disc}" stroke-width="1.6" stroke-linecap="round"/>`;
      }).join('')
    : '';

  const horizon = kind === 'rise' || kind === 'set'
    ? '<line x1="1" y1="17" x2="23" y2="17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>'
    : '';
  const arrow = kind === 'rise'
    ? '<path d="M12 22.5 L12 19 M10 20.6 L12 18.6 L14 20.6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    : kind === 'set'
      ? '<path d="M12 18.6 L12 22.2 M10 20.4 L12 22.4 L14 20.4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      : '';

  return `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    ${spokes}
    <circle cx="12" cy="12" r="${rays ? 5.4 : 6.4}" fill="${disc}"/>
    ${horizon}${arrow}
  </svg>`;
}

/* ---------------- the four sky panels ---------------- */

/**
 * Twilight, moon, Milky Way and map lines, each behind its own button.
 *
 * These used to be a text dropdown, an always-open card and a lone button
 * respectively — three different affordances for four things that are all
 * "more detail about the sky here". One row of buttons, one box below, and
 * which box you had open is remembered, because a photographer who cares about
 * the moon cares about it at every pin.
 */
function skyPanels(position, date, phases) {
  const [lon, lat] = position;
  const open = state.skyPanel;

  /*
   * An icon on each, because the row is now six wide.
   *
   * Four text labels fitted a 320px panel; six wrap, and a wrapped tab strip
   * reads as two rows of unrelated buttons. The glyph carries the recognition
   * and lets the words shrink — and each is the shape that thing is drawn as
   * everywhere else: a sun for the light phases, a moon, the band for the
   * Milky Way, an arch for the aurora, a shadowed disc for an eclipse, a pin
   * for the one that puts all of them on the map at once.
   */
  const tabs = [
    { id: 'twilight', label: 'Light', icon: icons.sun },
    { id: 'moon', label: `Moon ${Math.round(moonIllumination(date).fraction * 100)}%`, icon: icons.moon },
    { id: 'milkyway', label: 'Milky Way', icon: icons.galaxy },
    { id: 'aurora', label: 'Aurora', icon: icons.aurora },
    { id: 'eclipse', label: 'Eclipse', icon: icons.eclipse },
    /*
     * The one tab that is a switch rather than a page.
     *
     * It used to be "On the map", which stopped telling the tabs apart once
     * every one of them drew on the map. And it used to open a panel with a
     * button in it that did the obvious thing — two presses to reach the only
     * thing the tab is for. Opening it draws; closing it stops.
     */
    { id: 'lines', label: 'Draw', icon: icons.pin, draws: 'sky' },
  ];

  const row = el('div', { class: 'sky-tabs' }, tabs.map((tab) => el('button', {
    class: `sky-tab${open === tab.id ? ' is-open' : ''}`,
    type: 'button',
    'aria-expanded': open === tab.id ? 'true' : 'false',
    // The label stays in the markup rather than becoming a title, so the tabs
    // are still readable to a screen reader and still findable by their words.
    html: `<span class="sky-tab-icon">${tab.icon}</span><span class="sky-tab-text">${tab.label}</span>`,
    onclick: () => {
      const opening = open !== tab.id;
      state.skyPanel = opening ? tab.id : '';
      rememberSkyPanel();
      /*
       * A tab that draws does it on the way in and undoes it on the way out —
       * including when the way out is another tab, which owns the map next.
       *
       * `toggleLightLines` is a toggle, so it is only called when it would
       * change something: called on a re-render it would switch the drawing
       * back off under a panel still saying it is on.
       */
      if (tab.draws) setSkyDrawing(position, date, tab.draws, opening);
      else if (tabs.find((entry) => entry.id === open)?.draws) {
        setSkyDrawing(position, date, 'sky', false);
      }
      renderDetailsTab();
    },
  })));

  const body = el('div', { class: 'sky-panel' });
  if (open === 'twilight') twilightPanel(body, position, phases, date);
  else if (open === 'moon') moonPanel(body, position, date);
  else if (open === 'milkyway') milkyWayPanel(body, position, date);
  else if (open === 'aurora') auroraPanel(body, [lon, lat]);
  else if (open === 'eclipse') eclipsePanel(body, position, date);
  else if (open === 'lines') linesPanel(body, position, date);

  return open ? [row, body] : [row];
}

/**
 * The next few lunar eclipses, and whether this spot will see them.
 *
 * The times are the same everywhere — a lunar eclipse is the moon crossing one
 * shadow, so the whole planet watching it is watching the same instant. What
 * differs from place to place is only whether the moon is above the horizon,
 * which is the line that turns a date in a table into a reason to drive
 * somewhere.
 */
const longDate = (when) => when.toLocaleDateString(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});

function eclipsePanel(body, position, date) {
  const [lon, lat] = position;
  const eclipses = lunarEclipses(date, { count: 4 });
  if (!eclipses.length) {
    body.append(el('p', { class: 'hint', text: 'No lunar eclipse in the next dozen years, which cannot be right — please report this.' }));
    return;
  }

  const [next, ...later] = eclipses;
  const visible = eclipseVisibility(next, lat, lon);
  const covered = Math.round(Math.max(0, next.umbralMagnitude) * 100);

  /*
   * The headline card, built like the weather's.
   *
   * Same shape for the same reason: a wash you read before any of the words,
   * one number at size, and the sentence under it. The wash here is the colour
   * the moon actually goes — copper for a total, barely touched for a
   * penumbral — so a glance at the tab says what kind of night it is.
   */
  body.append(el('div', { class: `eclipse-now is-${next.kind}` }, [
    eclipseDiagram(next, { size: 54 }),
    el('div', { class: 'eclipse-now-text' }, [
      el('div', { class: 'eclipse-when', text: longDate(next.greatest) }),
      el('div', { class: 'eclipse-headline', text: next.kind === 'total' ? 'Total' : `${covered}%` }),
      el('div', { class: 'eclipse-short', text: `${next.kind} lunar eclipse, greatest at ${clockTime(next.greatest)}` }),
    ]),
  ]));

  /*
   * The stages as a strip, the way four days of weather are a strip.
   *
   * Each chip draws the moon where it actually is at that moment — the offset
   * along the chord is sqrt(d^2 - gamma^2), so the bite grows and shrinks
   * across the row and the sequence reads without a word of it.
   */
  const stages = next.kind === 'penumbral'
    ? [['Enters', next.penumbral.from], ['Greatest', next.greatest], ['Leaves', next.penumbral.to]]
    : next.kind === 'total'
      ? [['First bite', next.partial.from], ['Total', next.total.from], ['Greatest', next.greatest],
        ['Total ends', next.total.to], ['Last bite', next.partial.to]]
      : [['Enters', next.penumbral.from], ['First bite', next.partial.from], ['Greatest', next.greatest],
        ['Last bite', next.partial.to], ['Leaves', next.penumbral.to]];

  body.append(el('div', { class: 'eclipse-strip' }, stages.map(([label, when]) => {
    const moon = moonPosition(when, lat, lon);
    return el('div', { class: `eclipse-chip${moon.altitude > 0 ? '' : ' is-down'}` }, [
      el('span', { class: 'eclipse-chip-when', text: label }),
      eclipseDiagram(next, { size: 28, at: when, plain: true }),
      el('span', { class: 'eclipse-chip-time', text: clockTime(when) }),
      el('span', {
        class: 'eclipse-chip-alt',
        // Per stage, not overall: an eclipse can begin below the horizon and
        // finish well up, and the half you can see is the half worth an alarm.
        text: moon.altitude > 0 ? `${Math.round(moon.altitude)}° up` : 'below',
      }),
    ]);
  })));

  body.append(el('p', { class: `eclipse-verdict is-${visible.state}`, text: visible.text }));
  body.append(eclipseMapToggle(position, next, visible));
  body.append(el('p', { class: 'source-note', text: describeEclipse(next) }));

  if (later.length) {
    body.append(el('p', { class: 'eclipse-later-title', text: 'After that' }));
    body.append(el('ul', { class: 'eclipse-later' }, later.map((entry) => el('li', {}, [
      el('span', { class: `eclipse-dot is-${entry.kind}` }),
      el('span', { class: 'eclipse-later-when', text: longDate(entry.greatest) }),
      el('span', { class: 'eclipse-later-kind', text: entry.kind }),
    ]))));
  }
}

/**
 * Put the eclipse on the map, and a slider across it.
 *
 * The strip above says when; this says where to stand and which way to face,
 * which is the half a table cannot answer — the moon will be 40° further west
 * by the time it leaves the shadow, and whether that is over the ridge behind
 * you is a question about this valley.
 *
 * It is the same control the other four sky tabs carry, given the eclipse's
 * own window instead of a night's, so switching it on replaces whatever was
 * drawn rather than layering another six spokes over it.
 */
function eclipseMapToggle(position, eclipse, visible) {
  if (visible.state === 'no') {
    return el('p', {
      class: 'hint', style: 'margin:0 0 10px',
      text: 'Nothing to draw here — the moon is below the horizon for the whole eclipse.',
    });
  }

  /*
   * Three marks, not five.
   *
   * The strip names every contact because it has a row per chip. The slider
   * has one track a few hundred pixels wide, and five labels along it overlap
   * into an unreadable smear — so it takes the outer bounds of the deepest
   * phase and the moment of greatest eclipse, in the strip's own words.
   */
  const deep = eclipse.total || eclipse.partial;
  const marks = [
    deep ? { at: deep.from.valueOf(), label: eclipse.total ? 'total' : 'first bite' } : null,
    { at: eclipse.greatest.valueOf(), label: 'greatest' },
    deep ? { at: deep.to.valueOf(), label: eclipse.total ? 'total ends' : 'last bite' } : null,
  ].filter(Boolean);

  return mapToggle(position, eclipse.greatest, 'eclipse', {
    on: 'Draw the eclipse on the map',
    off: 'Hide the eclipse',
    span: {
      label: 'Eclipse',
      // The whole event, outer shadow to outer shadow: the partial phase is
      // what you photograph, but the moon is already dimming before it and the
      // slider should not stop short of what the strip above lists.
      window: eclipse.penumbral || eclipse.partial || {
        from: new Date(eclipse.greatest.valueOf() - 3600e3),
        to: new Date(eclipse.greatest.valueOf() + 3600e3),
      },
      peak: eclipse.greatest,
      marks,
      empty: '',
    },
  });
}

/** Whether this place can see it, said as a sentence rather than a flag. */
function eclipseVisibility(eclipse, lat, lon) {
  const stages = [eclipse.penumbral?.from, eclipse.partial?.from, eclipse.greatest,
    eclipse.partial?.to, eclipse.penumbral?.to].filter(Boolean);
  const up = stages.filter((when) => moonPosition(when, lat, lon).altitude > 0);

  if (!up.length) {
    return { state: 'no', text: 'Not from here — the moon is below the horizon for all of it.' };
  }
  if (up.length === stages.length) {
    const peak = Math.round(moonPosition(eclipse.greatest, lat, lon).altitude);
    return { state: 'yes', text: `Visible from here, start to finish, with the moon ${peak}° up at greatest.` };
  }
  const peak = moonPosition(eclipse.greatest, lat, lon).altitude;
  return {
    state: 'part',
    text: peak > 0
      ? 'Partly visible from here — the moon rises or sets during the eclipse, but it is up for the deepest part.'
      : 'Only the edges of it from here — the moon is below the horizon at greatest eclipse.',
  };
}

/**
 * The moon against the shadow, drawn to scale.
 *
 * Distances are in earth radii, which is what gamma and the shadow radii are
 * already in, so the picture is the arithmetic rather than an impression of
 * it: a grazing eclipse looks grazing and a deep one looks deep.
 */
let eclipseClipId = 0;

/**
 * The moon's face, with the earth's shadow across it.
 *
 * The first version drew the two shadow circles with the moon as a dot inside
 * them — a diagram of the geometry rather than a picture of the event, and at
 * 28px an unreadable one. This draws what you would actually see: the lit disc,
 * the curved edge of the umbra crossing it, and the shadowed part gone copper.
 *
 * The curve falls out for free by clipping the shadow circle to the moon disc,
 * which is also why it is correct rather than stylised — the terminator during
 * an eclipse IS an arc of the umbra, and that is the detail that tells a lunar
 * eclipse apart from a crescent moon.
 *
 * Everything is scaled to moon radii, so the moon fills the frame at any size
 * and the shadow is as big relative to it as it really is: about 2.7 times the
 * moon's own radius, which is why totality lasts an hour.
 */
function eclipseDiagram(eclipse, { size = 78, at = null, plain = false } = {}) {
  const shape = shadowGeometry(eclipse);
  const moonRadius = size * 0.34;
  const perRadius = moonRadius / shape.moon;   // pixels per earth radius
  const cx = size / 2;
  const cy = size / 2;

  /*
   * How far the shadow's axis is from the moon's centre at this moment.
   *
   * At a contact that distance is the contact distance itself; between them
   * the closest approach is gamma. The along-track leg is the remaining side
   * of that right triangle, signed by whether the moment is before or after
   * greatest so a row of these reads left to right.
   */
  let along = 0;
  if (at) {
    const ms = Math.abs(at.getTime() - eclipse.greatest.getTime()) / 60000;
    const near = (phase, radius) => (phase && Math.abs(ms - phase.minutes / 2) < 0.5 ? radius : null);
    const contact = near(eclipse.total, shape.umbra - shape.moon)
      ?? near(eclipse.partial, shape.umbra + shape.moon)
      ?? near(eclipse.penumbral, shape.penumbra + shape.moon)
      ?? Math.abs(eclipse.gamma);
    const leg = Math.sqrt(Math.max(0, contact * contact - eclipse.gamma * eclipse.gamma));
    along = at < eclipse.greatest ? -leg : leg;
  }

  /*
   * The shadow moves and the moon stays put.
   *
   * The opposite of the physics — the moon is what travels — and the right way
   * round for a picture of the moon, which is the thing being looked at. Left
   * to right, because in the moon's own frame that is the way the shadow goes:
   * the moon runs east into it, so the eastern limb is bitten first and the
   * shadow finishes on the other side.
   */
  const shadowX = (cx + along * perRadius).toFixed(2);
  const shadowY = (cy + eclipse.gamma * perRadius).toFixed(2);
  const clip = `eclipse-clip-${eclipseClipId += 1}`;

  return el('div', {
    class: `eclipse-diagram${plain ? ' is-plain' : ''}`,
    html: `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${eclipse.kind} lunar eclipse">
      <defs><clipPath id="${clip}"><circle cx="${cx}" cy="${cy}" r="${moonRadius.toFixed(2)}"/></clipPath></defs>
      <circle cx="${cx}" cy="${cy}" r="${moonRadius.toFixed(2)}" class="eclipse-face"/>
      <g clip-path="url(#${clip})">
        <circle cx="${shadowX}" cy="${shadowY}" r="${(shape.penumbra * perRadius).toFixed(2)}" class="eclipse-penumbra"/>
        <circle cx="${shadowX}" cy="${shadowY}" r="${(shape.umbra * perRadius).toFixed(2)}" class="eclipse-umbra"/>
      </g>
      <circle cx="${cx}" cy="${cy}" r="${moonRadius.toFixed(2)}" class="eclipse-rim"/>
    </svg>`,
  });
}

function twilightPanel(body, position, phases, date) {
  const [lon, lat] = position;
  const now = sunPosition(date, lat, lon);

  body.append(el('div', { class: 'sky-phases' }, phases.map((phase) => el('div', { class: 'sky-phase' }, [
    el('span', { class: `sky-swatch is-${phase.id.replace('-pm', '')}` }),
    el('span', { class: 'sky-phase-name', text: phase.name }),
    el('span', { class: 'sky-phase-time', text: `${clockTime(phase.from)}–${clockTime(phase.to)}` }),
    el('span', { class: 'sky-phase-span', text: formatSpan(phase.minutes) }),
  ]))));

  body.append(el('p', {
    class: 'source-note',
    text: `Sun now ${now.altitude > 0 ? `${Math.round(now.altitude)}° up` : `${Math.round(-now.altitude)}° below the horizon`}, `
      + `bearing ${Math.round(now.azimuth)}°.`,
  }));

  body.append(mapToggle(position, date, 'sun', {
    on: 'Draw the sun on the map',
    off: 'Hide the sun',
  }));
}

function moonPanel(body, position, date) {
  const [lon, lat] = position;
  const moon = moonTimes(date, lat, lon);
  const illumination = moonIllumination(date);
  const moonNow = moonPosition(date, lat, lon);
  const percent = Math.round(illumination.fraction * 100);

  body.append(el('div', { class: 'moon-card' }, [
    el('span', { class: 'moon-face', html: moonGlyph(illumination) }),
    el('div', { class: 'moon-text' }, [
      el('div', { class: 'moon-name', text: illumination.name }),
      el('div', { class: 'moon-meta', text: `${percent}% lit · ${illumination.waxing ? 'waxing' : 'waning'}` }),
      el('div', {
        class: 'moon-meta',
        text: moon.alwaysUp ? 'Up all day'
          : moon.alwaysDown ? 'Below the horizon all day'
            : `Rises ${clockTime(moon.rise)} · sets ${clockTime(moon.set)}`,
      }),
      el('div', {
        class: 'moon-meta',
        text: moonNow.altitude > 0
          ? `Up now, ${Math.round(moonNow.altitude)}° at ${Math.round(moonNow.azimuth)}°`
          : 'Below the horizon now',
      }),
    ]),
  ]));

  /*
   * Which way the phase is going is what decides whether to shoot this week or
   * next, and it is the one thing a percentage alone cannot tell you.
   *
   * `phase` runs 0 at new through 0.5 at full and back to 1, so the distance to
   * either is just the gap around that circle times a synodic month.
   */
  const SYNODIC_DAYS = 29.53;
  const ahead = (target) => Math.max(1, Math.round(((target - illumination.phase + 1) % 1) * SYNODIC_DAYS));
  body.append(el('p', {
    class: 'source-note',
    text: illumination.waxing
      ? `Brighter each night — full in about ${ahead(0.5)} days.`
      : `Darker each night — new moon in about ${ahead(0)} days.`,
  }));

  body.append(mapToggle(position, date, 'moon', {
    on: 'Draw the moon on the map',
    off: 'Hide the moon',
  }));
}

/**
 * The galactic core: whether it is up, when, how high, and which nights.
 *
 * The altitude ceiling is stated first and deliberately. From the continental
 * US the core never climbs more than about 25° above the southern horizon, and
 * a panel that quietly listed no times above that would read as broken rather
 * than as astronomy.
 */
function milkyWayPanel(body, position, date) {
  const [lon, lat] = position;
  const night = milkyWayNight(date, lat, lon);

  if (!night.possible) {
    body.append(el('p', { class: 'hint', style: 'margin:0', text: capitalise(night.reason) }));
    if (night.maxAltitude > 5) body.append(nextCoreNight(date, lat, lon));
    return;
  }

  /*
   * The headline is the chance of actually seeing it, which needs cloud cover,
   * which needs the network. So the card is built from the astronomy first —
   * moon and window, known instantly and offline — and refined when the
   * forecast lands. It never shows a percentage it cannot stand behind: with
   * no cloud data it reports the moon and says that is all it knows.
   */
  const hero = el('div', { class: 'core-hero' });
  body.append(hero);
  renderCoreHero(hero, night, null);

  const nights = el('div');
  const cloudReady = skyCover([lon, lat]).then(
    (result) => (result.ok ? result.hours : null),
    () => null,
  );

  cloudReady.then((cover) => {
    if (hero.isConnected) renderCoreHero(hero, night, cover);
    if (nights.isConnected) nights.replaceChildren(bestNightsList(date, lat, lon, cover));
  });

  body.append(shootingWindow(night));

  // High in the panel rather than under the month-ahead table: this is the
  // action, and everything below it is the reasoning. At the bottom of a panel
  // this long it would be found by accident or not at all.
  body.append(mapToggle(position, date, 'core', {
    on: 'Draw the Milky Way on the map',
    off: 'Hide the Milky Way',
  }));

  const moonPercent = Math.round(night.moon.fraction * 100);
  const transitDiffers = night.windowPeak
    && Math.abs(night.windowPeak.altitude - night.transitAltitude) > 0.6;
  const cap = night.marks.length ? night.marks[night.marks.length - 1].percent : 0;

  const rows = [
    night.arcPeak
      ? ['Most of the band up', `${Math.round(night.arcPeak.fraction * 100)}% at ${clockTime(night.arcPeak.when)}`]
      : null,
    night.windowPeak
      ? ['Core highest, in the dark', `${clockTime(night.windowPeak.when)} · ${Math.round(night.windowPeak.altitude)}° at ${Math.round(night.windowPeak.azimuth)}°`]
      : null,
    transitDiffers || !night.windowPeak
      ? ['Core transits', `${clockTime(night.transit)} · ${Math.round(night.transitAltitude)}° at ${Math.round(night.transitAzimuth)}° — before dark`]
      : null,
    ['Astronomical dark', night.dark ? `${clockTime(night.dark.from)} – ${clockTime(night.dark.to)}` : '—'],
    ['Moon', `${moonPercent}% · ${night.moon.name.toLowerCase()}`],
    cap && cap < 100
      ? ['Ceiling here', 'the southern end of the band never clears the horizon from this latitude']
      : null,
  ].filter(Boolean);

  body.append(el('div', { class: 'core-rows' }, rows.map(([label, value]) => el('div', { class: 'core-row' }, [
    el('span', { class: 'core-row-label', text: label }),
    el('span', { class: 'core-row-value', text: value }),
  ]))));

  if (night.marks.length) {
    body.append(el('div', { class: 'core-marks' }, [
      el('div', { class: 'core-marks-label', text: 'Band above the horizon' }),
      ...night.marks.map((mark) => el('span', {
        class: 'core-mark',
        text: `${mark.percent}% from ${clockTime(mark.rising)} to ${clockTime(mark.falling)}`,
      })),
    ]));
  }

  body.append(el('p', {
    class: 'source-note',
    text: 'Percentages are how much of the bright core region — Scorpius and Sagittarius through'
      + ' to Aquila — is above the horizon. That depends on the angle the band makes with the'
      + ' horizon, not just how high its centre is.',
  }));

  nights.append(bestNightsList(date, lat, lon, null));
  body.append(nights);
}

/**
 * The headline card: how likely you are to see it, and when.
 *
 * Rebuilt in place rather than patched, because the moon-only version and the
 * moon-and-cloud version say different things in different words and stitching
 * one into the other would leave stale text behind.
 */
function renderCoreHero(hero, night, cover) {
  const quality = nightQuality(night, cover);
  const percent = quality.score === null ? null : Math.round(quality.score * 100);

  const band = percent === null ? 'unknown'
    : percent >= 75 ? 'good' : percent >= 30 ? 'fair' : 'poor';
  hero.className = `core-hero is-${band}`;

  const when = quality.best || night.moonless || night.window;
  const detail = [
    `${formatSpan(night.window.minutes)} dark`,
    night.moonless && night.moonless.minutes < night.window.minutes
      ? `moon up part of it (${Math.round(night.moon.fraction * 100)}%)`
      : `moon ${Math.round(night.moon.fraction * 100)}%`,
    quality.cloudCover === null ? 'cloud unknown' : `${quality.cloudCover}% cloud`,
  ].filter(Boolean).join(' · ');

  hero.replaceChildren(
    el('div', { class: 'core-headline' }, [
      el('div', { class: 'core-verdict', text: quality.verdict }),
      el('div', { class: 'core-window', text: `${clockTime(when.from)} – ${clockTime(when.to)}` }),
      el('div', { class: 'core-window-note', text: detail }),
    ]),
    percent === null
      ? el('div', { class: 'core-peak' }, [
        el('div', { class: 'core-peak-value', text: `${Math.round((night.arcPeak?.fraction || 0) * 100)}%` }),
        el('div', { class: 'core-peak-note', text: 'of the band up' }),
      ])
      : el('div', { class: 'core-peak' }, [
        el('div', { class: 'core-peak-value', text: `${percent}%` }),
        el('div', { class: 'core-peak-note', text: 'sky quality' }),
      ]),
  );
}

/**
 * When to actually press the shutter, and why each moment is worth it.
 *
 * Folded away by default: the headline answers "is tonight worth it", and this
 * answers "what time do I set the alarm for", which is a question you only ask
 * once the first one comes back yes.
 */
function shootingWindow(night) {
  const box = el('details', { class: 'core-guide' }, [
    el('summary', { class: 'core-guide-summary' }, [
      el('span', { class: 'core-guide-mark', html: icons.moon }),
      el('span', { text: 'Best times to shoot' }),
    ]),
  ]);

  const list = el('div', { class: 'core-guide-body' });
  for (const moment of night.moments) {
    list.append(el('div', { class: `core-moment${moment.primary ? ' is-primary' : ''}` }, [
      el('div', { class: 'core-moment-time', text: moment.until
        ? `${clockTime(moment.when)}–${clockTime(moment.until)}`
        : clockTime(moment.when) }),
      el('div', { class: 'core-moment-text' }, [
        el('div', { class: 'core-moment-name', text: moment.name }),
        el('div', { class: 'core-moment-why', text: moment.why }),
      ]),
    ]));
  }

  list.append(el('p', {
    class: 'source-note',
    text: 'Shoot the core between roughly 15 and 30 seconds at the widest aperture your lens has —'
      + ' longer and the stars trail. Everything above assumes you are away from town lights;'
      + ' the moon and the cloud are only two thirds of the problem.',
  }));

  box.append(list);
  return box;
}

/** When the core next becomes a night-time object, for the months it is not. */
function nextCoreNight(date, lat, lon) {
  const nights = bestMilkyWayNights(date, lat, lon, 200);
  const next = nights.find((entry) => entry.possible);
  return el('p', {
    class: 'source-note',
    text: next
      ? `Back in the night sky around ${next.date.toLocaleDateString([], { month: 'long', day: 'numeric' })}.`
      : 'Not a night-time object from here for the next six months.',
  });
}

/**
 * The next new-moon window, which is what "when should I drive out" means.
 *
 * Ranked by moonless dark hours, not by date: the moon is the only thing that
 * changes materially over a month and it is perfectly predictable, so this is
 * answerable weeks ahead in a way cloud never will be.
 */
function bestNightsList(date, lat, lon, cover) {
  const nights = bestMilkyWayNights(date, lat, lon, 45).filter((night) => night.minutes > 0);

  /*
   * Longest moonless window first, and a darker moon breaks the tie.
   *
   * The tie-break is not decoration. Late in the season the core sets before
   * the moon can matter, so a fortnight of nights all cap out at the same two
   * hours — ranked on length alone the list returns whichever five come first
   * in the calendar rather than the ones nearest new moon. Less illuminated
   * also means less residual sky glow in the hour either side of the window.
   */
  const best = [...nights]
    .sort((a, b) => b.minutes - a.minutes || a.moon.fraction - b.moon.fraction)
    .slice(0, 5)
    .sort((a, b) => a.date - b.date);

  const wrap = el('div', { class: 'core-nights' });
  if (!best.length) {
    wrap.append(el('p', { class: 'source-note', text: 'No moonless dark windows in the next six weeks.' }));
    return wrap;
  }

  wrap.append(el('div', { class: 'core-nights-label', text: 'Best nights ahead' }));
  for (const night of best) {
    /*
     * Cloud where the forecast reaches, moon everywhere. The forecast runs
     * about a week and the list runs six, so most rows will never have a cloud
     * figure — and a row showing one is saying something the rows below it
     * genuinely cannot.
     */
    const clouds = cover ? nightCloudCover(night.window, cover) : null;

    wrap.append(el('div', { class: 'core-night' }, [
      el('span', { class: 'core-night-date', text: night.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) }),
      el('span', { class: 'core-night-span', text: formatSpan(night.minutes) }),
      el('span', { class: 'core-night-moon', text: `${Math.round(night.moon.fraction * 100)}% moon` }),
      el('span', {
        class: `core-night-cloud${clouds !== null && clouds <= 30 ? ' is-clear' : ''}`,
        text: clouds === null ? '' : `${clouds}% cloud`,
      }),
    ]));
  }
  wrap.append(el('p', {
    class: 'source-note',
    text: 'Every window above is already moonless — the moon percentage is that night\u2019s'
      + ' phase, which sets how much glow is left either side of it. Cloud is shown for the'
      + ' nights the forecast reaches, about a week out; blank means nobody knows yet.',
  }));
  return wrap;
}

/* ---------------- putting a sky on the map ---------------- */

/**
 * Each drawing knows its own span of time, and what to call it.
 *
 * A slider is only useful if its ends mean something. The Milky Way's are dusk
 * and dawn, the sun's are first and last light, the moon's are its own rise and
 * set, and an eclipse brings its own — so rather than one clock over all of
 * time with a date picker beside it, each drawing states the window it is about
 * and the moments along it worth a tick.
 *
 * @returns {{window: {from: Date, to: Date}|null, peak: Date|null,
 *            marks: {at: number, label: string}[], label: string, empty: string}}
 */
function skySpan(mode, position, date) {
  const [lon, lat] = position;
  const mark = (when, label) => (when ? { at: when.valueOf(), label } : null);

  if (mode === 'sun') {
    const sun = sunTimes(date, lat, lon);
    // First light to last, not sunrise to sunset: the two hours either side of
    // the sun being up are the ones the panel above is entirely about.
    const from = sun.civilDawn || sun.sunrise;
    const to = sun.civilDusk || sun.sunset;
    return {
      label: 'Today',
      window: from && to ? { from, to } : null,
      peak: sun.solarNoon,
      marks: [mark(sun.sunrise, 'sunrise'), mark(sun.solarNoon, 'noon'), mark(sun.sunset, 'sunset')].filter(Boolean),
      empty: sun.polar === 'day'
        ? 'The sun does not set here today, so there is no sunrise or sunset to point at.'
        : 'The sun does not rise here today.',
    };
  }

  if (mode === 'moon') {
    const span = moonUpWindow(date, lat, lon);
    return {
      label: 'Moon up',
      window: span,
      peak: span ? moonTransit(span, lat, lon) : null,
      marks: span ? [
        mark(span.from, 'moonrise'), mark(moonTransit(span, lat, lon), 'highest'), mark(span.to, 'moonset'),
      ].filter(Boolean) : [],
      empty: 'The moon does not come up here today, so there is nothing to point at.',
    };
  }

  // The core and the everything-at-once drawing share the night: the band is
  // only worth pointing at between astronomical dusk and dawn, and that window
  // is what `milkyWayNight` computes.
  const night = milkyWayNight(date, lat, lon);
  return {
    label: 'Tonight',
    window: night?.dark || null,
    peak: night?.windowPeak?.when || null,
    night,
    marks: [
      mark(night?.windowPeak?.when, 'peak'),
      mark(night?.moonless?.from, 'moon down'),
      mark(night?.moonless?.to, 'moon up'),
    ].filter(Boolean),
    empty: 'No astronomical darkness tonight, so there is no window to scrub through.',
  };
}

/**
 * The stretch the moon is above the horizon, which is rarely one calendar day.
 *
 * `moonTimes` answers within a single local day, and the moon keeps its own
 * timetable — it can rise at eleven at night and set at three the following
 * afternoon. Taking rise and set from one day's answer gives a window that runs
 * backwards about half the month, which as a slider means no window at all.
 */
function moonUpWindow(date, lat, lon) {
  const DAY = 86400000;
  const today = moonTimes(date, lat, lon);
  if (today.alwaysDown) return null;
  if (today.alwaysUp) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    return { from: start, to: new Date(start.valueOf() + DAY) };
  }

  if (today.rise && today.set && today.set > today.rise) return { from: today.rise, to: today.set };

  if (today.rise) {
    // Up across midnight: it sets tomorrow.
    const tomorrow = moonTimes(new Date(date.valueOf() + DAY), lat, lon);
    const to = tomorrow.set && tomorrow.set > today.rise ? tomorrow.set : new Date(today.rise.valueOf() + DAY / 2);
    return { from: today.rise, to };
  }

  if (today.set) {
    // Already up when the day began: it rose yesterday.
    const yesterday = moonTimes(new Date(date.valueOf() - DAY), lat, lon);
    const from = yesterday.rise && yesterday.rise < today.set
      ? yesterday.rise : new Date(today.set.valueOf() - DAY / 2);
    return { from, to: today.set };
  }

  return null;
}

/** When the moon is highest across a window it is up for, sampled every ten minutes. */
function moonTransit(window, lat, lon) {
  const step = 10 * 60000;
  let best = null;
  for (let at = window.from.valueOf(); at <= window.to.valueOf(); at += step) {
    const altitude = moonPosition(new Date(at), lat, lon).altitude;
    if (!best || altitude > best.altitude) best = { at, altitude };
  }
  return best ? new Date(best.at) : null;
}

/**
 * Which bearings a drawing is about.
 *
 * The point of splitting one drawing into five is that each answers one
 * question. A sun drawing that also carried moonrise, moonset and the band
 * would be the aggregate again, and the map would be as crowded as it was
 * before — so each mode takes only its own body's lines, and only the
 * everything drawing takes them all.
 */
function directionsForMode(mode, position, when) {
  const [lon, lat] = position;
  const all = [...lightDirections(when, lat, lon), ...currentDirections(when, lat, lon)];
  if (mode === 'sky') return all;
  // An eclipse takes the moon's bearing and nothing else. Moonrise and moonset
  // are about the moon too, but the whole point of the eclipse drawing is that
  // it is one line: which way to face.
  if (mode === 'eclipse') return all.filter((entry) => entry.body === 'moon' && entry.now);
  return all.filter((entry) => entry.body === mode);
}

/**
 * Put one drawing on the map, or take it off, without toggling blindly.
 *
 * `toggleLightLines` flips, which is right under a button whose label says
 * which way it will flip. A tab that draws while it is open needs the other
 * verb — set it on, set it off — or a re-render of the open tab switches off
 * the drawing the tab is still claiming to show.
 */
function setSkyDrawing(position, date, mode, on) {
  const drawn = state.lightLines?.key === lineKey(position, mode);
  if (on === drawn) return;

  if (!on) { toggleLightLines(position, [], date, { mode }); return; }

  const shape = skySpan(mode, position, date);
  if (!shape.window) return;
  const at = shape.peak || date;
  toggleLightLines(position, directionsForMode(mode, position, at), at, {
    mode,
    body: modeBody(mode),
    window: shape.window,
    peak: shape.peak,
    marks: shape.marks,
    scrubLabel: shape.label,
    night: shape.night || null,
  });
}

/** The body each drawing is about, which is what the readout names. */
const modeBody = (mode) => (mode === 'eclipse' ? 'moon' : mode === 'sky' ? 'core' : mode);

/**
 * The button that puts one sky on the map, and the slider that moves it.
 *
 * Shared by all five panels rather than written per panel, because they differ
 * only in which window they cover and which lines they draw — and because
 * switching one on has to switch the others off. One sky on the map at a time
 * is what keeps it readable: five of these drawn at once is the clutter the
 * separate buttons exist to avoid.
 */
function mapToggle(position, date, mode, { on, off, span = null }) {
  const wrap = el('div', { class: 'sky-map' });
  const active = state.lightLines?.key === lineKey(position, mode);
  // Computed only when it is needed: the night one samples seven hundred sun
  // and moon positions, and the drawing already carries its window once it is
  // on, so asking again on every re-render would pay that for nothing.
  const shapeOf = () => span || skySpan(mode, position, date);

  if (active) {
    wrap.append(nightScrubber(position));
  } else if (!shapeOf().window) {
    wrap.append(el('p', { class: 'hint', style: 'margin:0', text: shapeOf().empty }));
    return wrap;
  }

  const button = labelledButton(active ? icons.eyeOff : icons.pin, active ? off : on, {
    tone: active ? 'secondary' : 'primary',
    onclick: () => {
      if (active) { toggleLightLines(position, [], date, { mode }); return; }
      const shape = shapeOf();
      const at = shape.peak || date;
      toggleLightLines(position, directionsForMode(mode, position, at), at, {
        mode,
        body: modeBody(mode),
        window: shape.window,
        peak: shape.peak,
        marks: shape.marks,
        scrubLabel: shape.label,
        night: shape.night || null,
      });
    },
  });
  button.classList.add('sky-lines-toggle');
  button.dataset.toggle = `${mode}-lines`;
  wrap.append(button);

  /*
   * The numbers behind the lines, but only once they are drawn.
   *
   * Bearings listed beside a map that is not showing them are trivia; listed
   * beside a slider that moves them they are the readout for it, and they
   * change as it moves. `refreshLineRows` swaps them in place for that reason.
   */
  if (active) {
    const at = state.lightLines.date || date;
    wrap.append(directionRows(directionsForMode(mode, position, at), at));
    if (mode === 'sky' || mode === 'core') wrap.append(lineKeyBlock());
  }

  return wrap;
}

/**
 * A slider across whatever window the drawing is about.
 *
 * Deliberately not a clock. A clock is an open-ended control over all of time,
 * needs a date picker beside it, and answers a question nobody asked; what a
 * photographer wants is "where will this be at two in the morning", and the
 * range that matters is one night, one day, or one eclipse. `skySpan` computes
 * exactly that per drawing, so the control has real ends and a real default
 * rather than arbitrary ones.
 *
 * It starts at the peak — solar noon, the moon's highest, greatest eclipse,
 * the best hour of the night — because that is the answer if you only look
 * once.
 */
function nightScrubber(position) {
  const [lon, lat] = position;

  /*
   * The window the slider covers, and what it is a window on.
   *
   * Both are carried by the drawing rather than assumed here, because they are
   * different for each of the five: the night for the band, first to last light
   * for the sun, moonrise to moonset for the moon, and the eclipse itself for
   * an eclipse. Reporting the galactic core's altitude while somebody drags
   * across an eclipse would be a true number about the wrong object, and
   * scrubbing eight hours of night to find ninety minutes of shadow is not a
   * control anyone wants.
   */
  const lines = state.lightLines;
  const span = lines?.window || lines?.night?.dark;
  if (!span) {
    return el('p', {
      class: 'hint', style: 'margin:0 0 8px',
      text: 'There is no window to scrub through here today.',
    });
  }

  const body = lines?.body || 'core';
  const eclipsing = lines?.mode === 'eclipse';
  const positionOf = body === 'sun' ? sunPosition : body === 'moon' ? moonPosition : galacticCentre;

  const from = span.from.valueOf();
  const to = span.to.valueOf();
  const peak = lines?.peak?.valueOf() ?? lines?.night?.windowPeak?.when?.valueOf() ?? (from + to) / 2;

  /*
   * The moments worth knowing while dragging.
   *
   * A slider with two ends and nothing between them makes you scrub blind to
   * find the answer. Each drawing names its own — sunrise, noon and sunset for
   * the sun; when the core is highest and when the moon leaves or arrives to
   * ruin it for the band; the contacts for an eclipse. Anything outside the
   * window is dropped rather than clamped to an end, where it would claim
   * something happens at dusk that does not.
   */
  const inWindow = (value) => Number.isFinite(value) && value >= from && value <= to;
  const marks = (lines?.marks || [])
    .filter((mark) => mark && inWindow(mark.at)).sort((a, b) => a.at - b.at);

  const readout = el('span', { class: 'scrub-time' });
  const show = (at) => {
    const when = new Date(at);
    const where = positionOf(when, lat, lon);
    readout.textContent = where.altitude > 0
      ? `${clockTime(when)} · ${body} ${Math.round(where.altitude)}° at ${Math.round(where.azimuth)}°`
      : `${clockTime(when)} · ${body} below the horizon`;
  };

  const now = Date.now();
  const nowButton = el('button', {
    class: 'scrub-now', type: 'button',
    text: 'Now',
    title: now < from || now > to
      ? `Now is outside the window this slider covers \u2014 jumps to the nearest end`
      : 'Back to the present',
    onclick: () => {
      const at = Math.min(Math.max(Date.now(), from), to);
      slider.value = String(at);
      show(at);
      setSkyTime(new Date(at));
    },
  });

  const slider = el('input', {
    type: 'range', class: 'scrub-range',
    min: String(from), max: String(to), value: String(Math.min(Math.max(peak, from), to)),
    // A minute across an eclipse, five across a night. Five-minute steps snap
    // off the marks the slider carries: greatest eclipse at 4:14 landed on
    // 4:16, two minutes from the tick labelled "greatest" right beneath it.
    step: String((eclipsing ? 1 : 5) * 60 * 1000),
    'aria-label': `Time across ${lines?.scrubLabel || 'tonight'}`,
    oninput: (event) => {
      const at = Number(event.target.value);
      show(at);
      setSkyTime(new Date(at));
    },
  });

  show(Number(slider.value));
  setSkyTime(new Date(Number(slider.value)));

  return el('div', { class: 'scrubber' }, [
    el('div', { class: 'scrub-head' }, [
      el('span', { class: 'scrub-label', text: lines?.scrubLabel || 'Tonight' }),
      readout,
      nowButton,
    ]),
    slider,
    el('div', { class: 'scrub-ends' }, [
      el('span', { text: clockTime(span.from) }),
      el('span', { text: clockTime(span.to) }),
    ]),
    marks.length ? el('ul', { class: 'scrub-marks' }, marks.map((mark) => {
      const along = ((mark.at - from) / (to - from)) * 100;
      return el('li', {
        // Positioned along the track so the label sits under the moment it
        // names, and pulled inside the panel at either end — see the CSS.
        class: `scrub-mark${along < 8 ? ' at-start' : along > 92 ? ' at-end' : ''}`,
        style: `left:${along.toFixed(1)}%`,
        title: `${mark.label} · ${clockTime(new Date(mark.at))}`,
      }, [
        el('span', { class: 'scrub-mark-tick' }),
        el('span', { class: 'scrub-mark-label', text: mark.label }),
      ]);
    })) : null,
  ]);
}

/**
 * Tonight's space weather, in one line.
 *
 * Two numbers that answer different halves: the planetary K index is how
 * disturbed the field is right now, and OVATION's grid is the chance of aurora
 * over *this* point in the next half hour. Kp alone would say "storm" to
 * somebody in Texas for whom it still means nothing.
 */
function auroraPanel(body, position) {
  const chance = el('span', { class: 'core-row-value', text: '…' });
  const kpValue = el('span', { class: 'core-row-value', text: '…' });
  const verdict = el('p', { class: 'legend-note', style: 'margin:8px 0 0' });

  body.append(el('div', { class: 'core-rows' }, [
    el('div', { class: 'core-row' }, [
      el('span', { class: 'core-row-label', text: 'Chance here, next 30 min' }),
      chance,
    ]),
    el('div', { class: 'core-row' }, [
      el('span', { class: 'core-row-label', text: 'Planetary K index' }),
      kpValue,
    ]),
  ]));
  body.append(verdict);

  /*
   * Said plainly, because the numbers alone mislead at this latitude.
   *
   * Kp 5 is a storm and reads as exciting; from Tennessee it still means
   * nothing you can see. The percentage is the one that answers the question
   * asked, and it is the one given first.
   */
  Promise.all([kpNow(), auroraChance(position)]).then(([kp, here]) => {
    if (!body.isConnected) return;

    if (!kp && !here) {
      // Offline, or NOAA is having an afternoon. Saying "quiet" would be a
      // claim; saying nothing is the truth.
      chance.textContent = 'not available';
      kpValue.textContent = '—';
      verdict.textContent = 'No answer from the Space Weather Prediction Center just now.';
      return;
    }

    chance.textContent = here ? `${Math.round(here.chance)}%` : 'no data for this point';
    kpValue.textContent = kp ? String(kp.kp) : '—';
    verdict.textContent = kp ? describeKp(kp.kp) : '';
  });

  body.append(el('p', {
    class: 'hint', style: 'margin:10px 0 0',
    text: 'OVATION models where the aurora is, not whether you will see it — '
      + 'cloud, the moon and your northern horizon all still apply.',
  }));
}

/**
 * Everything at once: sun, moon and band on one map.
 *
 * The four tabs before it each draw their own subject, which is the readable
 * way to use this — one question, a handful of lines. This one is for the
 * comparison those cannot make: whether the sun sets into the same notch the
 * core rises out of, and where the moon will be when it does. It is crowded on
 * purpose, and it is one press away from not being.
 */
function linesPanel(body, position, date) {
  const [lon, lat] = position;
  const active = state.lightLines?.key === lineKey(position, 'sky');
  const when = active ? (state.lightLines.date || date) : date;
  const all = directionsForMode('sky', position, when);

  if (!all.length) {
    body.append(el('p', { class: 'hint', style: 'margin:0', text: 'Nothing is above the horizon to point at.' }));
    return;
  }

  /*
   * No button, because the tab is the button.
   *
   * Everything below is the readout for a drawing that is already on the map:
   * the slider that moves it, the bearings it drew, and the key to the two
   * curves that carry no label of their own.
   */
  if (active) body.append(nightScrubber(position));
  body.append(directionRows(all, when));
  body.append(lineKeyBlock());
}

/**
 * The bearings as a list, named for the moment they are drawn for.
 *
 * "Moon now" is only true while the slider sits on the present. Dragged to two
 * in the morning it is the moon at two in the morning, and a row that still
 * says "now" is telling you something false about a line you are standing
 * under — so away from the present these are named by their time instead.
 */
function directionRows(entries, when) {
  return el('div', { class: 'core-rows sky-rows' }, entries.map((entry) => el('div', { class: 'core-row' }, [
    el('span', { class: 'core-row-label' }, [
      el('span', { class: `dir-dot is-${entry.body}${entry.now ? ' is-now' : ''}` }),
      el('span', { text: directionName(entry, when) }),
    ]),
    el('span', {
      class: 'core-row-value',
      text: entry.now
        ? `${Math.round(entry.azimuth)}° · ${Math.round(entry.altitude)}° up`
        : `${Math.round(entry.azimuth)}° · ${clockTime(entry.at)}`,
    }),
  ])));
}

/**
 * A drawn line's label: what it is, which way, and how high.
 *
 * Built here rather than at each call site because the "now" half of it is the
 * part that goes wrong — see `directionName`.
 */
const nowLabel = (name, where, when) => [
  directionName({ name, now: true }, when),
  `${Math.round(where.azimuth)}°`,
  `${Math.round(where.altitude)}° up`,
].join(' · ');

/** "Moon now" while the slider is on the present, "Moon 2:14 AM" once it is not. */
function directionName(entry, when) {
  if (!entry.now) return entry.name;
  const at = when || new Date();
  // A minute of slack: the slider steps by the minute, and a label flickering
  // between two spellings of the same instant is worse than either.
  if (Math.abs(at.valueOf() - Date.now()) < 60000) return entry.name;
  return `${entry.name.replace(/ now$/i, '')} ${clockTime(at)}`;
}

/**
 * What the unlabelled lines are.
 *
 * Every bearing carries its own label along it; the band and the night track
 * do not, because a label repeated along a sampled curve is a dotted mess. So
 * they are named here instead — the first thing anyone asks about that pale
 * violet line is what it is.
 */
function lineKeyBlock() {
  const rows = [
    ['band', 'The Milky Way band', 'The wide violet curve, labelled on the map — the band itself, not a bearing to it.'],
    ['track', 'The hour ring', 'Dashed, around the pin: every bearing the core passes through tonight, with the hours on it.'],
    ['spoke', 'Milky Way core', 'The solid violet line — which way to face right now, or at whatever time the slider is on.'],
  ];
  return el('div', { class: 'line-key' }, rows.map(([kind, name, note]) => el('div', { class: 'line-key-row' }, [
    el('span', { class: `line-key-swatch is-${kind}` }),
    el('span', { class: 'line-key-text' }, [
      el('span', { class: 'line-key-name', text: name }),
      el('span', { class: 'line-key-note', text: note }),
    ]),
  ])));
}

/**
 * Re-label the bearing rows without rebuilding the panel around them.
 *
 * The slider lives in the same panel, so re-rendering the whole details tab on
 * every drag would tear the handle out from under the finger holding it. Only
 * the rows change as the moment moves, so only the rows are replaced.
 */
function refreshLineRows() {
  const rows = document.querySelector('.sky-rows');
  if (!rows || !state.lightLines) return;
  const { position, date, mode } = state.lightLines;
  rows.replaceWith(directionRows(directionsForMode(mode || 'sky', position, date || new Date()), date));
}

const capitalise = (text = '') => text.charAt(0).toUpperCase() + text.slice(1);

/** Mean cloud cover across a window, or null when the forecast does not reach it. */
function nightCloudCover(window, cover) {
  if (!window || !cover?.length) return null;

  const inside = cover.filter((hour) => hour.cover !== null
    && hour.at >= window.from && hour.at <= window.to);
  if (!inside.length) return null;

  return Math.round(inside.reduce((total, hour) => total + hour.cover, 0) / inside.length);
}

function skyCell(label, value, note) {
  return el('div', { class: 'sky-cell' }, [
    el('div', { class: 'sky-cell-label', text: label }),
    el('div', { class: 'sky-cell-value', text: value }),
    note ? el('div', { class: 'sky-cell-note', text: note }) : null,
  ]);
}

/**
 * Draw lines from a point along the sunrise, sunset, moonrise and moonset
 * bearings.
 *
 * The reason this belongs on a map rather than in the table above it: knowing
 * the sun sets at 291° is not the same as seeing that 291° runs straight down
 * the valley, or straight into the ridge behind you.
 */
function toggleLightLines(position, directions, date = new Date(), options = {}) {
  const { mode = 'sky' } = options;
  /*
   * Keyed by mode as well as place, so the two drawings replace each other.
   *
   * Keyed by position alone, switching the eclipse on at a pin that already had
   * the Milky Way lines would have read as "off" — one press to clear, another
   * to draw — and pressing the eclipse button would have hidden something else.
   * With the mode in the key, the same-mode press still toggles and a
   * different-mode press swaps, which is the point: one sky on the map at a
   * time is what stops it being cluttered.
   */
  if (state.lightLines?.key === lineKey(position, mode)) {
    state.lightLines = null;
    refreshLightLines();
    renderDetailsTab();
    return;
  }

  /*
   * The night is computed once here, not on every scrub.
   *
   * `milkyWayNight` samples the whole night two minutes at a time to find the
   * dark window; doing that again for each drag of the slider would be a
   * hundred of those a second. The window does not move within one night, so it
   * is worked out when the lines go on and carried with them.
   */
  const [lon, lat] = position;
  // Only the Milky Way needs the night sampled: an eclipse carries its own
  // window, and sampling a night to draw ninety minutes of shadow would be
  // seven hundred positions computed for nothing.
  const night = mode === 'sky' ? milkyWayNight(date, lat, lon) : null;
  state.lightLines = {
    key: lineKey(position, mode), mode, position, directions, date, night, ...options,
  };
  refreshLightLines();
  renderDetailsTab();
}

/** Which sky is drawn, and where — see the comment in `toggleLightLines`. */
const lineKey = (position, mode = 'sky') => `${position.join(',')}|${mode}`;

/**
 * Move the drawn sky to another moment of the same night.
 *
 * The scrubber's whole range is one night, which is why it needs no clock: the
 * core is only worth looking at between astronomical dusk and dawn, and
 * `milkyWayNight` already computes exactly that window. So the control is
 * bounded by something the app knows rather than by the calendar, and dragging
 * it re-asks the same maths for a different instant.
 */
function setSkyTime(when) {
  if (!state.lightLines) return;
  const [lon, lat] = state.lightLines.position;
  state.lightLines.date = when;
  /*
   * Both halves, which is the point.
   *
   * `lightDirections` is where things rise and set — fixed for the night — and
   * `currentDirections` is where they are at this instant, including the
   * bearing to the galactic core. Recomputing only the first left the "Milky
   * Way now" spoke frozen at the moment the lines were switched on while the
   * band above it moved, which is worse than not drawing it.
   */
  /*
   * An eclipse asks about one body, so it is given one.
   *
   * Rise and set bearings for the sun are not wrong during an eclipse, they
   * are simply not what is being watched, and drawing four more spokes across
   * the map is the clutter this mode exists to avoid.
   */
  state.lightLines.directions = directionsForMode(
    state.lightLines.mode || 'sky', state.lightLines.position, when,
  );
  refreshLightLines();
  refreshLineRows();
}

function refreshLightLines() {
  if (!styleReady()) { whenStyleReady(refreshLightLines); return; }

  const source = state.map.getSource(LIGHT_SOURCE);
  if (!source) return;

  const lines = state.lightLines;
  if (!lines) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const REACH = skyReach();

  /*
   * One body, or all of them.
   *
   * The sun, moon and eclipse drawings are the same picture of different
   * objects — rise and set bearings, a path across the window, where it is at
   * the scrubbed moment — so they share one builder. The band needs its own,
   * because it is the one thing here that is not a bearing from the observer.
   */
  if (lines.mode === 'sun' || lines.mode === 'moon' || lines.mode === 'eclipse') {
    source.setData({ type: 'FeatureCollection', features: bodyFeatures(lines, REACH) });
    return;
  }

  const sky = milkyWayGround(lines.position, lines.date || new Date(), { maxKm: REACH });

  /*
   * The core's own spoke replaces the generic "Milky Way now" bearing.
   *
   * Both are a line from where you are standing towards the core, so drawing
   * both puts two collinear lines on top of each other. This one ends on the
   * band rather than at a fixed 40km, so the spoke and the arc meet — which is
   * what makes the picture readable as "stand here, face this way, the band is
   * there" rather than as two unrelated marks.
   */
  const drawn = sky.core
    ? lines.directions.filter((direction) => direction.id !== 'core-now')
    : lines.directions;

  const at = lines.date || new Date();
  const features = drawn.map((direction) => ({
    type: 'Feature',
    properties: {
      body: direction.body,
      now: !!direction.now,
      label: direction.now
        ? nowLabel(direction.name, direction, at)
        : `${direction.name} ${Math.round(direction.azimuth)}°`,
    },
    geometry: {
      type: 'LineString',
      coordinates: [lines.position, destinationPoint(lines.position, direction.azimuth, REACH)],
    },
  }));

  /*
   * The band itself, not just a bearing to its centre.
   *
   * A line pointing at the core says where to stand; the arc says what the
   * frame will contain — whether the band runs along the ridge or straight up
   * out of it. That is the question the whole Photography panel is for, and it
   * is the one thing a table of numbers cannot answer.
   */
  if (sky.core) {
    features.push({
      type: 'Feature',
      properties: {
        body: 'core',
        now: true,
        label: nowLabel('Milky Way core now', sky.core, at),
      },
      geometry: { type: 'LineString', coordinates: [lines.position, sky.core.position] },
    });
  }

  /*
   * Where the core goes across the night, as a ring around the pin.
   *
   * The band is one instant; this is the shape of the whole night, which is
   * what you plan around — the core will have moved thirty degrees west by the
   * time you have walked in. Drawn at a fixed distance so it reads as a sweep
   * of bearings rather than as a squiggle, with the hours marked, because a
   * curve alone says where and not when.
   */
  const window = lines.window || lines.night?.dark;
  if (window) {
    features.push(...ringFeatures(
      milkyWayTrack(lines.position, window.from, window.to, {
        maxKm: REACH, fixedKm: ringRadius(REACH), stepMinutes: 10,
      }),
      'core',
      { highest: lines.peak || lines.night?.windowPeak?.when || null },
    ));
  }

  if (sky.line.length > 1) {
    features.push({
      type: 'Feature',
      properties: { body: 'core', kind: 'arc' },
      geometry: { type: 'LineString', coordinates: sky.line },
    });
  }

  source.setData({ type: 'FeatureCollection', features });
}

/**
 * How far the whole drawing reaches, sized to what is on screen.
 *
 * This was a fixed 40km, chosen for trip-planning zooms — and at any zoom
 * closer than that the ring was drawn twenty-five kilometres off the edge of
 * the screen while the spokes, which run the full reach, crossed it. So the
 * drawing looked like bearings and nothing else, and the ring looked broken
 * when it was merely somewhere else.
 *
 * Sized to the view instead: a little under half the shorter side, so the ring
 * always sits inside the frame with room for its labels, and the spokes always
 * run past it and off the edge. The clamp keeps it sane at both ends — a
 * continent-wide view does not need a five-hundred-kilometre spoke, and a view
 * of one field still gets a ring big enough to read.
 */
function skyReach() {
  const bounds = state.map?.getBounds?.();
  if (!bounds) return 40;

  const north = bounds.getNorth();
  const south = bounds.getSouth();
  const middle = (north + south) / 2;
  const tall = (north - south) * 111.32;
  const wide = (bounds.getEast() - bounds.getWest()) * 111.32 * Math.cos(middle * Math.PI / 180);
  const across = Math.min(Math.abs(tall), Math.abs(wide));

  return Math.min(60, Math.max(0.4, across * 0.42));
}

/**
 * How far out the hour ring is drawn.
 *
 * Inside the reach of the bearings, so the spokes cross it rather than
 * stopping at it, and far enough from the pin that a dozen hour labels around
 * it are not on top of each other.
 */
const ringRadius = (reach) => reach * 0.62;

/**
 * A body's sweep of bearings as a ring, with the hours named along it.
 *
 * The question this answers is "which way, and when" — where the core will be
 * at two in the morning, whether the sun will still be behind the ridge at
 * five. A ring answers both at once: the arc is every bearing it passes
 * through, and the labels put a clock on it.
 *
 * The pulled-in projection was tried first and is what prompted "what is the
 * light purple line" — at a distance that shrinks as the body climbs, the path
 * is a curve nobody can read a bearing off, and the hour labels crowd into the
 * middle exactly when the body is highest and most worth shooting.
 */
function ringFeatures(track, body, { highest = null } = {}) {
  if (track.length < 2) return [];

  const features = [{
    type: 'Feature',
    properties: { body, kind: 'track' },
    geometry: { type: 'LineString', coordinates: track.map((point) => point.position) },
  }];

  for (const point of track.filter((sample) => sample.when.getMinutes() === 0)) {
    features.push({
      type: 'Feature',
      properties: { body, kind: 'hour', label: clockTime(point.when) },
      geometry: { type: 'Point', coordinates: point.position },
    });
  }

  // The moment the whole panel is recommending, named on the ring rather than
  // left for the reader to find among the hours.
  if (highest) {
    const at = track.reduce((best, point) => (Math.abs(point.when - highest) < Math.abs(best.when - highest) ? point : best));
    features.push({
      type: 'Feature',
      properties: { body, kind: 'hour', label: `highest ${clockTime(highest)}` },
      geometry: { type: 'Point', coordinates: at.position },
    });
  }

  return features;
}

/**
 * One body on the ground: where to face, and where that heads.
 *
 * Deliberately a handful of lines and not eight. The everything drawing
 * answers "how does the whole sky sit over this valley", which takes an arc, a
 * track and six bearings; this answers "which way do I point the camera, and
 * where will it have moved by then", which takes rise and set, a path, and one
 * line for the moment on the slider.
 *
 * The path and the spoke use the same projection — along the bearing, pulled
 * in as the body climbs — so the spoke lands on the path rather than running
 * past it, and the two read as one picture.
 */
function bodyFeatures(lines, reach) {
  const [lon, lat] = lines.position;
  const body = lines.body === 'sun' ? 'sun' : 'moon';
  const eclipse = lines.mode === 'eclipse';
  const positionAt = body === 'sun' ? sunPosition : moonPosition;
  const trackOf = body === 'sun' ? sunTrack : moonTrack;
  const when = lines.date || new Date();
  const features = [];

  const project = (where) => destinationPoint(
    lines.position, where.azimuth, reach * (1 - Math.min(90, Math.max(0, where.altitude)) / 90),
  );

  // Rise and set: fixed for the day, and the reason to stand here rather than
  // fifty metres along the ridge. Drawn at full reach, as bearings not paths.
  for (const direction of lines.directions.filter((entry) => !entry.now)) {
    features.push({
      type: 'Feature',
      properties: {
        body: direction.body,
        now: false,
        label: `${direction.name} ${Math.round(direction.azimuth)}°`,
      },
      geometry: {
        type: 'LineString',
        coordinates: [lines.position, destinationPoint(lines.position, direction.azimuth, reach)],
      },
    });
  }

  const window = lines.window;
  const ring = ringRadius(reach);
  const track = window
    ? trackOf(lines.position, window.from, window.to, {
      maxKm: reach,
      fixedKm: ring,
      // Five-minute steps across an eclipse, starting on the instant it does:
      // a quarter-hour anchored to the clock would drop the first sample and
      // begin the drawing after the eclipse had begun.
      ...(eclipse ? { stepMinutes: 5, anchor: false } : { stepMinutes: 10 }),
    })
    : [];

  /*
   * What to name along the ring.
   *
   * Hours for a day or a night: an arc says where and not when, and the hour
   * is what you plan around. For an eclipse the moments worth naming are the
   * contacts the strip above already names, in the same words, so the map and
   * the panel agree — and the hours in between would be noise across ninety
   * minutes.
   */
  if (eclipse) {
    if (track.length > 1) {
      features.push({
        type: 'Feature',
        properties: { body, kind: 'track' },
        geometry: { type: 'LineString', coordinates: track.map((point) => point.position) },
      });
    }
    for (const mark of lines.marks || []) {
      const at = new Date(mark.at);
      if (!window || at < window.from || at > window.to) continue;
      const where = positionAt(at, lat, lon);
      if (where.altitude <= 0) continue;
      features.push({
        type: 'Feature',
        properties: { body, kind: 'hour', label: `${mark.label} ${clockTime(at)}` },
        geometry: { type: 'Point', coordinates: destinationPoint(lines.position, where.azimuth, ring) },
      });
    }
  } else {
    features.push(...ringFeatures(track, body, { highest: lines.peak || null }));
  }

  // Where it is at the scrubbed moment — the one line you can check by looking
  // up. Below the horizon it is left undrawn rather than drawn at zero, where
  // it would point along the ground at something you cannot see.
  const now = positionAt(when, lat, lon);
  if (now.altitude > 0) {
    features.push({
      type: 'Feature',
      properties: {
        body,
        now: true,
        label: nowLabel(`${capitalise(body)} now`, now, when),
      },
      geometry: { type: 'LineString', coordinates: [lines.position, project(now)] },
    });
  }

  return features;
}

/* ---------------- offline regions ---------------- */

/**
 * Whether the current basemap is vector, which changes the size estimate.
 *
 * A vector tile carries the geometry for every zoom above it and so runs
 * heavier than a raster tile of the same ground — enough that using one figure
 * for both would put the estimate out by half.
 */
function currentTileKind() {
  return basemapById(state.basemapId)?.style ? 'vector' : 'raster';
}


function regionBoundsLabel({ west, south, east, north }) {
  const ns = (value) => `${Math.abs(value).toFixed(2)}°${value >= 0 ? 'N' : 'S'}`;
  const ew = (value) => `${Math.abs(value).toFixed(2)}°${value >= 0 ? 'E' : 'W'}`;
  return `${ns(south)} ${ew(west)} → ${ns(north)} ${ew(east)}`;
}

/** Push region outlines to the map, marking the highlighted one. */
function refreshRegionData() {
  if (!styleReady()) { whenStyleReady(refreshRegionData); return; }
  try {
    const source = state.map.getSource(REGION_SOURCE);
    if (!source) return;
    const data = regionsToGeoJSON(state.offline.list());
    for (const feature of data.features) {
      feature.properties.highlight = feature.properties.id === state.highlightRegion;
    }
    source.setData(data);
  } catch (error) {
    console.warn('[map] could not refresh region outlines:', error.message);
  }
}

/**
 * The offline panel.
 *
 * The framing matters as much as the controls: Mapbox GL JS has no offline
 * API, so this browser genuinely cannot download tiles and saying otherwise
 * would be a promise broken at the worst possible moment. What it can do is let
 * you choose the ground and see the cost honestly, and export that in the shape
 * the mobile SDKs take — so the planning done here is not repeated on a phone.
 */
function renderOfflineTab() {
  if (!dom.offline) return;
  const regions = state.offline.list();
  const kind = currentTileKind();
  dom.offline.replaceChildren();

  if (dom.offlineCount) {
    dom.offlineCount.textContent = regions.length ? `${regions.length} saved` : '';
  }

  dom.offline.append(
    el('h3', { class: 'offline-heading', text: 'On this screen' }),
    el('div', { class: 'folder-actions' }, [
      /*
       * The picture first, because it is the one that always works.
       *
       * It costs no tiles, needs no account and no network, and on a phone in
       * a canyon it is often the whole answer. The tile regions below it are
       * the heavier, app-only option.
       */
      labelledButton(icons.camera, 'Save as a picture', {
        tone: 'secondary',
        title: 'Save this view as an image — uses no map data',
        onclick: saveMapImage,
      }, 'snapshot-button'),
      labelledButton(icons.download, 'Export GPX', {
        tone: 'ghost',
        title: 'Everything on the map, in the format Garmin, Gaia and AllTrails import',
        onclick: () => downloadVisible(),
      }, 'download-button'),
      labelledButton(icons.download, 'Export GeoJSON', {
        tone: 'ghost',
        title: 'The same features with their full properties, for another map to read',
        onclick: () => downloadVisible(true),
      }),
    ]),
    el('h3', { class: 'offline-heading', text: 'Map regions' }),
    el('p', {
      class: 'hint',
      style: 'margin:-4px 0 10px',
      text: 'Mark the ground you want on the phone. Downloading happens in the app — a browser cannot '
        + `store map tiles for later — so this saves the region and the zooms, capped at z${OFFLINE_MAX_ZOOM}.`,
    }),
    el('div', { class: 'folder-actions' }, [
      el('button', {
        class: 'button button-secondary button-small', type: 'button',
        text: 'Save what is on screen',
        onclick: () => {
          const basemap = basemapById(state.basemapId);
          const region = state.offline.add({
            name: `Region ${state.offline.list().length + 1}`,
            bounds: state.map.getBounds(),
            minZoom: Math.max(0, Math.min(deepestUsefulZoom(), Math.round(state.map.getZoom()) - 3)),
            maxZoom: Math.min(deepestUsefulZoom(), Math.max(8, Math.round(state.map.getZoom()) + 1)),
            basemapId: basemap?.id || '',
            basemapName: basemap?.name || '',
          });
          if (!region) { toast('The map view could not be read as a region.', { tone: 'error' }); return; }
          toast(`Saved “${region.name}” from the current view.`);
        },
      }),
      /*
       * "Export for the app" is gone, and it never worked.
       *
       * It wrote a JSON manifest shaped for the native Mapbox SDK's offline
       * API. This app is Mapbox GL JS in a webview, not that SDK - there was
       * no importer on the iOS side and no way to feed the file back in. It
       * was a button producing an artefact nothing consumed, which is worse
       * than a missing feature: it implied a workflow that did not exist.
       *
       * The region download below is the real thing now, and it works in the
       * app for the same reason it works here - the tiles go into a cache the
       * service worker reads.
       */
    ]),
  );

  if (!regions.length) {
    dom.offline.append(el('p', {
      class: 'hint',
      text: 'No regions yet. Pan and zoom to the area you are heading for, then save it.',
    }));
    return;
  }

  const list = el('div', { class: 'region-list' });
  for (const region of regions) list.append(regionRow(region, kind));
  dom.offline.append(list);

  /*
   * Two different ceilings, and they were being conflated.
   *
   * TILE_BUDGET is Mapbox's per-account limit on regions downloaded through
   * their offline SDK, which is what the exported manifest feeds. It has
   * nothing to do with tiles this app fetches into its own cache, and quoting
   * it under a download that does not touch Mapbox told somebody their USGS
   * region was over a limit that does not apply to it.
   *
   * So the Mapbox number is stated where the manifest is, and what the app
   * itself is holding is read from the browser rather than estimated - the
   * quota is the real constraint on a phone, and it is knowable.
   */
  const totalTiles = state.offline.totalTiles(kind);
  if (kind === 'vector') {
    const overBudget = totalTiles > TILE_BUDGET;
    dom.offline.append(el('p', {
      class: overBudget ? 'region-warning' : 'source-note',
      text: overBudget
        ? `${totalTiles.toLocaleString()} tiles in total, over the ${TILE_BUDGET.toLocaleString()} `
          + 'Mapbox allows per account by default for a manifest export. Trim a region, lower a maximum zoom, or ask Mapbox to raise the limit.'
        : `${totalTiles.toLocaleString()} tiles in total of the ${TILE_BUDGET.toLocaleString()} Mapbox allows per account for a manifest export.`,
    }));
  }

  const storage = el('p', { class: 'source-note', text: '' });
  dom.offline.append(el('div', { class: 'offline-storage' }, [storage, el('button', {
    class: 'button button-ghost button-small', type: 'button',
    text: 'Delete downloaded tiles',
    onclick: async () => {
      /*
       * Both stores. The raster tiles live in the Cache API and the archive
       * tiles in IndexedDB, and a Delete button that empties one of them is
       * how a phone stays full after somebody has cleared it.
       */
      await clearTiles();
      await (await openTileStore()).clear();
      toast('Downloaded tiles removed.');
      renderOfflineTab();
    },
  })]));
  describeStorage(storage);
}

/**
 * How much room the downloads are actually taking, and how much there is.
 *
 * Read from the browser rather than estimated from a tile count. An estimate
 * built from an average tile size is wrong by a factor of three between an
 * aerial and a contour sheet, and the number that decides whether the next
 * download succeeds is the quota - which the browser will simply tell you.
 *
 * Both halves are best-effort: `estimate()` is absent in some browsers and
 * approximate in the rest, and it counts everything this origin stores rather
 * than the tile cache alone. Saying "about" is the honest way to show a number
 * that is genuinely about.
 */
async function describeStorage(node) {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    if (!quota) { node.textContent = 'This browser does not report how much it can store.'; return; }
    const share = Math.round((usage / quota) * 100);
    node.textContent = `About ${formatTileBytes(usage)} stored of roughly `
      + `${formatTileBytes(quota)} available${share >= 1 ? ` (${share}%)` : ''}.`;
  } catch {
    node.textContent = '';
  }
}

/** One saved region: what it covers, what it costs, and what you can do to it. */
/**
 * How deep a region can usefully be taken, for the basemap it was saved from.
 *
 * Two ceilings, and the lower one wins. `OFFLINE_MAX_ZOOM` is a judgement about
 * what is worth carrying — each level past it quadruples the tiles to add
 * detail nobody reads on a phone in weather. The archive's own depth is a fact:
 * past it there are no tiles at all.
 *
 * Offering the deeper number was not harmless. Every tile past the archive's
 * depth comes back absent, and absent is reported as "outside the map's
 * coverage" — which reads as a badly drawn region and sends somebody off to
 * redraw it, when the fix is a smaller number in a dropdown they were offered.
 */
function deepestUsefulZoom(region) {
  const basemap = basemapById(region?.basemapId || state.basemapId);
  const fromArchive = basemap?.custom === 'byways' && PROTOMAPS_ARCHIVE;
  return fromArchive ? Math.min(OFFLINE_MAX_ZOOM, PROTOMAPS_MAXZOOM) : OFFLINE_MAX_ZOOM;
}

function regionRow(region, kind) {
  const measure = measureRegion(region, kind);
  const deepest = deepestUsefulZoom(region);

  const zoomSelect = (which, value) => el('select', {
    class: 'region-zoom',
    'aria-label': which === 'minZoom' ? 'Minimum zoom' : 'Maximum zoom',
    onchange: (event) => state.offline.update(region.id, { [which]: Number(event.target.value) }),
    /*
     * A value already saved past the ceiling is still offered, so the control
     * shows what the region actually says rather than silently disagreeing
     * with it. Regions saved before the archive's depth was known are exactly
     * that case.
     */
  }, Array.from({ length: Math.max(deepest, value) + 1 }, (_, zoom) => el('option', {
    value: String(zoom), selected: zoom === value, text: `z${zoom}`,
  })));

  return el('div', {
    class: `region${state.highlightRegion === region.id ? ' is-active' : ''}`,
    onmouseenter: () => { state.highlightRegion = region.id; refreshRegionData(); },
    onmouseleave: () => { state.highlightRegion = ''; refreshRegionData(); },
  }, [
    el('div', { class: 'region-head' }, [
      el('input', {
        class: 'region-name', value: region.name, 'aria-label': 'Region name',
        onchange: (event) => state.offline.update(region.id, { name: event.target.value }),
      }),
      el('button', {
        class: 'icon-button', type: 'button', title: 'Show this region',
        html: icons.target,
        onclick: () => {
          const { west, south, east, north } = region.bounds;
          state.map.fitBounds([[west, south], [east, north]], { padding: 40, duration: 600 });
        },
      }),
      el('button', {
        class: 'icon-button', type: 'button', title: 'Delete this region',
        html: icons.trash,
        onclick: () => {
          state.offline.remove(region.id);
          toast(`Removed “${region.name}”.`);
        },
      }),
    ]),
    el('div', { class: 'region-meta', text: regionBoundsLabel(region.bounds) }),
    region.maxZoom > deepest
      ? el('p', {
        class: 'source-note',
        text: `This map stops at z${deepest}; the levels past it will come back empty.`,
      })
      : null,
    el('div', { class: 'region-controls' }, [
      zoomSelect('minZoom', region.minZoom),
      el('span', { class: 'region-to', text: 'to' }),
      zoomSelect('maxZoom', region.maxZoom),
      el('span', {
        class: `region-cost${measure.overBudget ? ' is-over' : ''}`,
        text: `${measure.tiles.toLocaleString()} tiles · ~${formatTileBytes(measure.bytes)}`,
      }),
    ]),
    el('div', {
      class: 'region-meta',
      text: `${Math.round(measure.area).toLocaleString()} km² · ${region.basemapName || 'no basemap recorded'}`,
    }),
    downloadRow(region),
  ]);
}

/**
 * Actually fetching a region, for the basemaps whose tiles we may keep.
 *
 * Not every basemap can do this, and the row says which and why rather than
 * offering a button that fails. Mapbox reserve offline storage of their tiles
 * to their own SDK's offline API, and this is Mapbox GL JS in a webview - so
 * on a Mapbox basemap the honest thing is to say so and name one that works.
 */
function downloadRow(region) {
  const basemap = basemapById(state.basemapId);
  /*
   * A basemap that renders from a vector style cannot be downloaded, and its
   * `tiles` are not a substitute for it.
   *
   * Byways Topo draws from Mapbox vector tiles when there is a token. Its
   * `tiles` array is CyclOSM - a no-token fallback, the same idea drawn by
   * somebody else - so downloading "Byways Topo" fetched a different map from
   * the one on screen and would have gone offline showing it. That is worse
   * than refusing: a download that quietly substitutes another cartographer's
   * rendering is a download you cannot trust in a canyon.
   *
   * Mapbox's own tiles are excluded on licensing grounds and CyclOSM's on
   * courtesy, so there is nothing left to fetch for this basemap either way.
   */
  const rendersVector = Boolean(basemap?.style || basemap?.custom === 'byways' || basemap?.custom === 'byways-mapbox');
  const templates = rendersVector ? [] : (basemap?.tiles || []).filter(mayCacheTiles);

  /*
   * Except when it draws from our own archive, which is the whole reason for
   * having one.
   *
   * An archive has no tile URLs to cache - it is one file read by byte range -
   * so this download goes through a different path entirely, reading the
   * region out of the archive and keeping the tile bodies. Same regions, same
   * counts, same progress line; a person watching should not be able to tell
   * which one is running.
   */
  const archiveURL = basemap?.custom === 'byways' && PROTOMAPS_ARCHIVE ? PROTOMAPS_ARCHIVE : '';

  // Whatever is switched on over it, so the download matches the map you are
  // actually looking at rather than the ground under it.
  const overlayTemplates = activeOverlays()
    .flatMap((overlay) => overlay.tiles || [])
    .filter(mayCacheTiles);

  const row = el('div', { class: 'region-download' });

  /*
   * Two different stores, so two different questions.
   *
   * Raster tiles go into the Cache API; archive tiles go into IndexedDB,
   * because the Cache API refuses to store a 206 at all. Asking only about
   * `caches` told somebody with IndexedDB and no Cache Storage that their
   * browser could not download a map it could in fact download perfectly well.
   */
  const canCacheTiles = Boolean(globalThis.caches);
  const canStoreArchive = Boolean(globalThis.indexedDB);
  if (!canCacheTiles && !(archiveURL && canStoreArchive)) {
    row.append(el('p', { class: 'source-note', text: 'This browser cannot store map tiles offline.' }));
    return row;
  }
  if (!templates.length && !overlayTemplates.length && !archiveURL) {
    row.append(el('p', {
      class: 'source-note',
      text: rendersVector
        ? `${basemap.name} draws from Mapbox vector tiles, which this app cannot store offline — `
          + 'Mapbox allow that only through their native mobile toolkit, not on the web. '
          + 'Switch to USGS Topo, an aerial or another raster map, and this region will download.'
        : 'This basemap cannot be stored offline by this app.',
    }));
    return row;
  }

  const status = el('p', { class: 'source-note', text: '' });
  let controller = null;

  // What is about to be fetched, named, because "download" over a map you did
  // not realise was switched on is a surprise on a metered connection.
  const covering = [
    templates.length || archiveURL ? basemap.name : null,
    overlayTemplates.length
      ? `${activeOverlays().filter((o) => (o.tiles || []).some(mayCacheTiles)).length} layer(s) on top`
      : null,
  ].filter(Boolean).join(' + ');
  row.append(el('p', { class: 'source-note', text: `Will store: ${covering}.` }));

  const button = el('button', {
    class: 'button button-secondary button-small', type: 'button',
    text: 'Download for offline',
    onclick: async () => {
      if (controller) { controller.abort(); return; }
      controller = new AbortController();
      button.textContent = 'Stop';

      const tiers = [{ zoom: region.minZoom, boxes: [region.bounds] }];
      for (let zoom = region.minZoom + 1; zoom <= region.maxZoom; zoom += 1) {
        tiers.push({ zoom, boxes: [region.bounds] });
      }
      const urls = tileURLsFor(tiers, [...templates, ...overlayTemplates], tileURL);
      const archiveTiles = archiveURL ? tileKeysFor(tiers) : [];
      const total = urls.length + archiveTiles.length;
      status.textContent = `0 of ${total.toLocaleString()}…`;

      const progress = (offset) => (done, failed) => {
        status.textContent = `${(offset + done).toLocaleString()} of ${total.toLocaleString()}`
          + `${failed ? ` · ${failed.toLocaleString()} unavailable` : ''}`;
      };

      try {
        const result = archiveTiles.length
          ? await downloadArchiveTiles(archiveTiles, {
            archive: new PMTilesArchive(new URL(archiveURL, document.baseURI).href),
            store: await openTileStore(),
            name: new URL(archiveURL, document.baseURI).href,
            signal: controller.signal,
            onProgress: progress(0),
          })
          : { done: 0, failed: 0, cancelled: false };

        /*
         * The overlays on top, which are ordinary raster tiles whichever
         * basemap is underneath. Skipped when the archive run was stopped:
         * carrying on downloading after somebody pressed Stop is the one thing
         * a Stop button must not do.
         */
        const overlays = urls.length && !result.cancelled
          ? await downloadTiles(urls, {
            signal: controller.signal,
            onProgress: progress(result.done),
          })
          : { done: 0, failed: 0, cancelled: false };
        result.done += overlays.done;
        result.failed += overlays.failed;
        result.cancelled = result.cancelled || overlays.cancelled;
        /*
         * Said differently depending on what happened, because "done" over a
         * download that skipped a fifth of its tiles is the kind of reassurance
         * that gets found out on a mountain with no signal.
         */
        if (result.cancelled) {
          status.textContent = `Stopped. ${result.done.toLocaleString()} tiles kept.`;
        } else if (result.failed) {
          status.textContent = `${result.done.toLocaleString()} saved, `
            + `${result.failed.toLocaleString()} not available from the service.`;
        } else if (result.absent) {
          /*
           * Said separately from a failure, because it is not one. A region
           * drawn over the edge of an archive asks for tiles that do not
           * exist, and calling those unavailable reads as something broken
           * rather than as ground the map does not cover.
           */
          status.textContent = `${result.done.toLocaleString()} tiles saved. `
            + `${result.absent.toLocaleString()} of this region is outside the map's coverage.`;
        } else {
          status.textContent = `${result.done.toLocaleString()} tiles saved. This region works offline.`;
        }
        if (archiveTiles.length && !result.cancelled) stampArchive(region, archiveURL);
      } catch (error) {
        status.textContent = error.message || 'The download could not start.';
      } finally {
        controller = null;
        button.textContent = 'Download for offline';
      }
    },
  });

  row.append(el('div', { class: 'region-controls' }, [button, status]));
  return row;
}

/*
 * Which archive a region's tiles came out of, recorded on the region.
 *
 * The store keys a tile by the archive's URL, and that URL is deliberately
 * stable across re-cuts so a download survives the switch to a bucket. The
 * cost of that stability is this: when the archive behind the URL is cut
 * deeper, every tile already on the device is from the old one, still matches
 * the key, and is served in preference to the network - silently, and exactly
 * as the reader is meant to behave.
 *
 * So the depth is stamped alongside the name. Nothing else in the pipeline
 * distinguishes one generation of an archive from the next, and the depth is
 * the one number that changes when it is re-cut for a reason anybody would
 * notice.
 */
function stampArchive(region, archiveURL) {
  const name = new URL(archiveURL, document.baseURI).href;
  state.offline.update(region.id, { archive: name, archiveDepth: PROTOMAPS_MAXZOOM });
}

/**
 * Whether a region's stored tiles predate the archive the map now reads.
 *
 * Returns the reason rather than a boolean, because the two reasons need
 * different words: an archive that moved leaves tiles that are unreachable and
 * merely wasting space, while an archive re-cut in place leaves tiles that are
 * reachable, wrong, and preferred over the network.
 *
 * A region with no stamp is not stale - it is one that was never downloaded,
 * or was downloaded before this was recorded, and calling either out of date
 * would send somebody re-downloading ground they already have.
 */
function archiveDrift(region, current) {
  if (!region?.archive || !current) return '';
  if (region.archive !== current) return 'moved';
  if (Number(region.archiveDepth) !== Number(PROTOMAPS_MAXZOOM)) return 'recut';
  return '';
}

/**
 * One layer row: control, name, and an info button that reveals the
 * description.
 *
 * The descriptions were previously always visible, which on a phone turned
 * every layer into a three-line paragraph and made the list unscannable. They
 * are worth keeping — they are how you tell USGS Topo from Esri Topo — so they
 * fold away behind (i) rather than being deleted.
 */
function layerRow({ entry, selected, control, preview = false }) {
  /*
   * Byways Topo says whether it can be taken with you.
   *
   * Its own description cannot: "OSM rendered for the outdoors" is equally
   * true of Mapbox Streets, of our own archive and of the CyclOSM fallback,
   * since all three are OpenStreetMap underneath. The difference between them
   * that a reader can act on is whether the map downloads, and an editor also
   * gets to see which source is live, because they are the one comparing.
   */
  const sourceNote = sourceNoteFor(entry, { editor: mayEdit(state.account?.user) });
  const description = [entry.description || '', sourceNote].filter(Boolean).join(' ');
  const key = Array.isArray(entry.legend) && entry.legend.length ? entry.legend : null;

  // A continuous ramp — temperature, wind speed, cloud cover — has no list of
  // colours to write out, so those layers carry the service's own legend image
  // instead. Drawn on white because every one of them is black text on
  // transparent, which disappears against a dark panel.
  const note = entry.legendNote || '';

  /*
   * A layer with a scale explains itself with the scale.
   *
   * The prose above it was written when the alternative was an unlabelled
   * ramp, and now restates what the swatches already say — "forecast air
   * temperature" over a column reading -40 to 110. So a layer carrying a
   * fetched scale shows the scale alone, and the descriptions that say
   * something the colours cannot are kept in the catalogue rather than here.
   */
  const scaleHost = entry.legendScale ? el('div', { class: 'legend-slot' }) : null;
  if (scaleHost) fillWMSLegend(scaleHost, entry.legendScale);

  /*
   * The same thing for the services that publish their key as ArcGIS JSON.
   *
   * Three layers — BLM routes, the MVUM and the recreation sites — have
   * carried a `legendJSON` since they were added, and nothing read it. The
   * fetcher for it existed and was never called, so those rows showed their
   * note and no key at all, which looks exactly like a service that answered
   * with nothing.
   */
  const serviceHost = entry.legendJSON ? el('div', { class: 'legend-slot' }) : null;
  if (serviceHost) fillArcGISLegend(serviceHost, entry.legendJSON);

  /*
   * A key made of the symbols themselves.
   *
   * For a layer drawn as icons, a list of coloured squares explains nothing —
   * the reader has to hold a colour in their head and go hunting. Showing the
   * glyph at the size it appears on the map is the whole answer to "I am not
   * sure what some of these are".
   *
   * Built from the same `points` list the layer draws from, so the key cannot
   * describe a symbol the map does not use.
   */
  const symbolKey = entry.query?.points
    ? el('ul', { class: 'legend is-symbols' }, dedupeByIcon(entry.query.points).map((kind) => el('li', {
      class: 'legend-item',
    }, [
      el('span', { class: 'legend-symbol', html: npsIconSVG(kind.icon) }),
      el('span', { text: kind.label }),
    ])))
    : null;

  const descriptionNode = description || key || note || scaleHost || serviceHost || symbolKey || entry.legendImage
    ? el('div', { class: 'layer-desc', hidden: true }, [
      description && !scaleHost ? el('p', { class: 'layer-desc-text', text: description }) : null,
      key ? legendList(key, note) : null,
      symbolKey,
      serviceHost,
      !key && note ? el('p', { class: 'legend-note', text: note }) : null,
      scaleHost,
      entry.legendImage
        ? el('div', { class: 'legend-image-wrap' }, [
          el('img', {
            class: 'legend-image', src: entry.legendImage, loading: 'lazy',
            alt: `Color key for ${entry.name}`,
            // A key that cannot be fetched leaves a broken-image box where an
            // explanation should be, which is worse than no key at all.
            onerror: (event) => event.currentTarget.closest('.legend-image-wrap')?.remove(),
          }),
        ])
        : null,
    ])
    : null;

  // Hover reveals on a mouse; tap pins it open on touch, where hover does not
  // exist. `pinned` keeps a clicked description open when the pointer leaves.
  let pinned = false;
  const setOpen = (open) => {
    descriptionNode.hidden = !open;
    info.setAttribute('aria-expanded', String(open));
    info.classList.toggle('is-open', open);
  };

  const info = descriptionNode
    ? el('button', {
      class: 'layer-info', type: 'button',
      'aria-expanded': 'false', 'aria-label': key ? `About ${entry.name}, with color key` : `About ${entry.name}`,
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 16.5v-5"/><path d="M12 8h.01"/></svg>',
      onpointerenter: (event) => { if (event.pointerType === 'mouse' && !pinned) setOpen(true); },
      onpointerleave: (event) => { if (event.pointerType === 'mouse' && !pinned) setOpen(false); },
      onfocus: () => { if (!pinned) setOpen(true); },
      onblur: () => { if (!pinned) setOpen(false); },
      onclick: () => { pinned = !pinned; setOpen(pinned); },
    })
    : null;

  const row = el('div', { class: `layer-row${selected ? ' is-selected' : ''}` }, [
    el('label', { class: 'layer-option' }, [
      control,
      preview ? basemapThumb(entry) : null,
      el('span', { class: 'layer-option-name' }, [
        // The id on the label, so a test can ask which layers are on offer
        // rather than matching on names that are meant to change.
        el('span', { class: 'layer-option-label', dataset: { layer: entry.id }, text: layerName(entry) }),
        layerBadge(entry),
      ]),
    ]),
    info,
  ]);

  /*
   * One element per layer, always - not a bare row and sometimes a fragment.
   *
   * A row, its description and its opacity slider are one thing on screen and
   * have to be one thing in the DOM before the list can be laid out in
   * columns; as siblings they would be placed in separate cells and a
   * description would open under someone else's layer.
   */
  return el('div', { class: 'layer-item' }, descriptionNode ? [row, descriptionNode] : [row]);
}

/**
 * One tile of a basemap, beside its name.
 *
 * Nine names — USGS Topo, USGS Topo (classic), USGS Imagery + Topo, Esri
 * imagery — say almost nothing about which one you want. One tile says it
 * immediately, and taken from the current centre it says it about the place you
 * are actually looking at rather than a fixed corner of Tennessee.
 */
function basemapThumb(entry) {
  const centre = state.map?.getCenter?.();
  const source = previewFor(entry, {
    lon: centre?.lng ?? -84.28,
    lat: centre?.lat ?? 35.96,
    zoom: state.map?.getZoom?.() ?? 10,
    token: mapboxToken(),
  });
  if (!source) return null;

  if (source.kind === 'swatch') {
    return el('span', {
      class: 'layer-thumb is-drawn',
      html: swatchSVG({
        paper: PALETTE.land,
        contour: PALETTE.contourIndex,
        wood: PALETTE.forest,
        water: PALETTE.water,
        road: PALETTE.usRoute,
      }),
    });
  }

  return el('img', {
    class: 'layer-thumb', src: source.src, alt: '', loading: 'lazy',
    // A thumbnail that will not load leaves a broken-image box in the middle of
    // the list. The name below it is the real label; this is a bonus.
    onerror: (event) => event.currentTarget.remove(),
  });
}

/**
 * Small marker beside a layer name, when its tiles are not arriving.
 *
 * There used to be a second, static badge reading "unverified" — my note that
 * an endpoint had never been confirmed working. It was a guess sitting beside a
 * fact: this one is counted from real tile responses, so it knows. A layer that
 * works shows nothing, and a layer that does not says so in words the reader
 * can act on.
 */
/**
 * What a layer is called in the list, which for a state's own data says which
 * state — "Aerial (3 in) — Kentucky". Near a state line the map can flip
 * between two of these, and a row that did not name its state would look like
 * the same layer behaving differently.
 */
function layerName(entry) {
  if (!entry.states?.length) return entry.name;
  const named = entry.states.map((code) => STATE_NAMES[code] || code).join(', ');
  // Parenthesised rather than dashed: the state qualifies the name, it is not
  // a second half of it, and a column of em-dashes reads as a list of
  // compound titles rather than of layers that happen to be state-scoped.
  return `${entry.name} (${named})`;
}

function layerBadge(entry) {
  if (layerIsBroken(entry.id)) {
    return el('span', {
      class: 'layer-badge is-broken',
      title: 'This layer\u2019s tile server is not responding. The endpoint may have moved — see assets/js/config.js.',
      text: 'not responding',
    });
  }

  /*
   * A zoom floor that says so, instead of an empty map that does not.
   *
   * A queried layer below its floor draws nothing, and nothing looks exactly
   * like a layer that is broken or a place with no data in it. On the drone
   * grid that reading is worse than confusing: an absent cell means Class G,
   * airspace where no authorisation is needed, so a layer silently withholding
   * its cells is a layer quietly saying "you are clear". It has to say which
   * one it means.
   */
  const floor = entry.query?.minzoom;
  if (floor && state.overlays.get(entry.id)?.visible && (state.map?.getZoom?.() ?? 99) < floor) {
    return el('span', {
      class: 'layer-badge is-waiting',
      title: `This layer loads from zoom ${floor}. Below that it asks for more than the service will return in one answer, and a truncated reply would leave gaps that look like open ground.`,
      text: `zoom in to ${floor}`,
    });
  }
  return null;
}

function setBasemap(id) {
  const basemap = basemapById(id);

  /*
   * Switching between the two vector families means switching GL libraries,
   * and that cannot be done under a live map: the two define different `Map`
   * classes, and every source, layer, marker and handler on screen belongs to
   * the one that is loaded.
   *
   * So it reloads. That is cheap and lossless here — the camera lives in the
   * URL hash and the basemap in a query parameter, both already written by
   * this app — and it is honest, where tearing the map down and rebuilding it
   * under a second library would work until one of the several hundred things
   * attached to the old one did not.
   *
   * In practice almost nobody meets this: the Mapbox basemaps are editors-only.
   */
  const needed = engineFor(basemap);
  if (needed && state.engine && needed !== state.engine) {
    const url = new URL(window.location.href);
    url.searchParams.set('b', id);
    window.location.assign(url.toString());
    return;
  }

  state.basemapId = id;
  const next = styleFor(basemap, activeOverlays());
  state.basemapFallback = next.fallback || '';

  // A style swap wipes every source, so the data layers are rebuilt on the other
  // side of 'style.load'. The parsed documents live in memory, so this is cheap.
  //
  // diff:false is load-bearing. By default GL tries to *diff* the two styles and
  // apply the difference, and when that succeeds it never fires 'style.load' —
  // it just removes the layers that are not in the new style, which is all of
  // ours. The rebuild then waits forever on an event that is not coming, and
  // saved pins and imported tracks vanish with the map looking perfectly
  // healthy. Whether the diff succeeds depends on how alike the two styles are,
  // which is why this looked intermittent: raster to raster diffs cleanly,
  // raster to vector does not.
  state.map.setStyle(next.style, { diff: false });
  state.map.once('style.load', () => {
    for (const overlay of activeOverlays()) {
      // Same rule as at startup: baked in for raster, added here otherwise,
      // and a queried overlay is never baked in.
      if (next.vector || overlay.query) addOverlayLayer(overlay);
    }
    addAppLayers();
    for (const entry of state.documents.values()) addDocumentLayers(entry);
    applyVisibility();
    addFolderLayers();
    refreshFolderData();
    refreshRegionData();
    refreshLightLines();
    refreshStormData();
  });
  renderLayersTab();
  // The size estimate depends on whether the new basemap is vector or raster.
  renderOfflineTab();
  writeURL();
}

function firstDataLayerId() {
  if (!styleReady()) return undefined;
  let layers = [];
  try {
    layers = state.map.getStyle()?.layers || [];
  } catch {
    return undefined;
  }
  const found = layers.find((layer) => layer.id.startsWith('data-') || /-line-casing$|-fill$|^scratch-/.test(layer.id));
  return found?.id;
}

/**
 * An overlay whose data is fetched for the view rather than served as tiles.
 *
 * Some of the most useful data is published as an ArcGIS feature service and
 * nothing else — fire perimeters are the case that forced this. A feature
 * service will not draw an image at any price; asking one for `f=image`, which
 * is what this layer used to do, returns "Bad Request" and therefore a switch
 * that does nothing. It will hand over GeoJSON for a bounding box, which is a
 * better answer anyway: the shapes come with their names attached.
 *
 * Two consequences follow and both are handled here. The data depends on where
 * the map is looking, so it is re-fetched when the map stops moving; and a
 * national view of every fire in the country is both illegible and an unkind
 * thing to ask of somebody's server, so it has a minimum zoom.
 */
function queryURL(template, map, where = '') {
  const bounds = map.getBounds();
  const box = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
    .map((value) => value.toFixed(4)).join(',');
  return template
    .replace('{bbox}', encodeURIComponent(box))
    /*
     * `1=1` when nobody asked for anything narrower, which is what every URL
     * in the config said literally before one of them needed a filter. A
     * template without the placeholder is left alone, so this is invisible to
     * the thirty-odd layers that do not use it.
     */
    .replace('{where}', encodeURIComponent(where || '1=1'));
}

async function refreshQueryOverlay(overlay) {
  const [fill] = overlayLayerIds(overlay);
  const source = state.map?.getSource?.(fill);
  if (!source) return;

  const { minzoom = 0, url, points } = overlay.query;
  const empty = { type: 'FeatureCollection', features: [] };
  if ((state.map.getZoom?.() ?? 0) < minzoom) { source.setData(empty); return; }

  if (points) { await refreshPointOverlay(overlay, source, empty); return; }
  if (overlay.query.uses) { await refreshUseOverlay(overlay, source, empty); return; }

  try {
    const response = await fetch(queryURL(url, state.map));
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    // An ArcGIS error is a 200 with an `error` object in it, which parses
    // cleanly and has no features — worth telling apart from an empty view.
    if (data.error) throw new Error(data.error.message || 'service error');
    source.setData(data.type === 'FeatureCollection' ? data : empty);
    // The same health counter the tile layers feed, so a queried layer that
    // stops answering gets the same "not responding" badge rather than
    // silently showing an empty map.
    noteLayerHealth(overlayLayerIds(overlay)[0], true);
  } catch {
    noteLayerHealth(overlayLayerIds(overlay)[0], false);
  }
}

/**
 * Several sublayers, one layer of lines, each carrying what it is for.
 *
 * Kentucky splits its trails by who may travel them - federal hiking, federal
 * ATV, KDFWR horse, state park - across twelve endpoints. The agency's own
 * raster drew each in its own colour and its own dash pattern, which is where
 * the mixture of dashed and solid lines came from; none of it was reachable
 * from outside the picture.
 *
 * Merging them and tagging each feature with its use puts the distinction in a
 * column, where a single match expression can colour by it and a key can name
 * six things instead of six hundred. The same shape as the points path above,
 * for the same reason: the sublayer that answered is the fact, decided before
 * the data arrives rather than read out of a code table.
 *
 * Twelve requests is not free, which is why these layers carry a higher zoom
 * floor than the rest.
 */
async function refreshUseOverlay(overlay, source, empty) {
  const { url, uses } = overlay.query;

  const answers = await Promise.all(uses.map(async (kind) => {
    try {
      /*
       * A sublayer may bring its own address and its own tags.
       *
       * Kentucky's twelve trail endpoints differ only by a number in one URL,
       * which is what `{layer}` is for. Flight restrictions are three agencies
       * on three hosts saying related things, so an entry can carry a whole
       * URL instead - and `tag` lets it carry more than its name, which is how
       * a park and a prohibited area end up in one layer while still being
       * told apart by how serious each is.
       */
      const target = kind.url || url.replace('{layer}', String(kind.layer));
      /*
       * And a sublayer may narrow what it asks for.
       *
       * Special-use airspace is one service holding prohibitions and
       * advisories together, and 46.6% of it is military operating areas that
       * restrict nothing. Filtering on the server rather than after the fetch
       * because the layer caps at 300 records: drop them here and the cap is
       * spent on polygons that get thrown away, so a busy view would lose real
       * restrictions to make room for warnings that do not apply.
       */
      const response = await fetch(queryURL(target, state.map, kind.where));
      if (!response.ok) return [];
      const data = await response.json();
      if (data.error || !Array.isArray(data.features)) return [];
      return data.features.map((feature) => ({
        ...feature,
        properties: { ...feature.properties, use: kind.use, ...(kind.tag || {}) },
      }));
    } catch {
      return [];
    }
  }));

  const features = answers.flat();
  source.setData(features.length ? { type: 'FeatureCollection', features } : empty);
  // Every sublayer failing is a broken layer; some failing is a quiet view.
  noteLayerHealth(overlayLayerIds(overlay)[0], answers.some((answer) => answer.length) || !features.length);
}

/**
 * Several sublayers, one layer of icons.
 *
 * USGS splits its structures service by kind of place, so a campground and a
 * picnic area are different endpoints rather than different rows. Asking each
 * and merging is what makes the icon knowable: the sublayer that answered is
 * the type, decided before the data arrives rather than looked up in a code
 * table that can be renumbered.
 *
 * One slow or missing sublayer must not empty the map, so each is settled
 * independently and whatever came back is drawn.
 */
async function refreshPointOverlay(overlay, source, empty) {
  const { url, points } = overlay.query;

  const answers = await Promise.all(points.map(async (kind) => {
    try {
      const target = queryURL(url.replace('{layer}', String(kind.layer)), state.map);
      const response = await fetch(target);
      if (!response.ok) return [];
      const data = await response.json();
      if (data.error || !Array.isArray(data.features)) return [];
      return data.features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          // What the popup and the icon both read. `name` lower-case: ArcGIS
          // GeoJSON output lower-cases field names, and asking for NAME does
          // not change what comes back.
          icon: kind.icon,
          kindLabel: kind.label,
          name: feature.properties?.name || kind.label,
        },
      }));
    } catch {
      return [];
    }
  }));

  const features = answers.flat();
  source.setData(features.length ? { type: 'FeatureCollection', features } : empty);
  noteLayerHealth(overlayLayerIds(overlay)[0], answers.some((list) => list.length > 0));

  // Kept for abmapOverlays(). "No icons" has three causes that look identical
  // on screen — below the zoom floor, the service answered with nothing, or
  // the request failed — and this is what tells them apart.
  lastPointFetch.set(overlay.id, {
    zoom: Number((state.map.getZoom?.() ?? 0).toFixed(1)),
    perLayer: Object.fromEntries(points.map((kind, at) => [kind.label, answers[at].length])),
    total: features.length,
  });
}

/** What the last point query returned, per overlay, for the inspector. */
const lastPointFetch = new Map();

/**
 * A diagonal hatch in a given colour, registered once and reused.
 *
 * Solid fills stack badly. Three state layers over one another - a forest, a
 * hunting area and a park - come out as one muddy colour nobody can read, which
 * is what was reported over New York. Hatching is the cartographic answer and
 * has been since long before screens: the lines of each layer stay visible
 * through the lines of the next, and the boundary line still says where the
 * edge is.
 *
 * Returns null if there is no canvas to draw on, and the caller falls back to a
 * solid fill rather than drawing nothing.
 */
function hatchPattern(colour) {
  const id = `hatch-${String(colour).replace('#', '')}`;
  try {
    if (state.map.hasImage?.(id)) return id;
    const ratio = 2;
    const size = 8 * ratio;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5 * ratio;
    // Three passes so the diagonal meets itself across the tile edge; two
    // leaves a visible seam every eight pixels.
    ctx.beginPath();
    for (const offset of [-size, 0, size]) {
      ctx.moveTo(offset, size);
      ctx.lineTo(offset + size, 0);
    }
    ctx.stroke();

    const { data } = ctx.getImageData(0, 0, size, size);
    state.map.addImage(id, { width: size, height: size, data: new Uint8Array(data) }, { pixelRatio: ratio });
    return id;
  } catch {
    return null;
  }
}

function addQueryOverlay(overlay, opacity) {
  const [fill, casing, line, dot, label] = overlayLayerIds(overlay);
  const colour = overlay.query.color || '#D84315';

  if (overlay.query.points) { addPointOverlay(overlay, fill); return; }

  /*
   * A layer that carries a designation is coloured by it.
   *
   * Ohio publishes every parcel it manages in one layer with a division on
   * each - forestry, parks, wildlife, natural areas - and drawing them all one
   * colour throws away the only thing that separates a state forest from a
   * nature preserve. Soft flat colours suit that better than a hatch, which is
   * what a land-status map does and why it was asked for.
   *
   * Declared out here because the fill, the outline and the label all read it.
   * It was declared inside the fill block first, which threw a ReferenceError
   * in the outline below and emptied the whole overlay - the second time an
   * exception in this function has done that.
   */
  /*
   * Each part added on its own, because a throw here used to cost all of them.
   *
   * Five layers go on one source in sequence. Three separate faults today - an
   * unfiltered circle, a casing width the spec rejects, a const declared below
   * its use - each threw part-way through and left the overlay half built or
   * empty, with nothing on screen and nothing in the log to say which. The
   * layer that fails is the layer that is missing now, and it says so.
   */
  const addPart = (what, spec, beforeId) => {
    if (state.map.getLayer(spec.id)) return;
    try {
      state.map.addLayer(spec, beforeId);
    } catch (error) {
      console.warn(`[overlay ${overlay.id}] the ${what} did not draw:`, error?.message || error);
    }
  };

  const by = overlay.query.fillBy;
  /*
   * The keys are strings because JavaScript object keys always are.
   *
   * A `match` compares like with like: a label of "400" never matches an input
   * of the number 400, so a fillBy over a numeric column - the FAA grid's
   * CEILING in feet - would paint every cell the fallback colour and look for
   * all the world like a colour scheme that had simply been chosen badly.
   * Coercing the input is what makes the two sides comparable.
   */
  const tint = by
    ? ['match', ['coalesce', ['to-string', ['get', by.field]], ''],
      ...Object.entries(by.colors).flatMap(([value, hex]) => [value, hex]), by.fallback || colour]
    : null;


  if (!state.map.getSource(fill)) {
    state.map.addSource(fill, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: overlay.attribution || '',
    });
  }
  if (!state.map.getLayer(fill)) {
    const [, amount] = opacityPaint('fill', opacity);
    /*
     * Hatched per value, not just per layer.
     *
     * `fill-pattern` is data-driven the same way `fill-color` is, so a layer
     * that asks for it gets one diagonal per category rather than one flat
     * wash - which is what makes a red no-fly area and an amber "you would
     * need a permit" legible as different things at a glance rather than as
     * two shades of the same warning.
     *
     * Falls back to the flat tint if any of the patterns failed to register:
     * a `match` naming an image that does not exist draws nothing at all, and
     * an area that silently stops drawing is the worst outcome on this layer.
     */
    let patterned = null;
    if (by?.hatch) {
      const named = Object.entries(by.colors).map(([value, hex]) => [value, hatchPattern(hex)]);
      const fallbackImage = hatchPattern(by.fallback || colour);
      if (fallbackImage && named.every(([, image]) => image)) {
        patterned = ['match', ['coalesce', ['to-string', ['get', by.field]], ''],
          ...named.flat(), fallbackImage];
      }
    }
    const hatch = patterned || (tint ? null : hatchPattern(colour));
    addPart('fill', {
      id: fill,
      type: 'fill',
      source: fill,
      /*
       * Multi-part geometry counts.
       *
       * geometry-type answers MultiPolygon for a feature with more than one
       * ring group, not Polygon, so an equality test drops exactly the
       * features most likely to be a real park - Montana's Missouri Headwaters
       * came back from the service as a MultiPolygon and drew no fill at all.
       */
      filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
      paint: hatch
        // Hatched, so layers stacked on one another stay separable. The
        // outline below is what states the boundary; this only states extent.
        ? { 'fill-pattern': hatch, 'fill-opacity': Math.min(1, amount * 2.2) }
        : { 'fill-color': tint || colour, 'fill-opacity': tint ? Math.min(1, amount * 1.4) : amount },
    }, firstDataLayerId());
  }
  /*
   * A route is drawn the way the basemap draws a road: a pale casing under a
   * coloured core, both widening with zoom.
   *
   * A single 1.4px hairline is close to invisible over wooded terrain, which
   * is where these roads are - reported from the map on Maryland's park and
   * forest roads. The casing is what does the work: it separates the line from
   * whatever green it crosses, which is why every road on every map has one.
   *
   * Areas keep the thin outline. A casing round a county-sized polygon is a
   * heavy border for no gain.
   */
  const road = Boolean(overlay.query.road);
  const trail = Boolean(overlay.query.trail);
  /*
   * The scale is baked into the stops, not applied to the result.
   *
   * The casing was ['*', <interpolate on zoom>, 1.9], which the spec forbids -
   * a zoom expression may only be the top-level input to step or interpolate.
   * addLayer threw, addQueryOverlay aborted before it reached the core line and
   * the dot, and every road layer drew nothing at all. Reported as Maryland
   * having no roads; it was all eight of them, broken by the commit that was
   * meant to make them legible.
   */
  const width = (scale) => ['interpolate', ['linear'], ['zoom'],
    8, 0.9 * scale, 11, 1.6 * scale, 13, 2.6 * scale, 15, 4.2 * scale, 17, 6.5 * scale];

  if ((road || trail) && !state.map.getLayer(casing)) {
    const [, amount] = opacityPaint('line', opacity);
    addPart('road casing', {
      id: casing,
      type: 'line',
      source: fill,
      filter: ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#FFFDF7',
        'line-width': width(trail ? 1.5 : 1.9),
        'line-opacity': amount * 0.9,
      },
    }, firstDataLayerId());
  }

  if (!state.map.getLayer(line)) {
    const [, amount] = opacityPaint('line', opacity);
    addPart('outline', {
      id: line,
      type: 'line',
      source: fill,
      // A line draws a road and the edge of an area; over a point it is noise.
      filter: ['!', ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]]],
      layout: (road || trail)
        ? { 'line-cap': trail ? 'butt' : 'round', 'line-join': 'round' }
        : {},
      paint: {
        'line-color': tint || colour,
        'line-width': road ? width(1) : trail ? width(0.62) : 1.4,
        'line-opacity': amount,
        // A path is dashed on every map that draws one, and a dash cannot be
        // driven by a column - so one pattern for all of them, and the colour
        // carries the use instead.
        ...(trail ? { 'line-dasharray': [2.2, 1.4] } : {}),
      },
    }, firstDataLayerId());
  }

  /*
   * Point geometry, and only point geometry.
   *
   * This layer was added without a filter, on the reasoning that a circle
   * never draws over lines and polygons. That reasoning was wrong: the circle
   * bucket walks every vertex of whatever it is given, so this put a dot on
   * every bend of every road in Maryland and every corner of every boundary -
   * reported from the map twice before the cause was found, because the three
   * layers share one source and nothing in the config says which of them a
   * given service will actually light up.
   *
   * All three are filtered now, so each draws only what it can draw.
   */
  if (!state.map.getLayer(dot)) {
    const [, amount] = opacityPaint('line', opacity);
    /*
     * A named site gets the same pin the recreation layer uses.
     *
     * A campground is a campground whoever published it, and the app already
     * has a pin vocabulary for exactly these things - so a state's campgrounds
     * should not arrive as anonymous dots in a second visual language. A layer
     * naming an icon gets the pin; anything else keeps the dot, which is still
     * the right mark for a facility with no obvious symbol.
     */
    const icon = overlay.query.icon;
    if (icon) {
      registerNPSImages(state.map);
      addPart('site pin', {
        id: dot,
        type: 'symbol',
        source: fill,
        filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
        layout: {
          'icon-image': `nps-${icon}`,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 0.85, 16, 1],
          'icon-allow-overlap': false,
          'icon-anchor': 'bottom',
        },
        paint: { 'icon-opacity': amount },
      }, firstDataLayerId());
    } else {
      addPart('dot', {
        id: dot,
        type: 'circle',
        source: fill,
        filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
        paint: {
          'circle-color': colour,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 12, 5, 16, 7],
          'circle-opacity': amount,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-stroke-opacity': amount * 0.8,
        },
      }, firstDataLayerId());
    }
  }

  /*
   * The name, once per feature.
   *
   * The repetition reported over Hocking - one forest labelled six times -
   * comes from the agency's raster, whose label engine repeats a name across
   * every tile it touches. A symbol layer over the features draws one label
   * per feature and lets the collision detector drop the rest, which is the
   * whole reason to hold the geometry rather than a picture of it.
   *
   * Along the line for a route, so a byway reads like a road label rather than
   * a tag stuck on one end of it.
   */
  if (overlay.query.label && !state.map.getLayer(label)) {
    const [, amount] = opacityPaint('line', opacity);
    addPart('name', {
      id: label,
      type: 'symbol',
      source: fill,
      layout: {
        'text-field': ['coalesce', ['get', overlay.query.label], ''],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 12, 16, 13],
        'symbol-placement': (road || trail) ? 'line' : 'point',
        'text-max-width': (road || trail) ? 20 : 8,
        'text-padding': 6,
        'text-optional': true,
      },
      paint: {
        'text-color': '#33291f',
        'text-halo-color': 'rgba(255,253,247,0.92)',
        'text-halo-width': 1.4,
        'text-opacity': amount,
      },
    });
  }

  refreshQueryOverlay(overlay);
}

/**
 * A queried overlay drawn as icons rather than as shapes.
 *
 * The pin images are already registered for the waypoint editor — a tent, a
 * caravan, a picnic table — so this reuses them rather than inventing a second
 * icon set that would drift out of step with the first.
 */
function addPointOverlay(overlay, layerId) {
  if (!state.map.getSource(layerId)) {
    state.map.addSource(layerId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: overlay.attribution || '',
    });
  }

  if (!state.map.getLayer(layerId)) {
    // The images the icon expression names have to exist before it is asked
    // for them; registering is idempotent, so doing it here costs nothing and
    // removes the ordering question entirely.
    //
    registerNPSImages(state.map);

    state.map.addLayer({
      id: layerId,
      type: 'symbol',
      source: layerId,
      layout: {
        'icon-image': ['concat', 'nps-', ['coalesce', ['get', 'icon'], 'information']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 1],
        'icon-allow-overlap': false,
        // The name only once there is room for it. At the zoom this layer
        // starts, a label on every site is the wall of text this replaced.
        'text-field': ['step', ['zoom'], '', 12, ['get', 'name']],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#3a3026',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.2,
      },
    });
    // Cursor only. The identify card answers for every queried overlay at once,
    // and a second card from this one layer would be the same feature said
    // twice.
    bindFeatureInteractions(layerId, { popup: false });
  }

  refreshQueryOverlay(overlay);
}

/** Re-ask every queried overlay that is switched on, once the map settles. */
function refreshQueryOverlays() {
  for (const overlay of activeOverlays()) {
    if (overlay.query) refreshQueryOverlay(overlay);
  }
}

function addOverlayLayer(overlay) {
  if (!styleReady()) { whenStyleReady(() => addOverlayLayer(overlay)); return; }
  const entry = state.overlays.get(overlay.id);
  const opacity = entry?.opacity ?? overlay.opacity ?? 1;

  if (overlay.query) { addQueryOverlay(overlay, opacity); return; }

  for (const part of overlayParts(overlay)) {
    if (state.map.getLayer(part.layerId)) continue;
    if (!state.map.getSource(part.layerId)) {
      state.map.addSource(part.layerId, {
        type: 'raster',
        tiles: part.tiles,
        tileSize: part.tileSize || 256,
        maxzoom: part.maxzoom || 19,
        attribution: part.attribution || '',
      });
    }
    state.map.addLayer({
      id: part.layerId, type: 'raster', source: part.layerId,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 180 },
    }, firstDataLayerId());
  }
}

/** Every map layer one overlay owns — one for most, several for a combined one. */
function overlayLayerIds(overlay) {
  return overlayParts(overlay).map((part) => part.layerId);
}

function removeOverlayLayer(id) {
  const overlay = OVERLAYS.find((o) => o.id === id);
  for (const layerId of (overlay ? overlayLayerIds(overlay) : [`overlay-${id}`])) {
    if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
    if (state.map.getSource(layerId)) state.map.removeSource(layerId);
  }
}

/* ------------------------------------------------------------------ data layers */

/**
 * Sources and layers the app owns, as opposed to a loaded map file: the
 * selection highlight, the elevation-profile cursor, and the user's folders.
 * Re-run after every style change, which wipes all of them.
 */
function addAppLayers() {
  if (!styleReady()) { whenStyleReady(addAppLayers); return; }
  // Route shields are images the style refers to by name. A style swap discards
  // every registered image, and a layer naming an image that is not there draws
  // nothing and says nothing — so re-register on every style load.
  registerShieldImages(state.map, { state: state.shieldState, base: assetBase() });

  const empty = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  for (const id of runtimeSources()) {
    if (!state.map.getSource(id)) state.map.addSource(id, empty);
  }

  // The definitions live in lib/runtime-layers.js so the validator can read
  // them. Adding them is all that is left here — except for whether the style
  // can carry text at all, which decides if the label layers come with them.
  const labels = styleHasGlyphs(state.map.getStyle());
  for (const layer of runtimeLayers({ labels })) {
    if (!state.map.getLayer(layer.id)) state.map.addLayer(layer);
  }
}

function addDocumentLayers(entry) {
  if (!styleReady()) { whenStyleReady(() => addDocumentLayers(entry)); return; }
  const sourceId = sourceIdFor(entry.key);
  if (!state.map.getSource(sourceId)) {
    state.map.addSource(sourceId, { type: 'geojson', data: entry.doc.geojson });
  }

  const color = ['coalesce', ['get', 'color'], entry.color];
  const [fill, fillLine, casing, line, halo, point] = layerIdsFor(entry.key);

  if (!state.map.getLayer(fill)) {
    state.map.addLayer({
      id: fill, type: 'fill', source: sourceId, filter: IS_POLY,
      paint: { 'fill-color': ['coalesce', ['get', 'fill'], color], 'fill-opacity': 0.22 },
    });
  }
  if (!state.map.getLayer(fillLine)) {
    state.map.addLayer({
      id: fillLine, type: 'line', source: sourceId, filter: IS_POLY,
      paint: { 'line-color': color, 'line-width': 1.8 },
    });
  }
  if (!state.map.getLayer(casing)) {
    // A light casing keeps the track readable over both imagery and topo.
    state.map.addLayer({
      id: casing, type: 'line', source: sourceId, filter: IS_LINE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(255,255,255,0.85)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 7.5, 16, 10],
      },
    });
  }
  if (!state.map.getLayer(line)) {
    state.map.addLayer({
      id: line, type: 'line', source: sourceId, filter: IS_LINE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 4, 16, 6],
      },
    });
  }
  if (!state.map.getLayer(halo)) {
    state.map.addLayer({
      id: halo, type: 'circle', source: sourceId, filter: IS_POINT,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5.5, 15, 9],
        'circle-color': 'rgba(255,255,255,0.95)',
      },
    });
  }
  if (!state.map.getLayer(point)) {
    state.map.addLayer({
      id: point, type: 'circle', source: sourceId, filter: IS_POINT,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.2, 15, 5.5],
        'circle-color': color,
      },
    });
    bindFeatureInteractions(point);
  }
  if (!entry.bound) {
    bindFeatureInteractions(line);
    bindFeatureInteractions(fillLine);
    entry.bound = true;
  }
  // The user's own saved points belong on top of whatever file was just loaded.
  raiseFolderLayers();
}

function removeDocumentLayers(key) {
  for (const id of layerIdsFor(key)) if (state.map.getLayer(id)) state.map.removeLayer(id);
  const sourceId = sourceIdFor(key);
  if (state.map.getSource(sourceId)) state.map.removeSource(sourceId);
}

function applyVisibility() {
  if (!styleReady()) { whenStyleReady(applyVisibility); return; }
  for (const entry of state.documents.values()) {
    const visibility = entry.visible ? 'visible' : 'none';
    for (const id of layerIdsFor(entry.key)) {
      if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}

/**
 * Say something for a moment, using the status line already on the page.
 *
 * `setStatus` only renders its text while busy is true, so a failure passed to
 * it with false is silent — which is how a message that was written to be read
 * ends up never appearing.
 */
function briefly(text, ms = 4000) {
  setStatus(true, text);
  setTimeout(() => setStatus(false), ms);
}

/**
 * Save what is on screen as a picture.
 *
 * The cheapest offline there is: the tiles are already rendered and paid for,
 * so writing the canvas to a PNG costs nothing further — no further tile
 * requests, no token, and it works on a phone with the radio off. It is not a
 * map, it cannot be panned or zoomed, and that is the trade: for a trailhead
 * you will look at twice it is the right one.
 *
 * The name carries the place and the zoom, because a folder of screenshots
 * called map-1.png through map-9.png is not a record of anything.
 */
async function saveMapImage() {
  const canvas = state.map?.getCanvas?.();
  if (!canvas) return;

  const centre = state.map.getCenter();
  const stamp = [
    'byways',
    `${centre.lat.toFixed(4)}_${centre.lng.toFixed(4)}`,
    `z${state.map.getZoom().toFixed(1)}`,
  ].join('-');

  try {
    /*
     * Drawn once more before it is read.
     *
     * Even with preserveDrawingBuffer the buffer holds whatever was last
     * painted, and if the map settled a while ago that can be a frame from
     * before the last layer finished. Forcing a repaint first is the difference
     * between a picture of the map and a picture of the map as it was.
     */
    state.map.triggerRepaint?.();
    const blob = await new Promise((resolve) => {
      // toBlob rather than toDataURL: the same pixels without building a
      // base64 string of them first, which on a retina phone is several
      // megabytes of text held in memory for no reason.
      if (canvas.toBlob) canvas.toBlob(resolve, 'image/png');
      else resolve(null);
    });
    if (!blob || blob.size < 2000) {
      // A blank buffer comes back as a valid but tiny image rather than as an
      // error, so size is the only signal that the capture failed.
      briefly('The map could not be captured on this device.');
      return;
    }

    /*
     * Kept as well as handed over.
     *
     * Sharing puts it in the phone's photo library, which is where it belongs
     * and is also where it becomes indistinguishable from four hundred other
     * pictures. Keeping a copy here means the map can list it beside the
     * ground it is a picture of, and - the part that matters on a trip - it
     * survives having no signal, because it never needed one.
     *
     * Storing first, so a share the person cancels still leaves them the
     * picture. Never fatal: a full disk must not lose the share.
     */
    let kept = null;
    try {
      kept = await putPhoto(blob, {
        source: SNAPSHOT_SOURCE,
        name: `${stamp}.png`,
        caption: `${centre.lat.toFixed(4)}, ${centre.lng.toFixed(4)} · z${state.map.getZoom().toFixed(1)}`,
      });
      renderFoldersTab();
    } catch (error) {
      console.warn('[map] the picture could not be kept on this device:', error.message);
    }

    const how = await saveBlob(blob, `${stamp}.png`);
    if (how === 'shared') briefly('Picture ready to share.');
    else if (how === 'downloaded') briefly('Picture saved.');
    else if (how === 'cancelled' && kept) briefly('Kept in Folders.');
  } catch {
    // A cross-origin tile taints the canvas and makes toDataURL throw. Every
    // source in the catalogue is checked for CORS by tools/check-layers.mjs
    // precisely so this does not happen, but a user-added one might not be.
    briefly('A map source would not allow the image to be saved.');
  }
}

/* ------------------------------------------------------------------ interactions */

/**
 * Make a layer answer to the pointer.
 *
 * `popup` is a choice because two things want to answer the same tap. A layer
 * that carries the reader's own data - a pin they saved, a track they opened -
 * is the whole answer, and its card is the right one. A queried overlay is
 * not: it is one agency's opinion among several under the same finger, and the
 * identify card exists precisely to gather all of them.
 *
 * With both, a tap on a trailhead opened two cards over each other saying the
 * same thing in different words, one of which had the save button. Which is
 * what got reported, and it reads as the map arguing with itself.
 */
function bindFeatureInteractions(layerId, { popup = true } = {}) {
  state.interactiveLayers.add(layerId);
  state.map.on('mouseenter', layerId, () => { state.map.getCanvas().style.cursor = 'pointer'; });
  state.map.on('mouseleave', layerId, () => { state.map.getCanvas().style.cursor = ''; });
  if (!popup) return;
  state.map.on('click', layerId, (event) => {
    const feature = event.features?.[0];
    if (feature) showFeaturePopup(feature, event.lngLat);
  });
}

/**
 * Clicking bare map drops a pin there.
 *
 * The gap this fills: everything the app knew about a place, it knew because
 * that place was already a waypoint in a file you imported. But most of the
 * time you are looking at a spot on the map — a pullout, a bend in a creek, a
 * gap in the trees — and want to know where it is and keep it. This makes any
 * point on the map answerable and savable without importing anything.
 *
 * Bound to the map rather than to a layer, so it fires anywhere; a click that
 * landed on an existing feature is left to that feature's own handler.
 */
function wireMapClicks() {
  state.map.on('click', (event) => {
    /*
     * Armed by the probe button, and disarmed by using it.
     *
     * One shot rather than a mode you can forget you are in: the next tap
     * answers a question, and the one after that drops a pin as always.
     */
    /*
     * A mode rather than a one-shot, now that it is the default: you look at
     * one road, then the one it joins, then the one after that. Switching it
     * off after every answer would mean re-arming between each.
     */
    if (state.probing) {
      probePoint([event.lngLat.lng, event.lngLat.lat], tapTolerance(event));
      return;
    }

    const live = [...state.interactiveLayers].filter((id) => state.map.getLayer(id));
    const hits = live.length ? state.map.queryRenderedFeatures(event.point, { layers: live }) : [];
    if (hits.length) return;   // a saved pin or track owns this click
    showDropPin([event.lngLat.lng, event.lngLat.lat]);
  });
}

/** The dropped-pin popup: where this is, how high, what the sky is doing. */
function showDropPin(position) {
  state.dropPopup?.remove();

  const content = el('div', { class: 'drop-pin' });
  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: position },
    properties: {
      kind: 'waypoint', name: 'Dropped pin', description: '', icon: DEFAULT_PIN_ICON,
    },
  };

  // Our own close control rather than the engine's corner glyph: 26px,
  // unlabelled, and sitting on top of the title of any pin whose name filled
  // the line.
  const popup = new state.gl.Popup({ closeButton: false, maxWidth: '320px', offset: 12 })
    .setLngLat(position);
  state.dropPopup = popup;

  const nameInput = el('input', {
    class: 'drop-pin-name', value: 'Dropped pin', 'aria-label': 'Name for this pin',
    oninput: (event) => { feature.properties.name = event.target.value.trim() || 'Dropped pin'; },
  });

  const coords = formatDD(position);
  const weatherLine = el('dd', { text: '…' });

  /*
   * The symbol is picked from a grid of the symbols themselves.
   *
   * It was a <select> of names, which on iOS opens a full-height native wheel
   * listing forty words — and "Plain pin" tells you nothing about what will be
   * on the map. The button shows the current mark; pressing it opens the marks.
   */
  const symbolButton = el('button', {
    class: 'drop-pin-symbol', type: 'button',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
    title: 'Choose a symbol for this pin',
  });
  const symbolGrid = el('div', { class: 'drop-pin-symbols', hidden: true, role: 'group', 'aria-label': 'Symbols' });

  const paintSymbol = () => {
    symbolButton.innerHTML = `${pinIconSVG(feature.properties.icon, { size: 20 })}<span>Symbol</span>`;
  };

  for (const [group, choices] of pinIconGroups()) {
    symbolGrid.append(el('p', { class: 'drop-pin-symbols-group', text: group }));
    symbolGrid.append(el('div', { class: 'drop-pin-symbols-row' }, choices.map((choice) => el('button', {
      class: `drop-pin-symbol-choice${choice.id === feature.properties.icon ? ' is-on' : ''}`,
      type: 'button', title: choice.name, 'aria-label': choice.name,
      html: pinIconSVG(choice.id, { size: 19 }),
      onclick: (event) => {
        feature.properties.icon = choice.id;
        for (const node of symbolGrid.querySelectorAll('.drop-pin-symbol-choice')) {
          node.classList.toggle('is-on', node === event.currentTarget);
        }
        paintSymbol();
        symbolGrid.hidden = true;
        symbolButton.setAttribute('aria-expanded', 'false');
      },
    }))));
  }
  paintSymbol();
  symbolButton.addEventListener('click', () => {
    symbolGrid.hidden = !symbolGrid.hidden;
    symbolButton.setAttribute('aria-expanded', String(!symbolGrid.hidden));
  });

  const noteInput = el('textarea', {
    class: 'drop-pin-note', rows: '2', 'aria-label': 'Field notes for this pin',
    placeholder: 'Field notes…',
    oninput: (event) => { feature.properties.description = event.target.value; },
  });

  content.append(
    nameInput,
    el('dl', { class: 'popup-stats' }, [
      el('dt', { text: 'Coordinates' }),
      el('dd', {}, [
        el('span', { class: 'drop-pin-coords', text: coords }),
        el('button', {
          class: 'icon-button detail-copy', type: 'button', title: 'Copy coordinates',
          html: icons.copy,
          onclick: async (event) => {
            const button = event.currentTarget;
            const ok = await copyText(coords);
            button.classList.toggle('is-done', ok);
            if (ok) setTimeout(() => button.classList.remove('is-done'), 1400);
          },
        }),
      ]),
      el('dt', { text: 'Weather' }), weatherLine,
    ]),
    el('div', { class: 'drop-pin-fields' }, [symbolButton, symbolGrid, noteInput]),
    saveToFolderActions(feature, popup),
    el('div', { class: 'popup-bar' }, [
      labelledButton(icons.info, 'Details', {
        tone: 'ghost', title: 'Everything known about this place',
        onclick: () => { popup.remove(); showPointDetails(position); },
      }),
      labelledButton(icons.close, 'Close', {
        tone: 'ghost', title: 'Close this pin',
        onclick: () => popup.remove(),
      }),
    ]),
  );

  /*
   * Elevation is not here. It is one more line on a card that has to fit over
   * a map on a phone, it is the slowest of the lookups, and the Details tab
   * one button away carries it along with everything else about the point.
   * The forecast stays: it is the reason to drop a pin on a place you have not
   * driven to yet.
   */
  forecast(position).then((result) => {
    if (!result.ok) { weatherLine.textContent = result.reason; return; }
    const now = result.periods[0];
    weatherLine.textContent = `${now.temperature}°${now.unit} · ${now.short}`;
  }).catch(() => { weatherLine.textContent = 'unavailable'; });

  popup.setDOMContent(content).addTo(state.map);
}



/* ------------------------------------------------------------------ identify */

/**
 * How far from the tap a feature still counts as tapped, in screen pixels.
 *
 * Taken from the pointer event rather than from the device, because the device
 * is the wrong question: an iPad with a trackpad, a phone with a mouse and a
 * stylus on a touchscreen all break "is this a touch device". The event knows
 * what made it — and `width`/`height` are the real contact patch, so a thumb
 * gets more room than a fingertip.
 *
 * A road line is drawn two or three pixels wide. Asking for it within five
 * pixels of a mouse pointer is generous; asking within five of a finger is
 * asking somebody to hit a hair.
 */
function tapTolerance(event) {
  const source = event?.originalEvent || event;
  const kind = source?.pointerType || '';
  const patch = Math.max(source?.width || 0, source?.height || 0);

  if (kind === 'mouse') return 5;
  if (kind === 'pen') return 8;
  if (kind === 'touch') {
    // Chrome reports 1x1 for a synthetic touch and Safari has reported the
    // full finger box; clamp so neither extreme decides the answer.
    return Math.round(Math.min(30, Math.max(18, patch / 2 || 22)));
  }
  // No pointer information at all — a keyboard activation, or an older engine.
  return 12;
}

/** The overlays that are switched on AND can answer a question about a point. */
function identifiableOverlays() {
  return OVERLAYS.filter((entry) => entry.identify && state.overlays.get(entry.id)?.visible);
}

/**
 * Ask one ArcGIS service what is under a point.
 *
 * `identify` rather than a spatial query, because it takes a tolerance in
 * screen pixels and the whole problem is that a road is thinner than a finger.
 * It wants the map's own extent and pixel size to convert that tolerance into
 * ground distance, which is why both are passed rather than assumed.
 */
async function identifyAt(entry, position, { tolerance, bounds, size }) {
  const url = `${entry.identify.url}?f=json`
    + `&geometry=${encodeURIComponent(JSON.stringify({ x: position[0], y: position[1] }))}`
    + '&geometryType=esriGeometryPoint&sr=4326'
    + `&layers=${encodeURIComponent(`all:${entry.identify.layers}`)}`
    + `&tolerance=${tolerance}`
    + `&mapExtent=${bounds.join(',')}`
    + `&imageDisplay=${size.join(',')}`
    + '&returnGeometry=false';

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${entry.name}: ${response.status}`);
  const body = await response.json();
  return (body?.results || []).map((result) => ({
    source: entry.identify.source || entry.name,
    // For the BLM routes this IS the answer: the service publishes the
    // designation as the sublayer name rather than as a field, so "Roads
    // Managed for Limited Public Motorized Use" arrives here and nowhere else.
    designation: result.layerName || '',
    /*
     * And it is a layer's name, not the feature's, which matters the moment
     * anything wants to name a pin after what was tapped. "Motor Vehicle Use
     * Map: Roads" is a true and useful heading and a terrible name for a place
     * you are trying to find again.
     */
    named: false,
    attributes: result.attributes || {},
    fields: entry.identify.fields || null,
    vehicles: Boolean(entry.identify.vehicles),
  }));
}

/** A field name as a human reads it: SEASONAL_START -> Seasonal start. */
function prettyField(name) {
  const words = String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * An agency's own vocabulary, said the way a person would say it.
 *
 * A named `decode` first, because only the catalogue knows that "yearlong"
 * means open all year rather than restricted all year. Then a generic
 * tidy-up for everything else, so an unlisted value is still readable rather
 * than hidden: strip the leading `NAT - ` style code, and take the shouting
 * out of a name without mangling a reference number.
 */
function humaniseValue(raw, field) {
  const text = String(raw ?? '').trim();
  if (!text) return text;

  const named = field?.decode?.[text.toLowerCase()];
  if (named) return named;

  // "NAT - NATIVE MATERIAL" is a code and its own expansion. Keep the words.
  const expanded = /^[A-Z0-9]{1,6}\s+-\s+(.+)$/.exec(text);
  const body = expanded ? expanded[1] : text;

  /*
   * Title case only for text that is plainly a shouted phrase — letters,
   * spaces and the punctuation names carry. A reference like
   * DOI-BLM-NV-L000-2008-0001-RMP-EIS is also all capitals and title-casing it
   * would be vandalism, so it is left exactly as published.
   */
  if (!/^[A-Z][A-Z\s.'’-]*$/.test(body) || !/[A-Z]{2}/.test(body)) return body;
  return body.toLowerCase().replace(/(^|[\s.'’-])([a-z])/g, (all, edge, letter) => edge + letter.toUpperCase());
}

/** Values ArcGIS uses for "nothing here", which are not worth a row. */
const EMPTY_VALUES = new Set(['', 'null', 'Null', 'NULL', '<Null>', 'N/A', 'na', ' ']);

/**
 * The MVUM's vehicle columns, folded into one readable block.
 *
 * The schema is a column per class — `motorcycle`, `otherwheeled_ohv`,
 * `tracked_ohv_lt50inches` — each with a `<class>_datesopen` beside it. Listed
 * raw that is a dozen rows of "Yes"; paired up it is the answer to the only
 * question anybody taps a forest road to ask.
 */
function vehicleClasses(attributes) {
  const open = [];
  let total = 0;
  for (const [name, value] of Object.entries(attributes)) {
    if (/_datesopen$/i.test(name)) continue;
    const dates = attributes[`${name}_datesopen`] ?? attributes[`${name}_DATESOPEN`];
    // No `_datesopen` sibling means this is not a vehicle column at all.
    if (dates === undefined) continue;
    total += 1;

    const allowed = String(value ?? '').trim();
    // The service writes the class name itself when open and leaves it empty
    // when not, so anything present and not a plain no counts.
    if (!allowed || /^(no|n|0|closed)$/i.test(allowed)) continue;

    const when = String(dates ?? '').trim();
    open.push(prettyField(name) + (when && !/^01\/01.*12\/31$/.test(when) ? ` (${when})` : ''));
  }
  return { open, total };
}

function attributeRows(result) {
  // The basemap's own features come with their rows already chosen: there is
  // no service schema to order them by, and a vector tile's columns are not
  // the agency columns the rest of this function is built around.
  if (result.rows) return result.rows;

  const entries = Object.entries(result.attributes)
    .filter(([name, value]) => {
      if (/^(objectid|shape|globalid|fid)/i.test(name)) return false;
      return !EMPTY_VALUES.has(String(value ?? '').trim());
    });

  // A curated order when the catalogue names one, so the two fields anybody
  // actually wants — when it is open, and to what — are not row nineteen.
  if (result.fields?.length) {
    const wanted = [];
    for (const field of result.fields) {
      const hit = entries.find(([name]) => name.toLowerCase() === field.name.toLowerCase());
      if (hit) wanted.push([field.label || prettyField(hit[0]), humaniseValue(hit[1], field)]);
    }
    if (result.vehicles) {
      const classes = vehicleClasses(result.attributes);
      /*
       * Only when the service actually published vehicle columns.
       *
       * A row with none of them is a feature this schema says nothing about —
       * a trail sublayer, say — and printing "Open to: …" against it would be
       * inventing a statement. Silence is the honest output.
       *
       * And when the columns ARE there and none is open, that is not "no
       * restrictions noted": on a Motor Vehicle Use Map the designation IS the
       * permission, so an undesignated route is a closed one. Saying anything
       * softer than that could put somebody down a road they may not drive.
       */
      if (classes.total) {
        wanted.push(['Open to', classes.open.length
          ? classes.open.join(', ')
          : 'no class designated — on an MVUM that means closed to motor vehicles']);
      }
    }
    if (wanted.length) return wanted;
  }
  // Otherwise everything readable, capped: a raw ArcGIS row can be forty
  // columns of internal bookkeeping and a card over a map cannot hold that.
  return entries.slice(0, 10).map(([name, value]) => [prettyField(name), humaniseValue(value)]);
}

/**
 * One card for everything under the tap, grouped by who published it.
 *
 * Both agencies answer in the same words and mean different things by them —
 * "open to all vehicles" is a different legal statement under a Forest Service
 * MVUM than under a BLM travel management plan — so the source is a heading
 * rather than a footnote.
 */
function showIdentifyResults(position, groups, { pending = false } = {}) {
  state.dropPopup?.remove();

  const content = el('div', { class: 'identify-card' });
  const popup = new state.gl.Popup({ closeButton: false, maxWidth: '340px', offset: 12 })
    .setLngLat(position);
  state.dropPopup = popup;

  content.append(el('h3', { class: 'identify-title', text: pending ? 'Looking…' : 'On this spot' }));
  const body = el('div', { class: 'identify-body' });
  content.append(body);

  if (!pending) {
    if (!groups.length) {
      body.append(el('p', {
        class: 'hint',
        text: 'Nothing mapped within reach of that tap. Try a little closer to the line, '
          + 'or switch on a road layer first.',
      }));
    }
    for (const group of groups) {
      const rows = attributeRows(group);
      /*
       * One prominent line per group, always.
       *
       * The card has a small grey caps kicker for the source and a bold line
       * for the thing itself, which reads well when the feature has a name.
       * When it does not - a drone grid cell, a nameless road - the bold line
       * was simply absent and the caps kicker was left doing the naming, so
       * the card went straight from a shouted layer name into a table.
       *
       * So a group with no name of its own promotes its source into the bold
       * slot and drops the kicker: the layer's name is what this is, and it
       * only needs saying once.
       */
      const heading = group.designation || group.source;
      const kicker = group.designation ? group.source : '';
      body.append(el('div', { class: 'identify-group' }, [
        kicker ? el('p', { class: 'identify-source', text: kicker }) : null,
        heading ? el('p', { class: 'identify-designation', text: heading }) : null,
        rows.length
          ? el('dl', { class: 'popup-stats' }, rows.flatMap(([label, value]) => [
            el('dt', { text: label }),
            el('dd', { text: String(value) }),
          ]))
          : null,
        // Where a layer can point at the thing you would do next. The drone
        // grid tells you a flight needs authorising; these are where you go
        // and ask for it.
        group.links?.length
          ? el('div', { class: 'identify-links' }, group.links.map((link) => el('a', {
            class: 'button button-ghost button-small',
            href: link.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: link.label,
          })))
          : null,
      ]));
    }
    // The standing caveat about published layers lagging the agency's own map
    // belongs in a README or an FAQ, not on every card. Noted in
    // docs/state-layers.md until there is somewhere better for it.
  }

  content.append(el('div', { class: 'popup-bar' }, [
    labelledButton(icons.info, 'Details', {
      tone: 'ghost',
      onclick: () => { popup.remove(); showPointDetails(position); },
    }),
    labelledButton(icons.close, 'Close', {
      tone: 'ghost',
      // The mark goes with the card. Left behind it is a dot on the map with
      // nothing on screen saying what it is.
      onclick: () => { popup.remove(); setProbeMark(null); },
    }),
  ]));

  /*
   * And the one action this card was missing.
   *
   * A trailhead used to answer a tap with two cards on top of each other: this
   * one, naming it and listing its attributes, and a second from the overlay's
   * own layer that knew almost nothing about it but had the save button. The
   * reader had to notice that the useful card and the actionable card were
   * different cards.
   *
   * So the save comes here, where the naming already is. Only once the answer
   * has arrived - offering to save "Looking…" would be its own small lie - and
   * only when something was actually found, because a tap on empty ground has
   * nothing to name.
   */
  if (!pending && groups.length) {
    content.append(saveToFolderActions(identifiedFeature(position, groups), popup));
  }

  popup.setDOMContent(content).addTo(state.map);
  return { popup, body };
}

/**
 * A saveable pin for whatever the identify card just named.
 *
 * The card can be showing several agencies' answers for one finger. The name
 * to save under is the first one that has a name of its own — the groups
 * arrive most-specific first, and "Rough Trail Parking Lot" is a better pin
 * than "Recreation". Falling back to the source keeps the pin from being
 * called "Dropped pin" when the card plainly knows better.
 */
function identifiedFeature(position, groups) {
  /*
   * A group that names a thing beats one that names a layer, whatever order
   * they arrived in.
   *
   * The first attempt took the first designation there was, which put
   * "Motor Vehicle Use Map: Roads" on a pin dropped beside a lake the same
   * card had just called Fish Lake. Both strings are correct headings; only
   * one of them is a place.
   */
  const named = groups.find((group) => group.named && group.designation)
    || groups.find((group) => group.designation)
    || groups[0];
  const source = groups.find((group) => group.source)?.source || '';
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [position.lng ?? position[0], position.lat ?? position[1]] },
    properties: {
      kind: 'waypoint',
      name: named?.designation || named?.source || 'Dropped pin',
      description: source && source !== named?.designation ? `From ${source}.` : '',
      icon: DEFAULT_PIN_ICON,
    },
  };
}

/**
 * What the basemap itself knows about a point.
 *
 * The agency layers answer "is this road open"; this answers the question that
 * comes first and far more often — what is that lake called, what is this
 * road, whose park am I standing in. It is already drawn on the screen, so it
 * costs a query against tiles that are in memory and no network at all, which
 * also means it still answers with the radio off.
 *
 * Only what is actually rendered comes back, which is the right rule: if you
 * cannot see it you did not tap it.
 */
function basemapFeatures(position, tolerance) {
  if (typeof state.map?.queryRenderedFeatures !== 'function') return [];

  let found = [];
  try {
    const point = state.map.project(position);
    /*
     * Twice, tight then wide.
     *
     * A finger is worth eighteen to thirty pixels of tolerance, and a box that
     * size over a trailhead returns the bridge, both trails, the preserve, the
     * forest around it and the county - a card nobody reads, and the reason
     * this was reported. Asking at four pixels first answers what was actually
     * under the fingertip; the wide box is the fallback for a tap that lands
     * on nothing, where returning something nearby is better than nothing.
     */
    const box = (radius) => state.map.queryRenderedFeatures([
      [point.x - radius, point.y - radius],
      [point.x + radius, point.y + radius],
    ]) || [];
    const precise = box(Math.min(4, tolerance));
    found = precise.some((feature) => describeMapFeature(feature)) ? precise : box(tolerance);
  } catch {
    // Raster basemaps have nothing to query and some engines throw rather than
    // return nothing. Either way the answer is the same: no vector features.
    return [];
  }

  const seen = new Set();
  const groups = [];
  for (const feature of found) {
    const described = describeMapFeature(feature);
    if (!described) continue;
    const key = `${described.source}:${described.designation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(described);
    // Four is a card. Six was the previous answer and still filled a phone
    // screen with a bridge, two trails, a preserve and a forest.
    if (groups.length >= 4) break;
  }
  return groups;
}

/* What each of the basemap's own source layers is called in words, and which
   of its columns carries the specific kind. */
/**
 * What a Mapbox landuse class can honestly be called.
 *
 * Anything not listed falls through unchanged, because most classes - `wood`,
 * `wetland`, `airport` - already say what they mean.
 */
const LAND_CLASS_LABELS = {
  national_park: 'Park or protected area',
  park: 'Park',
  nature_reserve: 'Nature reserve',
  protected_area: 'Protected area',
  forest: 'Forest',
  wood: 'Woodland',
  grass: 'Grassland',
  scrub: 'Scrub',
  agriculture: 'Farmland',
  cemetery: 'Cemetery',
  glacier: 'Glacier',
  rock: 'Rock',
  sand: 'Sand',
  snow: 'Snow',
  pitch: 'Sports pitch',
  school: 'School grounds',
  hospital: 'Hospital grounds',
};

/**
 * The schema the basemap on screen is drawn from.
 *
 * Everything below that reads a rendered feature has to ask this first. What
 * a source layer is called, which column holds the kind of thing it is, which
 * layer the roads are in — all of it differs between the two foundations, and
 * the identify card used to have Mapbox's answers written into it. Under
 * Protomaps that meant a tap on a road, a trail, a town or a summit answered
 * nothing at all: the layer there is called `roads` and the table only knew
 * `road`. Reported as "I click a trail and there is no data", which is exactly
 * what it did.
 */
const mapSchema = () => schemaFor(basemapById(state.basemapId));

/**
 * A rendered feature from one of our own queried overlays.
 *
 * The identify card was built to read Mapbox's source layers - water, road,
 * landuse - and everything else fell out of it. So every layer converted from
 * a raster to features became clickable in principle and silent in practice:
 * Colorado's facilities, Wyoming's parks, North Carolina's trails, Kentucky's
 * byways. A tap on a byway reported the basemap road beneath it because the
 * byway itself was never a candidate.
 *
 * The name comes from whatever the layer draws its label from, so it is the
 * same string on the map and in the card, and the rows are the columns the
 * query already asks for - minus the plumbing no reader wants.
 */
const PLUMBING = /^(objectid|globalid|fid|shape|se_anno|created_|last_edited|\w*_index|\w*_pk|\w*_sidx)/i;

function describeOverlayFeature(feature) {
  const overlayId = overlayIdFromLayer(feature.layer?.id || '');
  if (!overlayId) return null;
  const overlay = OVERLAYS.find((entry) => entry.id === overlayId);
  if (!overlay) return null;

  const properties = feature.properties || {};
  const labelField = overlay.query?.label;
  const fieldSpecs = overlay.query?.fields;
  /*
   * The heading does not repeat what the rows already say.
   *
   * The drone grid labels its cells with the ceiling, so the card read
   * "DRONE CEILINGS / 150" above a row reading "Ceiling  150 ft AGL" - the
   * same number twice, the second time with its units and the first time
   * looking like the name of something. A label field that is also spelled
   * out below is not a heading.
   *
   * And no fallback to the layer's own name: `source` above it is already the
   * layer's name, so that path only ever produced the title twice.
   */
  const named = (labelField && !fieldSpecs?.[labelField]) ? properties[labelField] : '';
  const name = named || properties.NAME || properties.Name || properties.name || '';

  const rows = [];
  // A layer may name its own columns; see overlayRows.
  if (fieldSpecs) {
    rows.push(...overlayRows(fieldSpecs, properties, humaniseValue));
  } else {
    for (const [key, value] of Object.entries(properties)) {
      if (rows.length >= 5) break;
      if (key === labelField || PLUMBING.test(key)) continue;
      if (value === null || value === undefined || value === '') continue;
      const label = key.replace(/_/g, ' ').toLowerCase().replace(/^./, (first) => first.toUpperCase());
      rows.push([label, humaniseValue(value)]);
    }
  }

  return {
    source: overlay.name,
    designation: String(name),
    // This one is the feature's own name, out of the field the catalogue
    // nominates — "Rough Trail Parking Lot" rather than "Recreation".
    named: Boolean(name),
    attributes: null,
    rows,
    links: overlayLinks(overlay.query?.links, properties),
  };
}

/** One rendered basemap feature as an identify group, or null if it says nothing. */
function describeMapFeature(feature) {
  // Ours first: an overlay feature has no Mapbox source layer and would
  // otherwise be dropped by the table below.
  const own = describeOverlayFeature(feature);
  if (own) return own;

  const schema = mapSchema();
  const kind = schema.identify?.[feature.sourceLayer];
  if (!kind) return null;

  const properties = feature.properties || {};
  const name = properties[schema.fields.nameEn] || properties[schema.fields.name] || '';
  const specific = properties[kind.field] || '';
  // A nameless patch of "grass" is not an answer to "what is here". A nameless
  // road is, because its surface and class are the answer — and a trail is a
  // road here, which is the case that made this matter.
  if (!name && feature.sourceLayer !== schema.layers.road) return null;

  /* Vector-tile columns are lower_snake_case — `national_park`, `street_limited`
     — which `humaniseValue` leaves alone because an agency code in that shape
     usually means something. Here it is just a word with a join in it. */
  const words = (value) => String(value).replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
  const rows = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    rows.push([label, words(humaniseValue(value))]);
  };
  /*
   * Mapbox's class, translated - not passed through as a designation.
   *
   * `landuse.class` is a *rendering* category. Mapbox files national parks,
   * state parks, state forests, national forests and nature preserves all
   * under `national_park`, so printing it verbatim told a reader that Conkles
   * Hollow State Nature Preserve - an Ohio DNR preserve - is a national park
   * unit. It is not, and the basemap never claimed it was; we misread a
   * styling bucket as a fact about jurisdiction.
   *
   * The honest label names the bucket. Which agency actually holds it is a
   * question the state layers and the land lookup can answer and the basemap
   * cannot.
   */
  add('Kind', LAND_CLASS_LABELS[specific] ?? specific);
  if (feature.sourceLayer === schema.layers.road) {
    add('Route', properties[schema.fields.ref]);
    // Surface is a Mapbox column. Protomaps has none, so the row is absent
    // there rather than empty — a schema that cannot answer says nothing.
    if (schema.fields.surface) add('Surface', properties[schema.fields.surface]);
    if (properties.structure && properties.structure !== 'none') add('Structure', properties.structure);
    /*
     * Protomaps carries the same three facts as booleans instead of one word.
     * Worth reporting: whether the thing under your finger is a bridge is the
     * kind of question asked while looking at a river crossing on a paper map.
     */
    if (properties.is_bridge === true || properties.is_bridge === 'true') add('Structure', 'Bridge');
    else if (properties.is_tunnel === true || properties.is_tunnel === 'true') add('Structure', 'Tunnel');
  }
  const elevation = properties.elevation_ft
    ? `${properties.elevation_ft} ft`
    : properties[schema.fields.elevation || 'elevation'] || '';
  if (elevation) add('Elevation', typeof elevation === 'string' ? elevation : `${elevation} m`);

  return {
    source: kind.source,
    designation: name || (specific ? words(humaniseValue(specific)) : '') || kind.source,
    // Only where the tile actually carried one. The fallbacks below it are a
    // class spelled as a word — "Track" — which names a kind of thing and not
    // a thing.
    named: Boolean(name),
    attributes: null,
    rows,
  };
}

/** Run every visible identifiable layer against one point, and show the answer. */
async function probePoint(position, tolerance) {
  const layers = identifiableOverlays();

  // The marker goes down first and stays until the card is dismissed. Without
  // it a tap that lands on nothing leaves no trace of where it landed, and a
  // card about "this spot" with nothing marking the spot is a riddle.
  setProbeMark(position);

  const onTheMap = basemapFeatures(position, tolerance);
  if (!layers.length) {
    showIdentifyResults(position, onTheMap);
    return;
  }

  showIdentifyResults(position, onTheMap, { pending: true });

  const bounds = state.map.getBounds();
  const extent = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  const canvas = state.map.getCanvas();
  const size = [Math.round(canvas.clientWidth || 800), Math.round(canvas.clientHeight || 600), 96];

  // Every layer at once, and one slow service does not hold up the rest.
  const answers = await Promise.allSettled(layers.map((entry) => identifyAt(entry, position, {
    tolerance, bounds: extent, size,
  })));

  const groups = [];
  for (const [index, answer] of answers.entries()) {
    if (answer.status === 'rejected') {
      console.warn(`[identify] ${layers[index].name}:`, answer.reason?.message || answer.reason);
      continue;
    }
    groups.push(...answer.value);
  }

  showIdentifyResults(position, [...groups, ...onTheMap]);
}

/** Arm the next tap to ask what is under it, rather than drop a pin. */
function armProbe(button) {
  state.probing = !state.probing;
  button.classList.toggle('is-on', state.probing);
  button.setAttribute('aria-pressed', String(state.probing));
  dom.app?.classList.toggle('is-probing', state.probing);
  toast(state.probing
    ? 'Tap the map to see what is there.'
    : 'Tapping the map drops a pin again.', { tone: 'info' });
}

/** Show the Details tab for a place that is not a saved pin. */
function showPointDetails(position) {
  state.selectedPin = null;
  state.scratchPoint = position;
  setProbeMark(position);
  renderDetailsTab();
  openTab('details');
}

/** Remember which saved pin the Details tab should describe, and show it. */
function selectPin(folderId, itemId, { open = true } = {}) {
  state.selectedPin = folderId && itemId ? { folderId, itemId } : null;
  // A saved pin draws itself; the scratch mark beside it would be a second dot
  // on the same spot.
  if (state.selectedPin) { state.scratchPoint = null; setProbeMark(null); }
  renderDetailsTab();
  if (open) openTab('details');
}

function showFeaturePopup(feature, lngLat, { edit = false, identity = null } = {}) {
  /*
   * Identity is passed in, not read off the feature.
   *
   * `folderId` and `itemId` are stamped on in toGeoJSON, for the copy that goes
   * to the map source — the stored feature carries neither. So a popup opened
   * from the folder tree or the waypoint list looked at a pin that was plainly
   * already filed and offered to file it, because from here it was
   * indistinguishable from a dropped marker.
   */
  const props = { ...(feature.properties || {}), ...(identity || {}) };
  const rows = [];
  // Values arriving from a GL query are stringified; values from our own state
  // are not. Normalise before testing them.
  const number = (value) => (typeof value === 'string' ? Number(value) : value);

  const distance = number(props.distance_m);
  if (Number.isFinite(distance) && distance > 0) rows.push(['Distance', formatDistance(distance, state.units)]);
  const ascent = number(props.ascent_m);
  if (Number.isFinite(ascent) && ascent > 0) rows.push(['Ascent', formatElevation(ascent, state.units)]);
  const descent = number(props.descent_m);
  if (Number.isFinite(descent) && descent > 0) rows.push(['Descent', formatElevation(descent, state.units)]);
  const high = number(props.elevation_max_m);
  if (Number.isFinite(high)) rows.push(['High point', formatElevation(high, state.units)]);
  const duration = number(props.duration_s);
  if (Number.isFinite(duration) && duration > 0) rows.push(['Moving time', formatDuration(duration)]);
  if (props.folderName) rows.push(['Folder', props.folderName]);
  else if (props.folder) rows.push(['Folder', props.folder]);

  const description = props.description ? String(props.description).slice(0, 1200) : '';

  /*
   * The pin's own mark, beside its name.
   *
   * It used to be a row in the stats reading "Symbol: waterfall" — a word for a
   * picture the map is already drawing, halfway down the card. Next to the
   * title it identifies the pin at a glance and takes no line of its own.
   */
  const glyph = props.kind === 'waypoint' || props.icon
    ? el('span', {
      class: 'popup-mark',
      style: `background:${props.color || props.folderColor || 'var(--clay)'}`,
      html: pinIconSVG(props.icon || DEFAULT_PIN_ICON, { size: 15, stroke: 2 }),
    })
    : null;

  // Named so that "how many cards did one tap open" is a question a test can
  // ask. It was an anonymous div, and the two-cards-at-once bug lived behind
  // exactly that.
  const content = el('div', { class: 'feature-popup' });
  content.append(el('div', { class: 'popup-head' }, [
    glyph,
    el('div', { class: 'popup-head-text' }, [
      el('div', { class: 'popup-title', text: props.name || 'Untitled' }),
      el('div', { class: 'popup-kind', text: props.kind || 'feature' }),
    ]),
  ]));

  if (description) {
    content.append(el('p', { class: 'popup-desc', text: description }));
  }

  // The latest field note, trimmed. A popup is a glance, and "gate locked" is
  // exactly the kind of thing you want at a glance rather than two taps away.
  const latest = latestNote(props);
  if (latest?.text) {
    const trimmed = String(latest.text).length > NOTE_PREVIEW
      ? `${String(latest.text).slice(0, NOTE_PREVIEW).trimEnd()}…`
      : String(latest.text);
    content.append(el('div', { class: 'popup-note' }, [
      el('span', { class: 'popup-note-mark', html: icons.note }),
      el('div', {}, [
        el('div', { class: 'popup-note-text', text: trimmed }),
        el('div', { class: 'popup-note-date', text: formatDate(new Date(latest.at)) }),
      ]),
    ]));
  }

  if (rows.length) {
    content.append(el('dl', { class: 'popup-stats' }, rows.flatMap(([k, v]) => [
      el('dt', { text: k }),
      el('dd', { text: v }),
    ])));
  }

  const popup = new state.gl.Popup({ closeButton: true, maxWidth: '300px', offset: 12 })
    .setLngLat(feature.geometry?.type === 'Point' ? feature.geometry.coordinates : lngLat);

  content.append(props.itemId
    ? savedItemActions(props, popup, content)
    : saveToFolderActions(feature, popup));

  popup.setDOMContent(content).addTo(state.map);

  // Opened from an edit button rather than from the map: skip the read-only
  // step nobody asked for.
  if (edit && props.itemId) openPopupEditor(content, props, popup);
}

/**
 * Rename a pin, rewrite its note, and restyle it, without leaving the map.
 *
 * Replaces the popup's own body rather than opening a second surface: there is
 * one thing being edited and it is the thing under the cursor.
 *
 * `host` is the node this file put inside the popup, never the popup's own
 * container — that also holds the close button, and under a stubbed engine it
 * can turn out to be document.body.
 */
function openPopupEditor(host, props, popup) {
  if (!host || host.querySelector('.popup-edit')) return;

  const folder = state.folders.get(props.folderId);
  const current = folder?.items.find((item) => item.id === props.itemId);
  if (!current) return;

  const live = current.feature.properties;
  const name = el('input', {
    type: 'text', class: 'popup-edit-name', value: live.name || '', 'aria-label': 'Name',
  });
  const description = el('textarea', {
    class: 'popup-edit-note', rows: '3', 'aria-label': 'Note',
    placeholder: 'What is here, where to park, what to watch for…',
  });
  description.value = live.description || '';

  let icon = live.icon || DEFAULT_PIN_ICON;
  let colour = live.color || folder.color;

  const swatches = el('div', { class: 'popup-edit-colours' }, FOLDER_COLORS.map((value) => {
    const button = el('button', {
      class: `popup-swatch${value === colour ? ' is-on' : ''}`,
      type: 'button', style: `background:${value}`,
      'aria-label': `Color ${value}`,
      onclick: () => {
        colour = value;
        for (const node of swatches.children) node.classList.toggle('is-on', node === button);
      },
    });
    return button;
  }));

  // Grouped, because a flat list of every symbol is unreadable and the groups
  // are how anyone looks for one — "somewhere under Water".
  const iconPicker = el('select', { class: 'popup-edit-icon', 'aria-label': 'Symbol' },
    [...pinIconGroups()].map(([group, choices]) => el('optgroup', { label: group },
      choices.map((choice) => el('option', {
        value: choice.id, text: choice.name, selected: choice.id === icon,
      })))));
  iconPicker.addEventListener('change', () => { icon = iconPicker.value; });

  const form = el('div', { class: 'popup-edit' }, [
    name,
    description,
    el('div', { class: 'popup-edit-row' }, [iconPicker]),
    swatches,
    el('div', { class: 'popup-actions' }, [
      el('button', {
        type: 'button', class: 'is-primary', text: 'Save',
        onclick: () => {
          state.folders.editItem(props.folderId, props.itemId, {
            name: name.value,
            description: description.value,
          });
          state.folders.styleItems(props.folderId, { color: colour, icon }, [props.itemId]);
          popup.remove();
          toast('Pin updated.', { tone: 'ok' });
        },
      }),
      el('button', { type: 'button', text: 'Cancel', onclick: () => popup.remove() }),
    ]),
  ]);

  host.replaceChildren(form);
  name.focus();
  name.select();
}

/** Actions for a feature that is not yet in a folder: pick one and save. */
function saveToFolderActions(feature, popup) {
  /*
   * One button, and the choice only after it is pressed.
   *
   * Before, a folder select and a name field sat on the card at all times,
   * neither labelled — so a card for a pin nobody had asked to save showed
   * "New folder" above a box reading "Saved places", and it was anyone's guess
   * what either did. Now the card asks nothing until you say you want to save,
   * and then it says what each field is for.
   */
  const folders = state.folders.list();

  const select = el('select', { class: 'popup-folder', 'aria-label': 'Folder to save into' }, [
    ...folders.map((folder) => el('option', { value: folder.id, text: folder.name })),
    el('option', { value: '__new__', text: folders.length ? 'New folder…' : 'New folder' }),
  ]);
  select.value = folders.length ? folders[folders.length - 1].id : '__new__';

  const newName = el('input', {
    type: 'text', class: 'popup-new-folder', value: 'Saved places',
    placeholder: 'Name the new folder', 'aria-label': 'Name for the new folder',
  });
  const newLabel = el('label', { class: 'popup-label popup-new-folder-label', text: 'New folder name' });

  const showName = () => {
    const isNew = select.value === '__new__';
    newName.hidden = !isNew;
    newLabel.hidden = !isNew;
  };
  select.addEventListener('change', showName);
  showName();

  const panel = el('div', { class: 'popup-save-panel', hidden: true }, [
    el('label', { class: 'popup-label', text: 'Save into' }),
    select,
    newLabel,
    newName,
    el('div', { class: 'popup-save-confirm' }, [
      el('button', {
        type: 'button', class: 'is-primary', text: 'Save',
        onclick: () => {
          saveFeatureToFolder(feature, select.value,
            select.value === '__new__' ? newName.value : null);
          popup.remove();
          openTab('folders');
        },
      }),
      el('button', {
        type: 'button', text: 'Cancel',
        onclick: () => { panel.hidden = true; opener.hidden = false; },
      }),
    ]),
  ]);

  /*
   * The same weight as Details and Close, and a mark instead of a slab.
   *
   * A full-width clay button for a thing nobody had asked for yet was the
   * loudest element on a card that has to fit over a map, and it cost a whole
   * row of height to say two words. The commit button inside the panel keeps
   * the colour — that one IS the decision.
   */
  const opener = labelledButton(icons.folder, 'Save to folder', {
    tone: 'ghost',
    title: 'Save this pin into a folder',
    onclick: () => { panel.hidden = false; opener.hidden = true; select.focus(); },
  });
  opener.classList.add('popup-save-open');

  /*
   * One press to the trip you are actually planning.
   *
   * The folder picker below can reach it in three, and three is enough to stop
   * bothering — which is how a queue ends up half-built. The trip on now wins,
   * then the next one coming up; if there is no trip there is no button.
   */
  const trip = plannableTrip();
  const children = [opener, panel];
  if (trip) {
    const send = labelledButton(icons.route, `Add to ${trip.name}`, {
      tone: 'ghost',
      title: `Put this in the ${trip.name} queue`,
      onclick: () => {
        saveFeatureToFolder(feature, trip.id, null);
        popup.remove();
        openTab('folders');
      },
    });
    send.classList.add('popup-send-trip');
    children.unshift(send);
  }

  return el('div', { class: 'popup-actions popup-save' }, children);
}

/**
 * The trip a stop should go into if you press one button.
 *
 * On now beats coming up, and coming up beats finished — a trip you are
 * driving is the one you are adding to, and a trip that is over is not a queue
 * any more. Ties broken by which starts first, because the imminent one is the
 * one being packed for.
 */
function plannableTrip() {
  const ranked = state.folders.list()
    .filter((folder) => folder.trip)
    .map((folder) => ({ folder, standing: tripStanding(folder.trip) }))
    .filter((entry) => entry.standing && entry.standing.state !== 'over')
    .sort((a, b) => {
      if (a.standing.state !== b.standing.state) return a.standing.state === 'on' ? -1 : 1;
      return a.folder.trip.from.localeCompare(b.folder.trip.from);
    });

  return ranked.length ? ranked[0].folder : null;
}

/** Actions for a feature already saved in a folder. */
function savedItemActions(props, popup, content) {
  const folders = state.folders.list().filter((folder) => folder.id !== props.folderId);
  const children = [];

  if (folders.length) {
    const select = el('select', { 'aria-label': 'Move to another folder' }, [
      el('option', { value: '', text: 'Move to…' }),
      ...folders.map((folder) => el('option', { value: folder.id, text: folder.name })),
    ]);
    select.addEventListener('change', () => {
      if (!select.value) return;
      state.folders.moveItem(props.itemId, props.folderId, select.value);
      popup.remove();
    });
    children.push(select);
  }

  children.push(labelledButton(icons.info, 'Details', {
    tone: 'ghost',
    title: 'Everything known about this place',
    onclick: () => { popup.remove(); selectPin(props.folderId, props.itemId); },
  }));

  /*
   * Edit here, on the pin, rather than by jumping to its row in the list.
   *
   * The old button opened the Folders tab, re-rendered it and anchored an
   * editor to the matching row — fine with a dozen pins and useless with a
   * thousand, which is what a GaiaGPS export actually contains. The pin is
   * already on screen and already the thing you are pointing at.
   */
  children.push(labelledButton(icons.pencil, 'Edit', {
    tone: 'ghost',
    title: 'Change the name, note, icon or color',
    onclick: () => openPopupEditor(content, props, popup),
  }));

  children.push(labelledButton(icons.trash, 'Remove', {
    tone: 'ghost',
    title: 'Delete this waypoint',
    onclick: () => {
      state.folders.removeItem(props.folderId, props.itemId);
      popup.remove();
    },
  }));

  return el('div', { class: 'popup-actions' }, children);
}

/* ------------------------------------------------------------------ documents */

async function addDocument({ name, doc, origin, slug = null, fit = true }) {
  const key = uniqueKey(slug || name || doc.name);
  const entry = {
    key, slug, origin,
    name: name || doc.name || 'Untitled map',
    doc, color: nextColor(), visible: true, bound: false,
  };
  state.documents.set(key, entry);
  addDocumentLayers(entry);
  state.activeKey = key;
  renderFoldersTab();   // the "file from an open file" button appears with the first file

  renderMapsTab();
  renderDetailsTab();
  writeURL();
  if (fit) fitTo(doc.bbox);
  return entry;
}

function removeDocument(key) {
  removeDocumentLayers(key);
  state.documents.delete(key);
  if (state.activeKey === key) state.activeKey = [...state.documents.keys()].pop() || null;
  setHighlight(null);
  renderMapsTab();
  renderDetailsTab();
  writeURL();
}

async function loadFromCatalog(slug, { fit = true } = {}) {
  const existing = [...state.documents.values()].find((d) => d.slug === slug);
  if (existing) {
    state.activeKey = existing.key;
    renderMapsTab();
    renderDetailsTab();
    if (fit) fitTo(existing.doc.bbox);
    return existing;
  }

  const record = findMap(state.catalog, slug);
  if (!record) {
    toast(`No map named “${slug}” in the catalogue.`, { tone: 'error' });
    return null;
  }

  setStatus(true, `Loading ${record.title}…`);
  try {
    const url = record.path || `data/maps/${record.file}`;
    const response = await fetch(url, { cache: 'default' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const isBinary = /\.kmz$/i.test(url);
    const payload = isBinary ? await response.arrayBuffer() : await response.text();
    const doc = await parseMapFile(payload, url);
    return await addDocument({ name: record.title || doc.name, doc, origin: 'catalog', slug, fit });
  } catch (error) {
    toast(`Could not load “${record.title || slug}”: ${error.message}`, { tone: 'error', timeout: 9000 });
    return null;
  } finally {
    setStatus(false);
  }
}

/* ------------------------------------------------------------------ file input */

/**
 * Populate the "send waypoints to" picker beside the drop zone.
 *
 * Opening a file and then separately filing its waypoints was two steps for
 * what is nearly always one intent, so the destination is chosen up front.
 */
function renderDropTarget() {
  if (!dom.dropTarget) return;
  const previous = dom.dropTarget.value;
  const folders = state.folders.list();
  dom.dropTarget.replaceChildren(
    el('option', { value: '', text: 'Just show it on the map' }),
    ...folders.map((folder) => el('option', { value: folder.id, text: `File waypoints into “${folder.name}”` })),
    el('option', { value: '__new__', text: 'File waypoints into a new folder' }),
  );
  if (previous && [...dom.dropTarget.options].some((o) => o.value === previous)) dom.dropTarget.value = previous;
}

/** Apply the drop-zone destination to a freshly opened document. */
function fileOpenedDocument(entry) {
  const choice = dom.dropTarget?.value;
  if (!choice) return null;

  const waypoints = entry.doc.geojson.features
    .filter((feature) => feature.properties.kind === 'waypoint')
    .map((feature) => ({ ...feature, properties: { ...feature.properties, sourceName: entry.name } }));
  if (!waypoints.length) return null;

  const folder = choice === '__new__' ? state.folders.create(entry.name) : state.folders.get(choice);
  if (!folder) return null;

  const { added, skipped } = state.folders.addFeatures(folder.id, waypoints);
  // A new folder becomes the standing destination, which is what you want when
  // opening several files that belong to the same trip.
  if (choice === '__new__') { renderDropTarget(); dom.dropTarget.value = folder.id; }
  return { folder, added, skipped };
}

function wireDropzone() {
  dom.dropzone?.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput?.addEventListener('change', (event) => {
    handleFiles([...event.target.files]);
    event.target.value = '';
  });

  let depth = 0;
  const onDragEnter = (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    depth++;
    dom.app.classList.add('is-dragging');
  };
  const onDragLeave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dom.app.classList.remove('is-dragging');
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
  });
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    depth = 0;
    dom.app.classList.remove('is-dragging');
    handleFiles([...event.dataTransfer.files]);
  });
}

async function handleFiles(files) {
  const accepted = files.filter((file) => /\.(gpx|kml|kmz|geojson|json)$/i.test(file.name));
  const rejected = files.length - accepted.length;
  if (rejected) toast(`Skipped ${rejected} unsupported file${rejected > 1 ? 's' : ''}.`, { tone: 'error' });
  if (!accepted.length) return;

  setStatus(true, `Reading ${accepted.length} file${accepted.length > 1 ? 's' : ''}…`);
  let bounds = null;
  const filedInto = [];
  const opened = [];   // loaded but not filed anywhere yet
  for (const file of accepted) {
    try {
      const isBinary = /\.kmz$/i.test(file.name);
      const payload = isBinary ? await file.arrayBuffer() : await file.text();
      const doc = await parseMapFile(payload, file.name);
      if (!doc.geojson.features.length) {
        toast(`“${file.name}” contained no mappable features.`, { tone: 'error' });
        continue;
      }
      const entry = await addDocument({ name: doc.name || file.name, doc, origin: 'local', fit: false });
      const filed = fileOpenedDocument(entry);
      if (filed) filedInto.push(filed); else opened.push(entry);
      bounds = bounds ? mergeBounds(bounds, doc.bbox) : doc.bbox;
    } catch (error) {
      toast(`${file.name}: ${error.message}`, { tone: 'error', timeout: 9000 });
    }
  }
  setStatus(false);
  if (bounds) {
    fitTo(bounds);
    const loaded = `Loaded ${accepted.length} file${accepted.length > 1 ? 's' : ''}.`;
    if (filedInto.length) {
      const added = filedInto.reduce((sum, r) => sum + r.added, 0);
      const names = [...new Set(filedInto.map((r) => r.folder.name))];
      const where = names.length === 1 ? `“${names[0]}”` : `${names.length} folders`;
      toast(`${loaded} Filed ${added} waypoint${added === 1 ? '' : 's'} into ${where}.`, { tone: 'ok', timeout: 9000 });
    } else {
      const waypoints = [...state.documents.values()]
        .filter((entry) => entry.origin === 'local')
        .reduce((sum, entry) => sum + entry.doc.stats.waypointCount, 0);
      if (waypoints) {
        // Asking beats a toast pointing at a control you have not found yet.
        askWhereToFile(opened, waypoints);
        toast(loaded, { tone: 'ok', timeout: 5000 });
      } else {
        toast(`${loaded} These stay in your browser — nothing is uploaded.`, { tone: 'ok', timeout: 9000 });
      }
    }
  }
  selectTab('details');
}

/* ------------------------------------------------------------------ camera */

function fitTo(bbox) {
  if (!boundsAreValid(bbox)) return;
  const padded = padBounds(bbox);
  state.map.fitBounds([[padded[0], padded[1]], [padded[2], padded[3]]], {
    padding: { top: 48, bottom: 48, left: 48, right: 48 },
    maxZoom: 15,
    duration: 700,
  });
}

function fitAll() {
  const visible = [...state.documents.values()].filter((d) => d.visible);
  if (!visible.length) return;
  fitTo(visible.map((d) => d.doc.bbox).reduce((a, b) => mergeBounds(a, b)));
}

function setHighlight(geojson) {
  const source = state.map.getSource('scratch-highlight');
  source?.setData(geojson || { type: 'FeatureCollection', features: [] });
}

/**
 * Mark where the last tap landed, and keep it there.
 *
 * The identify card says "on this spot" and the map said nothing about which
 * spot — so a tap that found nothing looked like a tap that had not happened,
 * and a card left open while the map was panned pointed at a place that had
 * moved off screen. It also matters to the sky drawings: a bearing to the moon
 * is only a bearing from somewhere.
 */
function setProbeMark(position) {
  state.probeMark = position || null;
  setCursor(state.probeMark);
}

function setCursor(position) {
  const source = state.map.getSource('scratch-cursor');
  source?.setData(position
    ? { type: 'Feature', geometry: { type: 'Point', coordinates: position }, properties: {} }
    : { type: 'FeatureCollection', features: [] });
}

/* ------------------------------------------------------------------ maps tab */

function renderMapsTab() {
  // Catalogue
  dom.catalogList.replaceChildren();
  if (!state.catalog.maps.length) {
    dom.catalogList.append(el('p', {
      class: 'hint',
      text: 'No published maps yet. Drop a GPX, KML or KMZ file below to view it.',
    }));
  } else {
    for (const record of state.catalog.maps) {
      const loaded = [...state.documents.values()].find((d) => d.slug === record.slug);
      dom.catalogList.append(el('div', { class: `map-entry${loaded ? ' is-active' : ''}` }, [
        el('input', {
          type: 'checkbox', checked: Boolean(loaded), 'aria-label': `Show ${record.title}`,
          onchange: (event) => {
            if (event.target.checked) loadFromCatalog(record.slug);
            else if (loaded) removeDocument(loaded.key);
          },
        }),
        el('div', {
          class: 'map-entry-text', role: 'button', tabindex: '0',
          onclick: () => loadFromCatalog(record.slug),
          onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loadFromCatalog(record.slug); } },
        }, [
          el('div', { class: 'map-entry-name', text: record.title }),
          el('div', { class: 'map-entry-meta', text: catalogSummary(record) }),
        ]),
      ]));
    }
  }

  // Loaded documents
  dom.loadedList.replaceChildren();
  const entries = [...state.documents.values()];
  dom.loadedCount.textContent = entries.length ? `${entries.length} loaded` : '';
  if (!entries.length) {
    dom.loadedList.append(el('p', { class: 'hint', text: 'Nothing loaded yet.' }));
    return;
  }

  for (const entry of entries) {
    dom.loadedList.append(el('div', { class: `map-entry${entry.key === state.activeKey ? ' is-active' : ''}` }, [
      el('span', { class: 'map-entry-swatch', style: `background:${entry.color}` }),
      el('input', {
        type: 'checkbox', checked: entry.visible, 'aria-label': `Toggle ${entry.name}`,
        onchange: (event) => { entry.visible = event.target.checked; applyVisibility(); },
      }),
      el('div', {
        class: 'map-entry-text', role: 'button', tabindex: '0',
        onclick: () => { state.activeKey = entry.key; renderMapsTab(); renderDetailsTab(); selectTab('details'); },
        onkeydown: (event) => { if (event.key === 'Enter') { state.activeKey = entry.key; renderDetailsTab(); selectTab('details'); } },
      }, [
        el('div', { class: 'map-entry-name', text: entry.name }),
        el('div', { class: 'map-entry-meta', text: documentSummary(entry.doc) }),
      ]),
      el('div', { class: 'map-entry-actions' }, [
        el('button', {
          class: 'icon-button', title: 'Zoom to this map', 'aria-label': `Zoom to ${entry.name}`,
          html: icons.target, onclick: () => fitTo(entry.doc.bbox),
        }),
        el('button', {
          class: 'icon-button', title: 'Remove', 'aria-label': `Remove ${entry.name}`,
          html: icons.trash, onclick: () => removeDocument(entry.key),
        }),
      ]),
    ]));
  }
}

function catalogSummary(record) {
  const parts = [];
  if (record.region) parts.push(record.region);
  const distance = record.stats?.distance_m;
  if (distance) parts.push(formatDistance(distance, state.units));
  if (record.stats?.waypointCount) parts.push(`${record.stats.waypointCount} waypoints`);
  return parts.join(' · ');
}

function documentSummary(doc) {
  const parts = [];
  if (doc.stats.distance_m) parts.push(formatDistance(doc.stats.distance_m, state.units));
  const features = doc.stats.trackCount + doc.stats.routeCount;
  if (features) parts.push(`${features} track${features > 1 ? 's' : ''}`);
  if (doc.stats.waypointCount) parts.push(`${doc.stats.waypointCount} waypoints`);
  return parts.join(' · ') || doc.format.toUpperCase();
}

/* ------------------------------------------------------------------ details tab */

function renderDetailsTab() {
  dom.details.replaceChildren();

  const pin = selectedPinRecord();
  if (pin) { state.scratchPoint = null; renderPinDetails(pin.folder, pin.item); return; }

  // A dropped pin gets the same treatment as a saved one, minus the parts that
  // only a saved waypoint has: no notes to keep, no folder to sit in.
  if (state.scratchPoint) { renderPointDetails(state.scratchPoint); return; }

  const entry = state.documents.get(state.activeKey);
  if (!entry) {
    dom.details.append(el('div', { class: 'panel-section' }, [
      el('p', { class: 'hint', text: 'Click a waypoint on the map, or pick one from Waypoints, to see everything known about it.' }),
    ]));
    return;
  }

  renderDocumentDetails(entry);
}

function selectedPinRecord() {
  const selected = state.selectedPin;
  if (!selected) return null;
  const folder = state.folders.get(selected.folderId);
  const item = folder?.items.find((entry) => entry.id === selected.itemId);
  if (!folder || !item) { state.selectedPin = null; return null; }
  return { folder, item };
}

/**
 * The most recent field note on a pin, whatever shape it arrives in.
 *
 * A feature read back off the map is not the object that was put on it: GL
 * serialises anything that is not a string or a number, so `log` comes back as
 * JSON text rather than an array. The stored item is the authority where there
 * is one — this only parses when there is not.
 */
function latestNote(props) {
  const stored = state.folders.get(props.folderId)?.items
    .find((item) => item.id === props.itemId)?.feature.properties.log;

  let log = stored ?? props.log;
  if (typeof log === 'string') {
    try { log = JSON.parse(log); } catch { log = []; }
  }
  if (!Array.isArray(log) || !log.length) return null;

  return [...log].sort((a, b) => (b.at || 0) - (a.at || 0))[0];
}

/**
 * A button with a mark and a word.
 *
 * Three text-only buttons in a row is most of the panel's width, and on a phone
 * it is more than all of it. A mark each lets the word be short enough to fit,
 * and gives a target big enough to hit without reading first.
 */
function labelledButton(icon, label, { onclick, title = '', tone = 'secondary' } = {}, id = '') {
  const button = el('button', {
    class: `button button-${tone} button-small button-with-icon`,
    type: 'button',
    title: title || label,
    html: `${icon}<span>${escapeHTML(label)}</span>`,
    onclick,
  });
  // Some of these are the only way to reach an action that used to have its
  // own place in the header, so they keep the id that named it.
  if (id) button.id = id;
  return button;
}

/** A plain section heading, with the same mark the collapsible ones carry. */
function sectionTitle(text, icon = '') {
  return el('h2', { class: 'panel-title' }, [
    icon ? el('span', { class: 'detail-block-mark', html: icon }) : null,
    el('span', { text }),
  ]);
}

/** One labelled row in the details list, with an optional copy button. */
function detailRow(label, value, { copy = null } = {}) {
  return el('div', { class: 'detail-line' }, [
    el('span', { class: 'detail-line-label', text: label }),
    el('span', { class: 'detail-line-value', text: value }),
    copy
      ? el('button', {
        class: 'icon-button detail-copy', type: 'button',
        title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
        html: icons.copy,
        onclick: async (event) => {
          const ok = await copyText(copy);
          const button = event.currentTarget;
          button.classList.toggle('is-done', ok);
          if (ok) setTimeout(() => button.classList.remove('is-done'), 1400);
        },
      })
      : null,
  ]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', { tone: 'ok', timeout: 2000 });
    return true;
  } catch {
    toast(`Could not copy automatically. The value is: ${text}`, { tone: 'error', timeout: 12000 });
    return false;
  }
}

/**
 * Where the point is: coordinates and height together.
 *
 * Decimal degrees is what almost everyone pastes into something else, so it is
 * the only format on screen by default and it carries its own copy button. The
 * rest — DMS, degrees-and-minutes, UTM — sit behind a disclosure that remembers
 * whether it was left open, so the people who work in UTM see it every time
 * without it crowding the panel for everyone else.
 *
 * Elevation belongs here rather than in a section of its own: it is the third
 * number of a position, and on a dropped pin it is a lookup rather than a
 * recorded field, which is why the row can arrive late.
 */
function locationSection(position, { recorded = null } = {}) {
  const dd = formatDD(position);
  const dms = formatDMS(position);
  const ddm = formatDDM(position);
  const utm = toUTM(position);

  const heightRow = el('div', {});
  if (Number.isFinite(recorded)) {
    heightRow.append(detailRow('Elevation', formatElevation(recorded, state.units)));
  } else {
    heightRow.append(detailRow('Elevation', 'Looking up…'));
    elevation(position).then((result) => {
      heightRow.replaceChildren(result.ok
        ? detailRow('Elevation', formatElevation(result.metres, state.units))
        : detailRow('Elevation', 'Not available'));
    });
  }

  const more = el('details', {
    class: 'coord-more',
    open: readCoordFormats(),
    ontoggle: (event) => rememberCoordFormats(event.target.open),
  }, [
    el('summary', { class: 'coord-more-summary', text: 'Other formats' }),
    el('div', { class: 'coord-more-body' }, [
      detailRow('DMS', dms, { copy: dms }),
      detailRow('Deg / min', ddm, { copy: ddm }),
      utm ? detailRow('UTM', utm.toString(), { copy: utm.toString() }) : null,
    ]),
  ]);

  // Who manages the land is part of where the place is, not a subject of its
  // own — "public or private" is the second thing anyone asks after "where",
  // and it was three sections away from the coordinates that answer the first.
  const manager = el('div', { class: 'land-slot' });
  landManagerRows(position).then((rows) => {
    if (rows) manager.replaceChildren(...rows);
  });

  // Foldable like the rest of the panel, and open unless this reader closed it
  // — the coordinates are the one thing you want without asking, so the
  // default is not "tidy", it is "there".
  return collapsibleSection('location', 'Location', (body) => {
    body.append(detailRow('Decimal', dd, { copy: dd }));
    if (heightRow) body.append(heightRow);
    if (more) body.append(more);
    body.append(manager);
  }, { icon: icons.crosshair });
}

/**
 * Details for a place you tapped rather than saved.
 *
 * The same coordinates, daylight, land manager and weather a saved waypoint
 * gets — the point of the panel is the place, not the bookkeeping — minus
 * notes and photos, which need somewhere to be kept. The save button turns it
 * into a real waypoint and hands off to the full view.
 */
function renderPointDetails(position) {
  dom.details.append(el('div', { class: 'panel-section' }, [
    el('h2', { class: 'panel-title', style: 'margin:0', text: 'Dropped pin' }),
    el('p', { class: 'hint', style: 'margin:6px 0 11px', text: 'Not saved yet — this is wherever you last clicked the map.' }),
    el('div', { class: 'picker-row' }, [
      labelledButton(icons.pin, 'Save as waypoint', {
        tone: 'secondary',
        onclick: () => {
          const folders = state.folders.list();
          const target = folders.length ? folders[folders.length - 1] : state.folders.create('Saved places');
          const feature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: position },
            properties: { kind: 'waypoint', name: 'Dropped pin', description: '' },
          };
          saveFeatureToFolder(feature, target.id, null);
          state.scratchPoint = null;
          setProbeMark(null);
          toast(`Saved to “${target.name}”.`);
          openTab('folders');
        },
      }),
      labelledButton(icons.close, 'Clear', {
        tone: 'ghost',
        title: 'Forget this dropped pin',
        onclick: () => {
          state.scratchPoint = null;
          setProbeMark(null);
          state.dropPopup?.remove();
          renderDetailsTab();
        },
      }),
    ]),
  ]));

  // A dropped pin has no recorded height, so `locationSection` looks the ground
  // up rather than reading a field.
  dom.details.append(locationSection(position));

  dom.details.append(skySection(position));

  dom.details.append(weatherSection(position));
}

/**
 * Everything known about one saved pin.
 *
 * Deliberately arithmetic-first: coordinates, elevation, UTM, sun times and
 * bearing all work with no signal, which is exactly when this panel matters.
 * The geocoded place name is the only part that needs the network, and it is
 * appended when it arrives rather than blocking the rest.
 */
function renderPinDetails(folder, item) {
  const props = item.feature.properties;
  const position = item.feature.geometry?.coordinates || [];
  // Named `recordedHeight` rather than `elevation` so it does not shadow the
  // elevation lookup that `locationSection` calls.
  const [lon, lat, recordedHeight] = position;

  /* header */
  dom.details.append(el('div', { class: 'panel-section' }, [
    el('div', { class: 'pin-head' }, [
      el('span', {
        class: 'pin-head-icon', style: `background:${props.color || folder.color}`,
        html: pinIconSVG(props.icon || DEFAULT_PIN_ICON, { size: 18, stroke: 1.9 }),
      }),
      el('div', { style: 'min-width:0;flex:1' }, [
        el('h2', { class: 'panel-title is-name', style: 'margin:0', text: props.name }),
        el('div', { class: 'account-meta', text: folder.name }),
      ]),
    ]),
    props.description ? el('p', { class: 'pin-description', text: props.description }) : null,
    el('div', { class: 'picker-row', style: 'margin-top:11px' }, [
      labelledButton(icons.target, 'Zoom to', {
        title: 'Centre the map on this waypoint',
        onclick: () => focusFolderItem(item, folder.id),
      }),
      labelledButton(icons.pencil, 'Edit', {
        title: 'Change the name, note, icon or color',
        onclick: () => {
          openTab('folders');
          renderFoldersTab();
          const row = dom.folderList.querySelector(`[data-item="${item.id}"]`);
          if (row) openStyleEditor(folder, [item.id], row);
        },
      }),
    ]),
  ]));

  /* photos */
  const photos = props.photos || [];
  if (photos.length) {
    const section = el('div', { class: 'panel-section' }, [
      sectionTitle(`Photos (${photos.length})`, icons.image),
    ]);
    const strip = el('div', { class: 'photo-strip' });
    section.append(strip);
    dom.details.append(section);
    (async () => {
      for (const photo of photos) {
        const url = await photoURL(photo.id).catch(() => null);
        if (!url) continue;
        strip.append(el('a', { class: 'photo-tile', href: url, target: '_blank', rel: 'noopener' }, [
          el('img', { src: url, alt: photo.name || 'Pin photo', loading: 'lazy' }),
        ]));
      }
    })();
  }

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

  /* where it is */
  dom.details.append(locationSection([lon, lat], { recorded: recordedHeight }));

  /* where you are relative to it */
  const relative = el('div', { class: 'panel-section' }, [
    sectionTitle('From here', icons.compass),
  ]);
  const relativeBody = el('div', {}, [
    el('p', { class: 'hint', style: 'margin:0', text: 'Waiting for your location…' }),
  ]);
  relative.append(relativeBody);
  dom.details.append(relative);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        const from = [fix.coords.longitude, fix.coords.latitude];
        const { distance, bearing } = distanceBearing(from, [lon, lat]);
        relativeBody.replaceChildren(
          detailRow('Distance', formatDistance(distance, state.units)),
          detailRow('Bearing', `${Math.round(bearing)}° ${compassPoint(bearing)}`),
        );
      },
      () => {
        relativeBody.replaceChildren(el('p', {
          class: 'hint', style: 'margin:0',
          text: 'Location unavailable — allow location access, and note this needs https.',
        }));
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    );
  } else {
    relativeBody.replaceChildren(el('p', { class: 'hint', style: 'margin:0', text: 'This browser cannot report your location.' }));
  }

  /* daylight */
  dom.details.append(skySection([lon, lat]));

  dom.details.append(weatherSection([lon, lat]));
  dom.details.append(notesSection(folder, item));

  /* place — network, so appended when it arrives */
  const placeSection = el('div', { class: 'panel-section' }, [
    sectionTitle('Nearest place', icons.pin),
  ]);
  const placeBody = el('p', { class: 'hint', style: 'margin:0', text: 'Looking up…' });
  placeSection.append(placeBody);
  dom.details.append(placeSection);

  reverseGeocode([lon, lat]).then((place) => {
    if (!place) {
      placeSection.remove();
      return;
    }
    const rows = [];
    if (place.address) rows.push(detailRow('Address', place.address, { copy: place.address }));
    if (place.context) rows.push(detailRow('Town', place.context, { copy: place.context }));
    if (!rows.length) { placeSection.remove(); return; }
    placeBody.replaceWith(el('div', {}, rows));
  });
}

/* ---------------- details: land, weather, notes ---------------- */

/** Small helper for a section that fills in once a network call returns. */
function pendingSection(title, run, { id = '', icon = '' } = {}) {
  const key = id || `pending:${title}`;
  let body = null;

  const section = collapsibleSection(key, title, (target) => {
    body = target;
    body.append(el('p', { class: 'hint', style: 'margin:0', text: 'Looking up…' }));
  }, { icon });

  run(body, section);
  return section;
}

/**
 * Who manages the land under the pin, as rows rather than a section.
 *
 * This used to be a section of its own, three below the coordinates. It reads
 * better inside Location: "public or private" is the second thing anyone asks
 * after "where am I", and the answer is about the place, not a separate
 * subject. Returns null when there is nothing worth saying, so the caller can
 * leave the space empty rather than print a heading over an apology.
 */
async function landManagerRows(position) {
  const result = await landManager(position).catch(() => ({ ok: false }));

  if (!result.ok) {
    // "Nothing here" and "nothing could be asked" mean opposite things: the
    // first is a working answer about private land, the second a broken
    // configuration. Only the second is the reader's problem, and even then the
    // service names belong in a tooltip rather than across the panel.
    if (result.empty !== true && !result.unreachable?.length) return null;
    const note = el('p', {
      class: 'hint', style: 'margin:9px 0 0',
      text: result.empty === true
        ? 'No public land mapped here — most likely private.'
        : 'Could not check who manages this — the land-ownership services did not answer.',
    });
    if (result.unreachable?.length) note.title = `Not answering:\n${result.unreachable.join('\n')}`;
    return [note];
  }

  const rows = [];

  // The banner first, because "can I camp here" is the question underneath
  // "who manages this", and an agency name alone does not answer it for anyone
  // who does not already know which acronyms are federal.
  const status = publicLand(result.agency, result.access);
  if (status.level) {
    rows.push(el('div', {
      class: `land-badge ${status.public ? 'is-public' : 'is-private'}`,
    }, [
      el('span', { class: 'land-badge-mark', html: status.public ? icons.eye : icons.info }),
      el('span', {
        text: status.public
          ? `Public land · ${status.level}${status.short && status.short !== status.level ? ` (${status.short})` : ''}`
          : status.closed
            ? `${status.level} land, access restricted`
            : `${status.level} land — not open by default`,
      }),
    ]));
  }

  if (result.agency) rows.push(detailRow('Agency', result.agency, { copy: result.agency }));
  if (result.unit) rows.push(detailRow('Unit', result.unit, { copy: result.unit }));
  if (result.access) rows.push(detailRow('Access', result.access));
  if (!rows.length) return null;

  rows.push(el('p', { class: 'source-note', text: `Source: ${result.source}` }));
  return rows;
}

/**
 * Compact forecast strip.
 *
 * The first period gets a headline card; the next few are chips. The NWS splits
 * its periods into day and night, so "3 days" is really six entries — showing
 * them as a row keeps the panel short without dropping the overnight lows,
 * which are the ones that decide whether you are warm enough.
 */
function weatherSection(position) {
  return pendingSection('Weather', async (body, section) => {
    // Severe weather is weather. It was a section of its own, which put "no
    // active warnings" under its own heading on every pin — and a heading that
    // says nothing every time is one you stop reading, which is a bad property
    // for the one section that matters when it does have something to say.
    const storms = el('div', { class: 'storm-slot' });
    fillStormRows(storms, position);

    const result = await forecast(position);

    if (!result.ok) {
      body.replaceChildren(
        el('p', { class: 'hint', style: 'margin:0', text: `No forecast — ${result.reason}.` }),
        storms,
      );
      return;
    }

    const [now, ...rest] = result.periods;
    // `isDaytime` comes straight from the NWS period and has been in the data
    // all along.
    const card = el('div', {
      class: `weather-now is-${weatherClass(now.short)}${now.isDaytime ? '' : ' is-night'}`,
    }, [
      el('div', { class: 'weather-glyph', html: weatherGlyph(weatherClass(now.short), { night: !now.isDaytime }) }),
      el('div', { class: 'weather-now-text' }, [
        el('div', { class: 'weather-when', text: now.name }),
        el('div', {
          class: 'weather-temp',
          text: formatTemperature(now.temperature, now.unit, state.temperature),
        }),
        el('div', { class: 'weather-short', text: now.short }),
      ]),
    ]);

    const strip = el('div', { class: 'weather-strip' }, rest.slice(0, 4).map((period) => el('div', {
      class: `weather-chip is-${weatherClass(period.short)}${period.isDaytime ? '' : ' is-night'}`,
      title: period.detailed,
    }, [
      el('span', { class: 'weather-chip-when', text: period.name }),
      el('span', {
        class: 'weather-chip-glyph',
        html: weatherGlyph(weatherClass(period.short), { night: !period.isDaytime }),
      }),
      el('span', {
        class: 'weather-chip-temp',
        text: formatTemperature(period.temperature, period.unit, state.temperature, { withScale: false }),
      }),
    ])));

    const facts = [];
    if (now.wind) facts.push(detailRow('Wind', now.wind));
    if (Number.isFinite(now.precipitation)) facts.push(detailRow('Rain', `${now.precipitation}%`));

    body.replaceChildren(
      card,
      strip,
      ...facts,
      el('p', { class: 'source-note', text: result.place ? `NWS · ${result.place}` : 'National Weather Service' }),
      storms,
    );
  }, { icon: icons.cloud });
}

/** Weather glyphs, drawn inline so the forecast works with no images to load. */
function weatherGlyph(kind, { night = false } = {}) {
  const wrap = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const cloud = '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.6A3.5 3.5 0 0 0 7 18Z"/>';
  // A crescent, for the periods the NWS marks as night. A sun over the words
  // "Overnight — Mostly Clear" is the kind of wrong that undermines everything
  // next to it.
  const moon = '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>';
  const moonSmall = '<path d="M12.6 8.4A5 5 0 0 1 6.4 2.2a5 5 0 1 0 6.2 6.2Z"/>';

  switch (kind) {
    case 'clear': return night
      ? wrap(moon)
      : wrap('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>');
    case 'partly': return night
      ? wrap(moonSmall + cloud)
      : wrap('<circle cx="8.5" cy="8" r="3.2"/><path d="M8.5 2.6v1.6M3.6 8H2M4.8 4.3 3.7 3.2M13.4 8H15"/>' + cloud);
    case 'rain': return wrap(cloud + '<path d="M9 21v-1.5M13 21.5v-2M17 21v-1.5"/>');
    case 'thunder': return wrap(cloud + '<path d="M13 19.5h-2.5l3-4.5H10"/>');
    case 'snow': return wrap(cloud + '<path d="M9 20.5h.01M13 21h.01M17 20.5h.01"/>');
    case 'fog': return wrap(cloud + '<path d="M5 21h6M14 21h5"/>');
    case 'wind': return wrap('<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 18h8"/>');
    default: return wrap(cloud);
  }
}

/**
 * Dated field notes, newest first.
 *
 * Append-only: "gate locked 3/24" and "gate open 9/25" are both true, and
 * letting the second overwrite the first would lose the fact that it changed —
 * which is exactly the thing worth knowing next time.
 */
/**
 * Active severe weather here, and which way the storm is going.
 *
 * The radar overlay draws where rain is now. This is the other half — the
 * National Weather Service publishes a storm motion vector with every severe
 * thunderstorm and tornado warning, computed from consecutive radar scans, and
 * it is the only free source that answers "where will this be in half an hour"
 * without differencing radar frames in a browser.
 *
 * Filled into the Weather section rather than standing on its own: severe
 * weather is weather, and a heading that says "no active warnings" on every pin
 * is one people stop reading — which is a bad property for the one part of the
 * panel that matters most when it does have something to say.
 */
async function fillStormRows(host, position) {
  const result = await activeAlerts(position);

  if (!result.ok) {
    host.replaceChildren(el('p', { class: 'hint storm-quiet', text: `Warnings could not be checked — ${result.reason}.` }));
    return;
  }

  if (!result.alerts.length) {
    // One quiet line rather than nothing, because "no warnings" and "nobody
    // asked" are different answers and only one of them is reassuring.
    host.replaceChildren(el('p', { class: 'hint storm-quiet', text: 'No active warnings here.' }));
    state.storms = null;
    refreshStormData();
    return;
  }

  host.replaceChildren();
  for (const alert of result.alerts) {
    const motion = alert.motion ? describeMotion(alert.motion) : '';
    host.append(el('div', { class: `storm-card is-${alert.severity.toLowerCase()}` }, [
      el('div', { class: 'storm-event', text: alert.event }),
      motion
        ? el('div', { class: 'storm-motion' }, [
          el('span', { class: 'storm-arrow', html: arrowGlyph(alert.motion.headingDegrees) }),
          el('span', { text: `Moving ${motion}` }),
        ])
        : el('div', { class: 'storm-motion is-quiet', text: 'No storm motion published for this one.' }),
      el('div', { class: 'storm-area', text: alert.areaDescription }),
      alert.expires
        ? el('div', { class: 'storm-expires', text: `Until ${clockTime(new Date(alert.expires))}` })
        : null,
    ]));
  }

  const tracked = result.alerts.filter((alert) => alert.geometry);
  if (tracked.length) {
    const showing = state.storms?.key === position.join(',');
    const stormButton = labelledButton(
      showing ? icons.eyeOff : icons.alert,
      showing ? 'Hide the warning areas' : 'Show the warning areas on the map',
      {
        tone: showing ? 'secondary' : 'primary',
        onclick: () => {
          state.storms = showing ? null : { key: position.join(','), alerts: tracked };
          refreshStormData();
          renderDetailsTab();
        },
      },
    );
    stormButton.classList.add('sky-lines-toggle');
    stormButton.dataset.toggle = 'storm-areas';
    host.append(stormButton);
  }

  host.append(el('p', {
    class: 'source-note',
    text: 'Storm motion is the National Weather Service\u2019s own vector, from consecutive radar'
      + ' scans. Only warned storms carry one — ordinary rain on the radar has no published track.',
  }));
}

/**
 * The arrowhead at the end of a storm track, drawn on canvas.
 *
 * A line layer cannot put a mark only at its end — GL will repeat a symbol
 * along a line or centre one on it, neither of which is an arrow — so the tip
 * is its own point feature with its own image, rotated to the bearing.
 */
function rasterizeStormArrow({ pixelRatio = 2 } = {}) {
  const size = 22;
  const canvas = document.createElement('canvas');
  canvas.width = size * pixelRatio;
  canvas.height = size * pixelRatio;

  const context = canvas.getContext('2d');
  context.scale(pixelRatio, pixelRatio);
  context.beginPath();
  context.moveTo(11, 2);
  context.lineTo(19, 19);
  context.lineTo(11, 15);
  context.lineTo(3, 19);
  context.closePath();

  context.fillStyle = '#b3261e';
  context.strokeStyle = 'rgba(255,255,255,0.9)';
  context.lineWidth = 1.6;
  context.stroke();
  context.fill();

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** A triangle pointing along a bearing, for the direction of travel. */
function arrowGlyph(bearing) {
  return `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
    style="transform:rotate(${Math.round(bearing)}deg)">
    <path d="M8 1.5 L13 14 L8 11 L3 14 Z" fill="currentColor"/>
  </svg>`;
}

/** Push warning polygons and motion arrows to the map. */
function refreshStormData() {
  if (!styleReady()) { whenStyleReady(refreshStormData); return; }

  const source = state.map.getSource(STORM_SOURCE);
  if (!source) return;

  source.setData(state.storms
    ? alertsToGeoJSON(state.storms.alerts, destinationPoint, { minutes: 30 })
    : { type: 'FeatureCollection', features: [] });
}

function notesSection(folder, item) {
  const notes = item.feature.properties.log || [];
  let section = null;
  const outer = collapsibleSection('notes', 'Field notes', (body) => { section = body; }, {
    icon: icons.note,
    count: notes.length ? String(notes.length) : '',
  });

  const list = el('div', { class: 'note-list' });

  const paint = () => {
    const current = [...(item.feature.properties.log || [])].sort((a, b) => b.at - a.at);
    list.replaceChildren();
    if (!current.length) {
      list.append(el('p', {
        class: 'hint', style: 'margin:0 0 9px',
        text: 'Nothing recorded yet. Notes are dated and kept, so you can see how a place changes.',
      }));
      return;
    }
    for (const note of current) {
      list.append(el('div', { class: 'note' }, [
        el('div', { class: 'note-head' }, [
          el('span', { class: 'note-date', text: new Date(note.at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }),
          el('button', {
            class: 'icon-button', type: 'button', title: 'Delete this note',
            'aria-label': 'Delete this note', html: icons.close,
            onclick: () => { state.folders.removeNote(folder.id, item.id, note.id); paint(); },
          }),
        ]),
        el('p', { class: 'note-text', text: note.text }),
      ]));
    }
  };

  const field = el('textarea', {
    class: 'style-desc', rows: '2', 'aria-label': 'New field note',
    placeholder: 'Gate locked · creek up · good camp on the left…',
  });
  const add = () => {
    const text = field.value.trim();
    if (!text) return;
    state.folders.addNote(folder.id, item.id, text);
    field.value = '';
    paint();
  };

  section.append(list, field, el('div', { class: 'picker-row', style: 'margin-top:7px' }, [
    el('button', { class: 'button button-secondary button-small', type: 'button', text: 'Add note', onclick: add }),
  ]));

  // Ctrl/Cmd+Enter to file a note without reaching for the button.
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add(); }
  });

  paint();
  return outer;
}

/** Stats for a loaded file: distance, elevation profile, feature lists. */
function renderDocumentDetails(entry) {
  const { doc } = entry;
  const stats = doc.stats;

  const statBlocks = [
    ['Distance', formatDistance(stats.distance_m, state.units)],
    ['Ascent', formatElevation(stats.ascent_m, state.units)],
    ['Descent', formatElevation(stats.descent_m, state.units)],
    ['High point', stats.elevation_max_m === null ? '—' : formatElevation(stats.elevation_max_m, state.units)],
  ];
  if (stats.duration_s) statBlocks.push(['Moving time', formatDuration(stats.duration_s)]);
  if (stats.startTime) statBlocks.push(['Recorded', formatDate(stats.startTime)]);

  // Say plainly that these are one opened file's totals. Read without that,
  // a folder name above a distance and an ascent looks like the folder has a
  // length and a climb — which it does not; the track inside it does. When the
  // file holds several tracks the numbers are a sum, which is worth admitting.
  const trackCount = stats.trackCount ?? 0;
  const scope = trackCount > 1
    ? `Totals across ${trackCount} tracks in this file`
    : 'From this opened file';

  dom.details.append(el('div', { class: 'panel-section' }, [
    el('div', { class: 'detail-scope' }, [
      el('span', { class: 'detail-scope-mark', html: icons.file }),
      el('span', { text: scope }),
    ]),
    el('h2', { class: 'panel-title is-name', text: entry.name }),
    doc.description ? el('p', { class: 'hint', style: 'margin-bottom:14px', text: doc.description.slice(0, 320) }) : null,
    el('div', { class: 'detail-stats' }, statBlocks.map(([label, value]) => el('div', {}, [
      el('div', { class: 'detail-stat-value', text: value }),
      el('div', { class: 'detail-stat-label', text: label }),
    ]))),
  ]));

  const profile = buildProfile(doc);
  if (profile) {
    const section = el('div', { class: 'panel-section' }, [
      sectionTitle('Elevation profile', icons.mountain),
    ]);
    section.append(renderProfile(profile));
    dom.details.append(section);
  }

  const features = doc.geojson.features;
  const waypoints = features.filter((f) => f.properties.kind === 'waypoint');
  const lines = features.filter((f) => f.properties.kind !== 'waypoint' && f.properties.kind !== 'area');

  if (lines.length) dom.details.append(featureSection('Tracks & routes', lines, entry));
  if (waypoints.length) dom.details.append(featureSection('Waypoints', waypoints, entry));

  dom.details.append(el('div', { class: 'panel-section' }, [
    el('div', { style: 'display:flex; gap:8px; flex-wrap:wrap' }, [
      el('button', {
        class: 'button button-secondary button-small', html: `${icons.download}<span>GeoJSON</span>`,
        onclick: () => downloadText(`${entry.key}.geojson`, JSON.stringify(entry.doc.geojson, null, 2), 'application/geo+json'),
      }),
      entry.slug
        ? el('a', {
          class: 'button button-secondary button-small', href: sourceURLFor(entry), download: '',
          html: `${icons.file}<span>Original file</span>`,
        })
        : null,
    ]),
  ]));
}


function sourceURLFor(entry) {
  const record = findMap(state.catalog, entry.slug);
  return record ? (record.path || `data/maps/${record.file}`) : '#';
}

function featureSection(title, features, entry) {
  const list = el('ul', { class: 'feature-list' });
  for (const feature of features.slice(0, 400)) {
    const color = feature.properties.color || entry.color;
    list.append(el('li', {
      role: 'button', tabindex: '0',
      onclick: () => focusFeature(feature),
      onkeydown: (event) => { if (event.key === 'Enter') focusFeature(feature); },
      onmouseenter: () => setHighlight(feature),
      onmouseleave: () => setHighlight(null),
    }, [
      el('span', { class: 'feature-dot', style: `background:${color}` }),
      el('span', { class: 'feature-name', text: feature.properties.name || 'Untitled' }),
      el('span', {
        class: 'feature-meta',
        text: feature.properties.distance_m ? formatDistance(feature.properties.distance_m, state.units) : '',
      }),
    ]));
  }
  const section = el('div', { class: 'panel-section' }, [
    el('h2', { class: 'panel-title' }, [
      el('span', { text: title }),
      el('span', { class: 'count', text: String(features.length) }),
    ]),
  ]);
  section.append(list);
  if (features.length > 400) section.append(el('p', { class: 'hint', text: `Showing the first 400 of ${features.length}.` }));
  return section;
}

function focusFeature(feature) {
  if (feature.geometry?.type === 'Point') {
    state.map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 13), duration: 600 });
    showFeaturePopup(feature, feature.geometry.coordinates);
  } else {
    fitTo(geojsonBounds({ type: 'FeatureCollection', features: [feature] }));
    setHighlight(feature);
  }
}

/* ------------------------------------------------------------------ folders */

/**
 * Folder features render from one source, coloured per folder. Keeping them in a
 * single source (rather than one per folder) means toggling a folder's
 * visibility is a data refresh, not a layer rebuild.
 */
function addFolderLayers() {
  if (!styleReady()) { whenStyleReady(addFolderLayers); return; }
  if (!state.map.getSource(FOLDER_SOURCE)) return;
  // A style swap discards every registered image, so re-add them each time.
  registerPinImages(state.map);
  const color = ['coalesce', ['get', 'folderColor'], '#b4441f'];
  const [casing, line, halo, point, iconLayer] = FOLDER_LAYERS;

  if (!state.map.getLayer(casing)) {
    state.map.addLayer({
      id: casing, type: 'line', source: FOLDER_SOURCE, filter: IS_LINE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(255,255,255,0.85)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 7.5, 16, 10],
      },
    });
  }
  if (!state.map.getLayer(line)) {
    state.map.addLayer({
      id: line, type: 'line', source: FOLDER_SOURCE, filter: IS_LINE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 4, 16, 6],
        'line-dasharray': [2.5, 1.4],
      },
    });
  }
  // A pin is three layers: a white halo, a disc carrying the pin's colour, and
  // a white glyph on top. Splitting colour from glyph means N icons cost N map
  // images rather than one per icon-and-colour pair.
  const pinColor = ['coalesce', ['get', 'pinColor'], ['get', 'folderColor'], '#b4441f'];

  if (!state.map.getLayer(halo)) {
    state.map.addLayer({
      id: halo, type: 'circle', source: FOLDER_SOURCE, filter: IS_POINT,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 9, 15, 13],
        'circle-color': 'rgba(255,255,255,0.95)',
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(0,0,0,0.14)',
      },
    });
  }
  if (!state.map.getLayer(point)) {
    state.map.addLayer({
      id: point, type: 'circle', source: FOLDER_SOURCE, filter: IS_POINT,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7.5, 15, 11],
        'circle-color': pinColor,
      },
    });
    bindFeatureInteractions(point);
    bindFeatureInteractions(line);
  }
  if (!state.map.getLayer(iconLayer)) {
    state.map.addLayer({
      id: iconLayer, type: 'symbol', source: FOLDER_SOURCE, filter: IS_POINT,
      layout: {
        'icon-image': ['concat', 'pin-', ['coalesce', ['get', 'pinIcon'], DEFAULT_PIN_ICON]],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 15, 0.72],
        // Pins must never be dropped for collision — a hidden saved waypoint is
        // worse than an overlapping one.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    bindFeatureInteractions(iconLayer);
  }
}

/** Move folder layers (and the profile cursor) back to the top of the stack. */
function raiseFolderLayers() {
  if (!styleReady()) return;
  for (const id of FOLDER_LAYERS) {
    if (state.map.getLayer(id)) state.map.moveLayer(id);
  }
  if (state.map.getLayer('scratch-cursor-point')) state.map.moveLayer('scratch-cursor-point');
}

function refreshFolderData() {
  if (!styleReady()) { whenStyleReady(refreshFolderData); return; }
  try {
    const source = state.map.getSource(FOLDER_SOURCE);
    if (source) source.setData(state.folders.toGeoJSON({ visibleOnly: true }));
  } catch (error) {
    console.warn('[map] could not refresh folder data:', error.message);
  }
}

function wireFolders() {
  dom.newFolder?.addEventListener('click', () => {
    const folder = state.folders.create(`Folder ${state.folders.list().length + 1}`);
    openTab('folders');
    // Drop straight into renaming — a folder called "Folder 3" is never the goal.
    requestAnimationFrame(() => {
      const field = dom.folderList.querySelector(`[data-folder="${folder.id}"] .folder-name`);
      field?.focus();
      field?.select?.();
    });
  });
  /*
   * A trip is a folder with dates on it.
   *
   * Not a separate kind of thing, because everything a trip needs — a name, a
   * colour, pins, visibility, export, sync — a folder already does, and a
   * second implementation of all of it for the sake of two dates would be two
   * of everything to keep in step.
   *
   * Defaulted to a long weekend from today rather than left blank: a trip with
   * no dates is a folder, and the point of the button is the dates.
   */
  dom.newTrip?.addEventListener('click', () => {
    const from = localDay();
    const to = localDay(new Date(Date.now() + 2 * 86400000));
    const folder = state.folders.create('Trip', { trip: { from, to } });
    openTab('folders');
    requestAnimationFrame(() => {
      const field = dom.folderList.querySelector(`[data-folder="${folder.id}"] .folder-name`);
      field?.focus();
      field?.select?.();
    });
  });
  dom.importIntoFolder?.addEventListener('click', () => toggleImportPicker());
}

/*
 * A trip whose last day has passed stands itself down, once.
 *
 * "Temporary pins for a duration" cannot mean deleting them: the trip is over
 * exactly when you get home with photographs to match to the places, and an
 * app that had tidied them away by then would have destroyed the record. So
 * the pins come off the map and stay in the folder, and the bar on the folder
 * offers to clear them when you have finished with them.
 *
 * Once, because a trip you deliberately switch back on must not be switched
 * off again by the next render.
 */
function retireFinishedTrips() {
  for (const folder of state.folders.list()) {
    if (!folder.trip || folder.trip.retired) continue;
    if (tripStanding(folder.trip)?.state !== 'over') continue;
    state.folders.setTrip(folder.id, { ...folder.trip, retired: true });
    if (folder.visible) state.folders.update(folder.id, { visible: false });
  }
}

/*
 * What the planner assumes, and where those assumptions are kept.
 *
 * On the device rather than on the folder: how fast you drive and how long you
 * stop is a fact about you, not about this trip, and re-entering it for every
 * trip would guarantee it is wrong on most of them.
 */
const TRIP_SETTINGS_KEY = 'ab-maps-trip-settings';

function tripSettings() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(TRIP_SETTINGS_KEY) || '{}');
    return { ...TRIP_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...TRIP_DEFAULTS };
  }
}

function saveTripSettings(patch) {
  const next = { ...tripSettings(), ...patch };
  try {
    globalThis.localStorage?.setItem(TRIP_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Full or blocked storage: the change still applies for this session.
  }
  return next;
}

/** The stops a trip is planned around: its waypoints, in the order they sit in. */
function tripStops(folder) {
  return folder.items
    .filter((item) => item.feature.geometry?.type === 'Point')
    .map((item) => ({
      id: item.id,
      name: item.feature.properties?.name || 'Unnamed',
      position: item.feature.geometry.coordinates,
    }));
}

/** How many days a trip's dates cover, counting both ends. */
function tripDayCount(trip) {
  if (!trip) return null;
  const from = Date.parse(`${trip.from}T00:00:00Z`);
  const to = Date.parse(`${trip.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000) + 1;
}

/**
 * What the queue actually costs: miles, days, and the things people forget.
 *
 * The problem in the words it was reported in — "I put too much in my queue
 * and forget how far everything is between each other. And then I don't add
 * time in to eat, refuel, and sleep." A list of pins says nothing about any of
 * that, and the gap between the list and the week is where trips go wrong.
 *
 * It is an estimate and says so. There is no route here — straight lines bent
 * by a winding factor — because a real route needs a network the app cannot
 * reach from a trailhead, and because the answer that matters is "three days,
 * not a weekend", which a rough number gets right.
 */
function tripPlanBlock(folder) {
  const stops = tripStops(folder);
  const settings = tripSettings();
  const days = tripDayCount(folder.trip);
  const plan = planTrip(stops, { ...settings, days });

  const block = el('details', {
    class: 'trip-plan',
    open: state.openTripPlans.has(folder.id),
    ontoggle: (event) => {
      if (event.target.open) state.openTripPlans.add(folder.id);
      else state.openTripPlans.delete(folder.id);
    },
  });

  block.append(el('summary', { class: 'trip-plan-summary' }, [
    el('span', { class: 'trip-plan-title', text: 'The drive' }),
    el('span', {
      class: 'trip-plan-headline',
      text: stops.length < 2
        ? 'add stops'
        : `${Math.round(plan.totals.miles)} mi · ${spellHours(plan.totals.driveMinutes)} driving`,
    }),
  ]));

  if (stops.length < 2) {
    block.append(el('p', {
      class: 'hint', style: 'margin:8px 0 0',
      text: 'Save two or more waypoints into this folder and it will work out how far apart '
        + 'they are, how many days that is, and where the days break.',
    }));
    return block;
  }

  block.append(el('p', { class: `trip-verdict is-${plan.verdict.state}`, text: plan.verdict.text }));
  block.append(tripDayList(plan, stops));
  block.append(tripQueue(folder, plan, stops));
  block.append(tripKnobs(folder, settings));

  block.append(el('p', {
    class: 'source-note',
    text: 'Distances are straight lines with a winding factor, not routes — near enough to '
      + 'tell a weekend from a week, not near enough to navigate by.',
  }));

  return block;
}

/** Day by day: what you drive, what it costs, and where you sleep. */
function tripDayList(plan, stops) {
  return el('ol', { class: 'trip-days' }, plan.days.map((day) => el('li', {
    class: `trip-day${day.long ? ' is-long' : ''}`,
  }, [
    el('div', { class: 'trip-day-head' }, [
      el('span', { class: 'trip-day-name', text: `Day ${day.index}` }),
      el('span', {
        class: 'trip-day-cost',
        text: `${Math.round(day.miles)} mi · ${spellHours(day.driveMinutes)} driving`,
      }),
    ]),
    el('div', {
      class: 'trip-day-route',
      text: day.stops.map((index) => stops[index].name).join(' → '),
    }),
    /*
     * The line that answers the complaint.
     *
     * Driving hours are the number people quote themselves and the reason the
     * day overruns; this is the whole day, with the eating and the fuel and
     * the time actually spent at the places that are the point of going.
     */
    el('div', {
      class: 'trip-day-total',
      text: `${spellHours(day.totalMinutes)} out, all in — ${spellHours(day.stopMinutes)} at stops, `
        + `${spellHours(day.mealMinutes)} eating${day.fuelMinutes ? `, ${spellHours(day.fuelMinutes)} fuel` : ''}`,
    }),
    day.long
      ? el('div', { class: 'trip-day-warn', text: 'One leg here is longer than a whole day of driving.' })
      : null,
    el('div', { class: 'trip-day-night', text: `Overnight near ${stops[day.to].name}` }),
  ])));
}

/**
 * The queue itself, in driving order, with the gap to the next stop on each.
 *
 * Ordered by hand because the order is a judgement — light at one place, a
 * booking at another — and offered a reorder because a queue built by dropping
 * pins as you find them is never in a sensible driving order.
 */
function tripQueue(folder, plan, stops) {
  const rows = stops.map((stop, index) => {
    const leg = plan.legs[index];
    return el('li', { class: 'trip-stop' }, [
      el('span', { class: 'trip-stop-number', text: String(index + 1) }),
      el('span', { class: 'trip-stop-name', text: stop.name }),
      leg
        ? el('span', {
          class: 'trip-stop-gap',
          text: `${Math.round(leg.miles)} mi · ${spellHours(leg.minutes)}`,
        })
        : el('span', { class: 'trip-stop-gap is-last', text: 'last' }),
      el('span', { class: 'trip-stop-moves' }, [
        el('button', {
          class: 'icon-button trip-move', type: 'button',
          title: 'Earlier in the trip', 'aria-label': `Move ${stop.name} earlier`,
          disabled: index === 0,
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
          onclick: () => moveTripStop(folder, index, index - 1),
        }),
        el('button', {
          class: 'icon-button trip-move', type: 'button',
          title: 'Later in the trip', 'aria-label': `Move ${stop.name} later`,
          disabled: index === stops.length - 1,
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
          onclick: () => moveTripStop(folder, index, index + 1),
        }),
      ]),
    ]);
  });

  const optimise = labelledButton(icons.route, 'Put them in a sensible order', {
    tone: 'secondary',
    title: 'Reorder the stops after the first into a shorter drive',
    onclick: () => {
      const current = tripStops(folder);
      const result = optimiseOrder(current, { winding: tripSettings().winding });
      const saved = Math.round(result.milesBefore - result.milesAfter);
      if (saved <= 0) {
        toast('Already about as short as it gets.', { tone: 'info' });
        return;
      }
      state.folders.reorder(folder.id, result.order.map((index) => current[index].id));
      toast(`Reordered — about ${saved} miles shorter.`);
    },
  });
  optimise.classList.add('trip-optimise');

  return el('div', { class: 'trip-queue' }, [
    el('p', { class: 'trip-queue-title', text: 'In this order' }),
    el('ol', { class: 'trip-stops' }, rows),
    optimise,
  ]);
}

/** Move one stop in the queue, keeping everything else where it was. */
function moveTripStop(folder, from, to) {
  const stops = tripStops(folder);
  if (to < 0 || to >= stops.length) return;
  const ids = stops.map((stop) => stop.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  state.folders.reorder(folder.id, ids);
}

/**
 * The assumptions, editable, because they are guesses about you.
 *
 * Shown rather than buried: a plan you cannot argue with is a plan you cannot
 * trust, and the first thing anybody wants to say to an estimate like this is
 * "I drive faster than that".
 */
function tripKnobs(folder, settings) {
  const knob = (key, label, note, { min, max, step = 1 }) => el('label', { class: 'trip-knob' }, [
    el('span', { class: 'trip-knob-label', text: label }),
    el('input', {
      type: 'number', class: 'trip-knob-input',
      value: String(settings[key]), min: String(min), max: String(max), step: String(step),
      onchange: (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value) || value < min || value > max) {
          event.target.value = String(settings[key]);
          return;
        }
        saveTripSettings({ [key]: value });
        renderFoldersTab();
      },
    }),
    el('span', { class: 'trip-knob-note', text: note }),
  ]);

  return el('details', { class: 'trip-knobs' }, [
    el('summary', { class: 'trip-knobs-summary', text: 'What this assumes' }),
    el('div', { class: 'trip-knob-grid' }, [
      knob('speedMph', 'Average speed', 'mph, door to door — gravel and gates included', { min: 5, max: 80 }),
      knob('drivingHoursPerDay', 'Driving a day', 'hours before it stops being fun', { min: 1, max: 14 }),
      knob('stopMinutes', 'Per stop', 'minutes on the ground at each one', { min: 0, max: 480, step: 5 }),
      knob('winding', 'Winding factor', 'road miles per straight-line mile', { min: 1, max: 2.5, step: 0.05 }),
    ]),
  ]);
}

/**
 * The date strip on a trip folder: when it is, and where that stands today.
 *
 * The standing is the part worth a line of its own. "12–16 Sep" is a fact you
 * have to do arithmetic on; "on now, home Sunday" is the answer, and it is
 * what decides whether this folder is the one you are working in.
 */
function tripBar(folder) {
  const trip = folder.trip;
  const standing = tripStanding(trip);
  if (!standing) return null;

  const day = (value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });

  const words = standing.state === 'ahead'
    ? (standing.days === 1 ? 'tomorrow' : `in ${standing.days} days`)
    : standing.state === 'on'
      ? (standing.days === 0 ? 'last day' : `on now · ${standing.days} day${standing.days === 1 ? '' : 's'} left`)
      : (standing.days === 1 ? 'ended yesterday' : `ended ${standing.days} days ago`);

  const dates = el('div', { class: 'trip-dates' }, [
    el('input', {
      type: 'date', class: 'trip-date', value: trip.from, 'aria-label': `${folder.name} starts`,
      onchange: (event) => state.folders.setTrip(folder.id, { ...trip, from: event.target.value, retired: false }),
    }),
    el('span', { class: 'trip-dash', text: '–' }),
    el('input', {
      type: 'date', class: 'trip-date', value: trip.to, 'aria-label': `${folder.name} ends`,
      // Editing the end date un-retires it: moving a trip forward is exactly
      // how somebody says "it is not over".
      onchange: (event) => state.folders.setTrip(folder.id, { ...trip, to: event.target.value, retired: false }),
    }),
  ]);

  const actions = el('div', { class: 'trip-actions' });
  if (standing.state === 'over') {
    actions.append(labelledButton(icons.trash, 'Clear the pins', {
      tone: 'ghost',
      title: `Remove every pin in ${folder.name}, keeping the folder`,
      onclick: () => {
        const count = folder.items.length;
        if (!count) return;
        // eslint-disable-next-line no-alert
        if (!window.confirm(`Remove ${count} pin${count === 1 ? '' : 's'} from “${folder.name}”? This cannot be undone.`)) return;
        for (const item of [...folder.items]) state.folders.removeItem(folder.id, item.id);
        toast(`Cleared ${count} pin${count === 1 ? '' : 's'} from “${folder.name}”.`);
      },
    }));
    actions.append(labelledButton(icons.folder, 'Keep them', {
      tone: 'ghost',
      title: 'Make this an ordinary folder and stop calling it a trip',
      onclick: () => {
        state.folders.setTrip(folder.id, null);
        toast(`“${folder.name}” is an ordinary folder now.`);
      },
    }));
  }

  return el('div', { class: `trip-bar is-${standing.state}` }, [
    el('div', { class: 'trip-line' }, [
      el('span', { class: 'trip-mark', html: icons.calendar }),
      el('span', { class: 'trip-when', text: `${day(trip.from)} – ${day(trip.to)}` }),
      el('span', { class: 'trip-standing', text: words }),
    ]),
    dates,
    tripPlanBlock(folder),
    actions.childNodes.length ? actions : null,
  ]);
}

function renderFoldersTab() {
  if (!dom.folderList) return;
  retireFinishedTrips();
  const folders = state.folders.list();
  const totals = state.folders.totals();
  dom.folderTotals.textContent = totals.folders
    ? `${totals.waypoints} waypoint${totals.waypoints === 1 ? '' : 's'}${totals.tracks ? `, ${totals.tracks} track${totals.tracks === 1 ? '' : 's'}` : ''}`
    : '';

  // Only offer to file from an open file when one is actually open. The button
  // used to be permanently visible and answered a click with an error toast,
  // which is a poor way to learn what a control is for. Its old label said
  // "import from a map", where "a map" meant "a file you opened" — that is the
  // app's word, not the reader's.
  if (dom.importIntoFolder) dom.importIntoFolder.hidden = state.documents.size === 0;

  const existingPicker = dom.folderList.querySelector('.picker');
  dom.folderList.replaceChildren();
  if (existingPicker) dom.folderList.append(existingPicker);

  renderSavedOffline();

  if (!folders.length) {
    dom.folderList.append(el('p', {
      class: 'hint',
      html: 'No folders yet. Open a file above and you will be asked where to put it, '
        + 'or click any point on the map and save it into one.',
    }));
    return;
  }

  for (const folder of folders) {
    dom.folderList.append(renderFolder(folder));
  }

  restoreOpenEditor();
}

/**
 * What is on the device: the ground taken offline, and the pictures kept.
 *
 * These live under Folders rather than in the offline menu they are managed
 * from, and the reason is what a person is doing when they look. The menu is
 * where you plan a download — you are online, at a table, deciding. This is
 * where you check what you actually have, which is a question asked in a car
 * park with one bar of signal, in the same panel as everything else you saved.
 *
 * Async because both answers live in IndexedDB, and rendered into a section
 * that is already on screen rather than awaited before the panel opens: the
 * rest of Folders must not wait on a disk read to draw.
 */
async function renderSavedOffline() {
  const node = dom.offlineSaved;
  if (!node) return;

  const regions = state.offline.list();
  let snapshots = [];
  let stored = new Map();
  try {
    [snapshots, stored] = await Promise.all([
      listSnapshots(),
      openTileStore().then((store) => store.archives?.() ?? new Map()),
    ]);
  } catch {
    // A blocked or private-mode IndexedDB answers nothing rather than throwing
    // the panel away. The counts simply read as none.
  }

  // The node can have been replaced while the disk was read.
  if (node !== dom.offlineSaved) return;
  node.replaceChildren();

  const totalTiles = [...stored.values()].reduce((sum, one) => sum + one.tiles, 0);
  const totalBytes = [...stored.values()].reduce((sum, one) => sum + one.bytes, 0)
    + snapshots.reduce((sum, one) => sum + (one.bytes || 0), 0);
  if (dom.offlineSavedCount) {
    dom.offlineSavedCount.textContent = totalBytes ? formatBytes(totalBytes) : '';
  }

  /*
   * Tiles belonging to an archive this map no longer reads.
   *
   * The store keys every tile by the archive it came out of, so the day that
   * URL changes — a copy beside the site becoming a bucket, one bucket
   * becoming another — every tile already here stops being reachable. Nothing
   * about that is an error: the reader looks under the new name, finds
   * nothing, and asks the network, which is exactly what it should do. It just
   * means the map quietly stopped working offline while still holding the
   * space, and the only moment that gets noticed is the moment there is no
   * signal.
   */
  const current = archiveURLNow();
  const orphans = [...stored].filter(([name]) => name !== current);
  if (orphans.length) {
    const bytes = orphans.reduce((sum, [, one]) => sum + one.bytes, 0);
    const tiles = orphans.reduce((sum, [, one]) => sum + one.tiles, 0);
    node.append(el('div', { class: 'region' }, [
      el('div', { class: 'region-meta' }, [
        el('b', { text: 'From a map that has moved' }),
      ]),
      el('p', {
        class: 'source-note',
        text: `${tiles.toLocaleString()} tiles (${formatBytes(bytes)}) were downloaded from a `
          + 'different copy of the map and cannot be read any more. Downloading these '
          + 'regions again will replace them.',
      }),
      el('button', {
        class: 'button button-secondary button-small', type: 'button',
        text: `Remove ${formatBytes(bytes)}`,
        onclick: async () => {
          const store = await openTileStore();
          let removed = 0;
          for (const [name] of orphans) removed += await store.removeArchive?.(name) ?? 0;
          toast(`Removed ${removed.toLocaleString()} tiles from a map that has moved.`);
          renderSavedOffline();
        },
      }),
    ]));
  }

  if (!regions.length && !snapshots.length && !totalTiles) {
    node.append(el('p', {
      class: 'hint',
      text: 'Nothing saved yet. Use the download button above the map to mark ground to take '
        + 'with you, or the camera to keep a picture of the view.',
    }));
    return;
  }

  if (regions.length) {
    node.append(el('h3', { class: 'offline-heading', text: 'Map regions' }));
    for (const region of regions) {
      const held = stored.get(current);
      const row = el('div', { class: 'region' }, [
        el('div', { class: 'region-head' }, [
          el('b', { class: 'region-name-static', text: region.name }),
          el('button', {
            class: 'icon-button', type: 'button', title: `Show ${region.name}`,
            html: icons.target,
            onclick: () => {
              const { west, south, east, north } = region.bounds;
              state.map.fitBounds([[west, south], [east, north]], { padding: 40, duration: 600 });
            },
          }),
        ]),
        el('div', {
          class: 'region-meta',
          text: `z${region.minZoom}–${region.maxZoom} · ${region.basemapName || 'no basemap recorded'}`
            + (held ? ` · ${held.tiles.toLocaleString()} tiles held` : ' · not downloaded'),
        }),
      ]);
      const drift = archiveDrift(region, current);
      if (drift) row.append(staleRegionNotice(region, drift));
      node.append(row);
    }
  }

  if (snapshots.length) {
    node.append(el('h3', { class: 'offline-heading', text: 'Pictures' }));
    for (const shot of snapshots) node.append(snapshotRow(shot));
  }
}

/**
 * The out-of-date banner on a downloaded region, with both ways out.
 *
 * Flagged rather than cleared automatically, which was a deliberate choice:
 * the whole point of a download is having it where there is no signal, and
 * deleting it on the user's behalf is the one action that cannot be undone in
 * a car park with one bar. The stale tiles keep working until somebody says
 * otherwise - they are a slightly older map, not a broken one.
 */
function staleRegionNotice(region, drift) {
  const note = el('div', { class: 'region-stale' });
  const status = el('span', { class: 'region-stale-status' });

  note.append(el('p', {
    class: 'region-stale-why',
    text: drift === 'moved'
      ? 'Downloaded from a map file this app no longer reads, so these tiles are '
        + 'taking up space without being used.'
      : 'The map has been re-cut since this was downloaded. These tiles still work '
        + 'and are used before the network, so this ground stays as it was.',
  }));


  const again = el('button', {
    class: 'button button-secondary button-small', type: 'button', text: 'Re-download',
    onclick: async () => {
      const archiveURL = PROTOMAPS_ARCHIVE;
      if (!archiveURL) { status.textContent = 'No map archive is configured.'; return; }
      again.disabled = true;
      drop.disabled = true;
      status.textContent = 'Downloading…';
      try {
        /*
         * The old tiles go first, and that ordering is the point.
         *
         * A download only writes what it fetches, so a re-download over the
         * same keys would leave anything the new archive does not answer for
         * sitting there from the old one - a region half of one generation and
         * half of another, which is worse than either.
         */
        const store = await openTileStore();
        await store.remove?.(regionTileKeys(region));
        const tiers = [];
        for (let zoom = region.minZoom; zoom <= region.maxZoom; zoom += 1) {
          tiers.push({ zoom, boxes: [region.bounds] });
        }
        const name = new URL(archiveURL, document.baseURI).href;
        const result = await downloadArchiveTiles(tileKeysFor(tiers), {
          archive: new PMTilesArchive(name),
          store,
          name,
          onProgress: (done, failed) => {
            status.textContent = `${done.toLocaleString()} saved${failed ? ` · ${failed} unavailable` : ''}`;
          },
        });
        stampArchive(region, archiveURL);
        status.textContent = `${result.done.toLocaleString()} tiles saved.`;
        renderSavedOffline();
      } catch (error) {
        status.textContent = error.message || 'The download could not start.';
        again.disabled = false;
        drop.disabled = false;
      }
    },
  });

  const drop = el('button', {
    class: 'button button-secondary button-small', type: 'button', text: 'Discard tiles',
    onclick: async () => {
      again.disabled = true;
      drop.disabled = true;
      status.textContent = 'Removing…';
      try {
        const store = await openTileStore();
        const removed = await store.remove?.(regionTileKeys(region)) ?? 0;
        /*
         * The region itself stays, with its stamp cleared. It is a rectangle
         * somebody drew and named; the tiles are what was thrown away, and
         * taking the rectangle too would mean drawing it again to get it back.
         */
        state.offline.update(region.id, { archive: '', archiveDepth: 0 });
        toast(`Removed ${removed.toLocaleString()} out-of-date tiles.`);
        renderSavedOffline();
      } catch (error) {
        status.textContent = error.message || 'Those tiles could not be removed.';
        again.disabled = false;
        drop.disabled = false;
      }
    },
  });

  note.append(el('div', { class: 'region-controls' }, [again, drop, status]));
  return note;
}

/** One saved picture: a thumbnail, where it was taken, and a way to be rid of it. */
function snapshotRow(shot) {
  const thumb = el('img', {
    class: 'snapshot-thumb', alt: `Saved view at ${shot.caption || 'an unrecorded place'}`, loading: 'lazy',
  });
  /*
   * The object URL is revoked when the row leaves the document rather than on
   * a timer. A list of these rebuilt on every folder change would otherwise
   * leak one blob URL per render, and the blobs are megabytes.
   */
  photoURL(shot.id).then((url) => {
    if (!url) return;
    thumb.src = url;
    thumb.addEventListener('load', () => {
      if (!thumb.isConnected) URL.revokeObjectURL(url);
    });
  }).catch(() => {});

  return el('div', { class: 'region snapshot' }, [
    thumb,
    el('div', { class: 'snapshot-body' }, [
      el('div', { class: 'region-meta', text: shot.caption || shot.name || 'Saved view' }),
      el('div', { class: 'region-meta', text: `${formatDate(shot.added) || ''} · ${formatBytes(shot.bytes || 0)}` }),
    ]),
    el('button', {
      class: 'icon-button', type: 'button', title: 'Delete this picture',
      html: icons.trash,
      onclick: async () => {
        await deletePhoto(shot.id);
        toast('Picture removed.');
        renderSavedOffline();
      },
    }),
  ]);
}

/** The archive the map is reading right now, absolute, or '' when there is none. */
function archiveURLNow() {
  if (!PROTOMAPS_ARCHIVE) return '';
  try {
    return new URL(PROTOMAPS_ARCHIVE, document.baseURI).href;
  } catch {
    return PROTOMAPS_ARCHIVE;
  }
}

/** Re-open the pin editor after a re-render, anchored to its row again. */
function restoreOpenEditor() {
  const open = state.openEditor;
  if (!open) return;
  const folder = state.folders.get(open.folderId);
  if (!folder) { state.openEditor = null; return; }

  const anchor = open.itemIds?.length === 1
    ? dom.folderList.querySelector(`[data-item="${open.itemIds[0]}"]`)
    : dom.folderList.querySelector(`[data-folder="${folder.id}"] .folder-head`);
  if (!anchor) { state.openEditor = null; return; }

  openStyleEditor(folder, open.itemIds, anchor);
}

function renderFolder(folder) {
  const counts = state.folders.counts(folder);
  const chosen = selectedIn(folder.id);

  const node = el('section', {
    class: `folder${folder.collapsed ? ' is-collapsed' : ''}`,
    dataset: { folder: folder.id },
  });

  const head = el('div', { class: 'folder-head' }, [
    el('button', {
      class: 'folder-disclosure', type: 'button',
      'aria-label': folder.collapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`,
      'aria-expanded': String(!folder.collapsed),
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
      onclick: () => state.folders.update(folder.id, { collapsed: !folder.collapsed }),
    }),
    /*
     * An eye, not a checkbox. A checkbox beside a name in a list of names reads
     * as "selected", which is what the checkbox on each pin below it actually
     * means — so the same control did two different jobs one level apart. An
     * eye only ever means one thing.
     */
    el('button', {
      class: `icon-button folder-eye${folder.visible ? '' : ' is-hidden'}`,
      type: 'button',
      title: folder.visible ? `Hide ${folder.name} on the map` : `Show ${folder.name} on the map`,
      'aria-label': folder.visible ? `Hide ${folder.name} on the map` : `Show ${folder.name} on the map`,
      'aria-pressed': String(folder.visible),
      html: folder.visible ? icons.eye : icons.eyeOff,
      onclick: () => state.folders.update(folder.id, { visible: !folder.visible }),
    }),
    el('button', {
      class: 'folder-swatch', type: 'button', style: `background:${folder.color}`,
      title: 'Change color', 'aria-label': `Change the color of ${folder.name}`,
      onclick: () => {
        const next = FOLDER_COLORS[(FOLDER_COLORS.indexOf(folder.color) + 1) % FOLDER_COLORS.length];
        state.folders.update(folder.id, { color: next });
      },
    }),
    el('input', {
      class: 'folder-name', type: 'text', value: folder.name, 'aria-label': 'Folder name',
      onchange: (event) => state.folders.rename(folder.id, event.target.value),
      onkeydown: (event) => { if (event.key === 'Enter') event.target.blur(); },
    }),
    counts.total ? el('span', { class: 'folder-count', text: String(counts.total) }) : null,
    /*
     * One button, not four.
     *
     * This row carried style, zoom, export and delete as sixteen-pixel icons
     * side by side. On a phone that is four targets inside a thumb's width,
     * with delete next to export — the actions are now labelled buttons in the
     * panel this opens, where there is room for words and for spacing between
     * something reversible and something that is not.
     */
    el('button', {
      class: `folder-menu-button${chosen.length ? ' is-armed' : ''}`,
      type: 'button',
      title: chosen.length
        ? `Actions for the ${chosen.length} selected pin${chosen.length === 1 ? '' : 's'}`
        : `Actions for ${folder.name}`,
      'aria-label': `Actions for ${folder.name}`,
      html: `${icons.brush}<span>Edit</span>`,
      onclick: (event) => openStyleEditor(
        folder,
        chosen.length ? chosen : null,
        event.currentTarget.closest('.folder-head'),
      ),
    }),
  ]);

  const trip = tripBar(folder);

  const body = el('div', { class: 'folder-body' });
  if (!folder.items.length) {
    body.append(el('p', {
      class: 'folder-empty',
      text: folder.trip
        ? 'Nothing planned yet — drop pins for the places you mean to stop.'
        : 'Empty — drag items here, or import from a loaded map.',
    }));
  } else {
    /*
     * Reveal a folder's contents in chunks rather than all at once.
     *
     * A GaiaGPS export runs to four figures — one folder here holds 1,320 —
     * and building that many rows makes the panel slow to open and slow on
     * every re-render after, of which there is one per checkbox tick. Paging is
     * wrong for a tree you are dragging things around inside, so this grows
     * instead: the rest is one click away and the count says what is waiting.
     */
    const shown = state.folderReveal.get(folder.id) || FOLDER_REVEAL_STEP;
    for (const item of folder.items.slice(0, shown)) body.append(renderFolderItem(folder, item));

    const hidden = folder.items.length - shown;
    if (hidden > 0) {
      body.append(el('button', {
        class: 'folder-more', type: 'button',
        text: `Show ${Math.min(hidden, FOLDER_REVEAL_STEP)} more — ${hidden} not shown`,
        onclick: () => {
          state.folderReveal.set(folder.id, shown + FOLDER_REVEAL_STEP);
          renderFoldersTab();
        },
      }));
    }
  }

  // Folders are drop targets so items can be dragged between them.
  node.addEventListener('dragover', (event) => {
    if (!state.dragItem || state.dragItem.folderId === folder.id) return;
    event.preventDefault();
    node.classList.add('is-drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
  node.addEventListener('drop', (event) => {
    node.classList.remove('is-drop-target');
    if (!state.dragItem || state.dragItem.folderId === folder.id) return;
    event.preventDefault();
    const { itemId, folderId } = state.dragItem;
    state.dragItem = null;
    state.folders.moveItem(itemId, folderId, folder.id);
  });

  node.append(head);
  if (trip) node.append(trip);
  node.append(body);
  return node;
}

function renderFolderItem(folder, item) {
  const props = item.feature.properties;
  const isWaypoint = props.kind === 'waypoint';
  const meta = isWaypoint
    ? (props.symbol || props.sourceName || '')
    : (props.distance_m ? formatDistance(props.distance_m, state.units) : '');
  // Descriptions come across from GaiaGPS on most waypoints and are the whole
  // reason a pin is worth keeping — surface them rather than hiding them in a popup.
  const blurb = String(props.description || '').trim();

  const key = selectionKey(folder.id, item.id);
  const color = props.color || folder.color;

  const node = el('div', {
    class: `folder-item${state.selection.has(key) ? ' is-selected' : ''}`, draggable: 'true',
    dataset: { item: item.id },
    ondragstart: (event) => {
      state.dragItem = { itemId: item.id, folderId: folder.id };
      node.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without payload on the transfer.
      event.dataTransfer.setData('text/plain', props.name || 'item');
    },
    ondragend: () => { node.classList.remove('is-dragging'); state.dragItem = null; },
  }, [
    el('input', {
      type: 'checkbox', class: 'folder-item-pick', checked: state.selection.has(key),
      'aria-label': `Select ${props.name} for bulk styling`,
      onchange: (event) => {
        if (event.target.checked) state.selection.add(key); else state.selection.delete(key);
        renderFoldersTab();
      },
    }),
    isWaypoint
      ? el('span', {
        class: 'folder-item-icon', style: `background:${color}`,
        html: pinIconSVG(props.icon || DEFAULT_PIN_ICON, { size: 12, stroke: 2 }),
      })
      : el('span', { class: 'folder-item-kind is-track', style: `background:${color}` }),
    el('span', {
      class: 'folder-item-name', text: props.name, title: props.name,
      role: 'button', tabindex: '0',
      onclick: () => focusFolderItem(item, folder.id),
      onkeydown: (event) => { if (event.key === 'Enter') focusFolderItem(item, folder.id); },
    }),
    meta ? el('span', { class: 'folder-item-meta', text: meta }) : null,
    isWaypoint
      ? el('button', {
        class: 'icon-button', type: 'button', title: 'Edit color and icon',
        'aria-label': `Edit ${props.name}`, html: icons.brush,
        onclick: (event) => openStyleEditor(folder, [item.id], event.currentTarget.closest('.folder-item')),
      })
      : null,
    el('button', {
      class: 'icon-button', type: 'button', title: 'Remove from this folder',
      'aria-label': `Remove ${props.name} from ${folder.name}`, html: icons.close,
      onclick: () => {
        state.selection.delete(key);
        state.folders.removeItem(folder.id, item.id);
      },
    }),
  ]);

  if (!blurb) return node;
  const wrap = document.createDocumentFragment();
  wrap.append(node, el('p', { class: 'folder-item-desc', text: blurb, title: blurb }));
  return wrap;
}

/**
 * Photo strip for one pin: thumbnails of what is stored, plus an add button.
 *
 * Thumbnails come from object URLs, which are revoked when the strip is
 * rebuilt — without that, every re-render would leak the whole image.
 */
function photoSection(folder, item) {
  const section = el('div', {});
  section.append(el('div', { class: 'style-label', text: 'Photos' }));

  const strip = el('div', { class: 'photo-strip' });
  const urls = [];

  const paint = async () => {
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    strip.replaceChildren();
    const photos = item.feature.properties.photos || [];

    for (const photo of photos) {
      const tile = el('div', { class: 'photo-tile' });
      const url = await photoURL(photo.id).catch(() => null);
      if (url) {
        urls.push(url);
        tile.append(el('img', { src: url, alt: photo.caption || photo.name || 'Pin photo', loading: 'lazy' }));
      } else {
        // The record is gone from IndexedDB but the pin still points at it.
        tile.append(el('span', { class: 'photo-missing', text: 'missing' }));
      }
      tile.append(el('button', {
        class: 'photo-remove', type: 'button', title: 'Remove this photo',
        'aria-label': `Remove ${photo.name || 'photo'}`, text: '×',
        onclick: async () => {
          state.folders.removePhoto(folder.id, item.id, photo.id);
          await deletePhoto(photo.id).catch(() => {});
          paint();
        },
      }));
      strip.append(tile);
    }

    if (!photos.length) {
      strip.append(el('p', { class: 'hint', style: 'margin:0', text: 'No photos on this pin yet.' }));
    }
  };

  const picker = el('input', {
    type: 'file', accept: PHOTO_TYPES.join(','), multiple: true, hidden: true,
    onchange: async (event) => {
      const files = [...event.target.files];
      event.target.value = '';
      const stored = [];
      for (const file of files) {
        try {
          stored.push(await putPhoto(file, { name: file.name }));
        } catch (error) {
          toast(error.message, { tone: 'error', timeout: 9000 });
        }
      }
      if (stored.length) {
        state.folders.addPhotos(folder.id, item.id, stored);
        toast(`Added ${stored.length} photo${stored.length === 1 ? '' : 's'}.`, { tone: 'ok' });
      }
      paint();
    },
  });

  const actions = el('div', { class: 'picker-row', style: 'margin-top:8px' }, [
    el('button', {
      class: 'button button-secondary button-small', type: 'button', text: 'Add photos',
      onclick: () => picker.click(),
    }),
  ]);

  // A link the source file carried, e.g. a GaiaGPS photo page.
  const link = item.feature.properties.link;
  if (link) {
    actions.append(el('a', {
      class: 'button button-ghost button-small', href: link, target: '_blank', rel: 'noopener noreferrer',
      text: 'Open source link',
    }));
  }

  section.append(strip, picker, actions);
  paint();
  return section;
}

function focusFolderItem(item, folderId = null, { edit = false } = {}) {
  if (folderId) selectPin(folderId, item.id, { open: false });
  const feature = item.feature;
  if (feature.geometry?.type === 'Point') {
    state.map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 14), duration: 600 });
    showFeaturePopup(feature, feature.geometry.coordinates, {
      edit,
      identity: folderId ? { folderId, itemId: item.id } : null,
    });
  } else {
    const bounds = geojsonBounds({ type: 'FeatureCollection', features: [feature] });
    if (boundsAreValid(bounds)) fitTo(bounds);
    setHighlight(feature);
  }
}

function exportFolder(folder) {
  const geojson = state.folders.folderGeoJSON(folder.id);
  if (!geojson.features.length) {
    toast('That folder is empty, so there is nothing to export.', { tone: 'error' });
    return;
  }
  const filename = `${folder.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'folder'}.gpx`;
  downloadText(filename, toGPX(geojson, { name: folder.name }), 'application/gpx+xml');
  toast(`Exported ${geojson.features.length} item${geojson.features.length === 1 ? '' : 's'} as ${filename}.`, { tone: 'ok' });
}

/* ---------------- waypoints ---------------- */

/**
 * Every saved waypoint in one list, searchable and filterable by folder.
 *
 * The folder tree answers "what is in this trip"; this answers "where did I
 * save that spring" — which is the question you actually have in the field, and
 * which a tree makes you hunt for.
 */
function renderWaypointsTab() {
  if (!dom.waypointList) return;

  const folders = state.folders.list();
  const needle = state.waypointQuery.trim().toLowerCase();

  const rows = [];
  for (const folder of folders) {
    if (state.waypointFolderFilter && folder.id !== state.waypointFolderFilter) continue;
    for (const item of folder.items) {
      if (item.feature.properties.kind !== 'waypoint') continue;
      if (needle) {
        const haystack = `${item.feature.properties.name} ${item.feature.properties.description || ''}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      rows.push({ folder, item });
    }
  }

  rows.sort((a, b) => a.item.feature.properties.name.localeCompare(b.item.feature.properties.name));

  // Keep the folder filter in step without clobbering the current choice.
  const previous = dom.waypointFolder.value;
  dom.waypointFolder.replaceChildren(
    el('option', { value: '', text: 'Every folder' }),
    ...folders.map((folder) => el('option', { value: folder.id, text: folder.name })),
  );
  if (previous && folders.some((folder) => folder.id === previous)) dom.waypointFolder.value = previous;
  dom.waypointFolder.hidden = folders.length < 2;

  const total = folders.reduce((sum, folder) => sum + state.folders.counts(folder).waypoints, 0);
  dom.waypointCount.textContent = needle || state.waypointFolderFilter
    ? `${rows.length} of ${total}` : String(total);

  dom.waypointList.replaceChildren();

  if (!total) {
    dom.waypointList.append(el('p', {
      class: 'hint',
      html: 'No saved waypoints yet. Open a GPX or KML file under <b>Folders</b>, or click a point on the map and save it.',
    }));
    return;
  }
  if (!rows.length) {
    dom.waypointList.append(el('p', { class: 'hint', text: 'Nothing matches that search.' }));
    return;
  }

  /*
   * Paged, because a real GaiaGPS export is not a short list.
   *
   * One folder here holds 1,320 waypoints. Rendering that as 1,320 cards makes
   * the panel slow to open, slow to scroll and impossible to find anything in —
   * and every re-render, of which there is one per selection change, pays for
   * all of it again. Thirty at a time keeps the DOM small, and the search above
   * is the tool for reaching across pages.
   */
  const pages = Math.max(1, Math.ceil(rows.length / WAYPOINT_PAGE_SIZE));
  const page = Math.min(Math.max(0, state.waypointPage), pages - 1);
  if (page !== state.waypointPage) state.waypointPage = page;

  const from = page * WAYPOINT_PAGE_SIZE;
  const visible = rows.slice(from, from + WAYPOINT_PAGE_SIZE);

  for (const { folder, item } of visible) {
    dom.waypointList.append(waypointCard(folder, item));
  }

  if (pages > 1) dom.waypointList.append(waypointPager(page, pages, rows.length, from, visible.length));
}

/** How many waypoint cards render at once. */
const WAYPOINT_PAGE_SIZE = 30;
/** How much of a field note fits on a card before it stops being a glance. */
const NOTE_PREVIEW = 200;

/** How many folder rows appear before "show more", and how many each click adds. */
const FOLDER_REVEAL_STEP = 40;

/**
 * One waypoint, as a card.
 *
 * The symbol goes beside the name as a mark rather than being spelled out in a
 * column of text — "Waterfall" written next to a waterfall icon is the icon
 * said twice — and the description gets its own line, since on an imported pin
 * that note is usually the only thing distinguishing it from the forty others
 * on the same creek.
 */
function waypointCard(folder, item) {
  const props = item.feature.properties;
  const selected = state.selectedPin?.itemId === item.id;
  const blurb = String(props.description || '').trim();

  const open = () => { focusFolderItem(item, folder.id); selectPin(folder.id, item.id); };

  return el('div', {
    class: `waypoint-card${selected ? ' is-selected' : ''}`,
    role: 'button', tabindex: '0',
    onclick: open,
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } },
  }, [
    el('span', {
      class: 'waypoint-mark', style: `background:${props.color || folder.color}`,
      title: props.symbol || '',
      html: pinIconSVG(props.icon || DEFAULT_PIN_ICON, { size: 14, stroke: 2 }),
    }),
    el('div', { class: 'waypoint-body' }, [
      el('div', { class: 'waypoint-head' }, [
        el('span', { class: 'waypoint-name', text: props.name, title: props.name }),
      ]),
      blurb ? el('p', { class: 'waypoint-blurb', text: blurb }) : null,
      // The newest field note, trimmed. "Gate locked" is the thing you want off
      // the card rather than two taps into the panel, and it is what makes the
      // list worth scanning rather than only worth searching.
      noteLine(props),
      el('div', { class: 'waypoint-foot' }, [
        el('span', { class: 'waypoint-folder', text: folder.name }),
        props.symbol ? el('span', { class: 'waypoint-symbol', text: props.symbol }) : null,
      ]),
    ]),
    el('button', {
      class: 'icon-button waypoint-edit', type: 'button',
      title: `Edit ${props.name}`, 'aria-label': `Edit ${props.name}`,
      html: icons.brush,
      onclick: (event) => {
        // The card behind this button opens the pin; the button opens it ready
        // to edit, on the map, where the pin you are changing is visible.
        event.stopPropagation();
        focusFolderItem(item, folder.id, { edit: true });
      },
    }),
  ]);
}

/** The newest field note as one trimmed line, or nothing if there is none. */
function noteLine(props) {
  const latest = latestNote(props);
  if (!latest?.text) return null;

  const text = String(latest.text);
  return el('p', { class: 'waypoint-note' }, [
    el('span', { class: 'waypoint-note-mark', html: icons.note }),
    el('span', {
      text: text.length > NOTE_PREVIEW ? `${text.slice(0, NOTE_PREVIEW).trimEnd()}…` : text,
    }),
  ]);
}

/** Page controls, stating what you are looking at rather than only its number. */
function waypointPager(page, pages, total, from, shown) {
  const go = (next) => {
    state.waypointPage = Math.min(Math.max(0, next), pages - 1);
    renderWaypointsTab();
    dom.waypointList.scrollTop = 0;
  };

  return el('div', { class: 'waypoint-pager' }, [
    el('button', {
      class: 'button button-ghost button-small', type: 'button', text: 'Previous',
      disabled: page === 0 || undefined,
      onclick: () => go(page - 1),
    }),
    el('span', {
      class: 'waypoint-pager-note',
      text: `${from + 1}–${from + shown} of ${total}`,
    }),
    el('button', {
      class: 'button button-ghost button-small', type: 'button', text: 'Next',
      disabled: page >= pages - 1 || undefined,
      onclick: () => go(page + 1),
    }),
  ]);
}

/* ---------------- account ---------------- */

/**
 * Sign-in panel and sync status.
 *
 * Rendered entirely from account state so there is one source of truth for
 * what is on screen. When Supabase is not configured the section explains that
 * folders are device-only rather than showing a sign-in form that cannot work.
 */
function renderAccount() {
  if (!dom.account) return;
  const account = state.account;
  dom.account.replaceChildren();

  // The header shows state; the panel behind it holds the controls. Signed out
  // this is one word, which is all it should ever have been — it was a whole
  // panel section competing with folders for the reader's attention.
  if (dom.accountMenu) dom.accountMenu.hidden = !accountsAvailable();
  if (dom.accountTrigger) {
    const email = account?.user?.email || '';
    dom.accountTrigger.textContent = account?.user
      ? (email ? email.split('@')[0].slice(0, 14) : 'Account')
      : 'Sign in';
    dom.accountTrigger.classList.toggle('is-in', Boolean(account?.user));
    dom.accountTrigger.title = account?.user ? email : 'Sign in to sync folders between devices';
  }

  if (!accountsAvailable()) {
    dom.account.append(el('p', {
      class: 'hint',
      text: 'Accounts are not set up for this deployment, so folders stay in this browser.',
    }));
    return;
  }

  if (account.user) {
    state.accountEmail = '';
    const totals = state.folders.totals();
    dom.account.append(
      el('div', { class: 'account-row' }, [
        el('div', { class: 'account-who' }, [
          el('div', { class: 'account-email', text: account.user.email || 'Signed in' }),
          el('div', {
            class: 'account-meta',
            text: account.status === 'syncing'
              ? 'Syncing…'
              : `${totals.folders} folder${totals.folders === 1 ? '' : 's'} synced`
                + (account.lastSyncAt ? ` · ${new Date(account.lastSyncAt).toLocaleTimeString()}` : ''),
          }),
        ]),
        el('button', {
          class: 'button button-secondary button-small', type: 'button',
          text: account.status === 'syncing' ? 'Syncing…' : 'Sync now',
          disabled: account.status === 'syncing',
          onclick: async () => {
            const result = await account.sync();
            if (result) toast(describeSync(result), { tone: 'ok' });
          },
        }),
        el('button', {
          class: 'button button-ghost button-small', type: 'button', text: 'Sign out',
          // `run` belongs to the signed-out form further down and is not in
          // scope here; this branch has returned before it exists. signOut now
          // swallows a failed server call and clears the device either way, so
          // the only thing left to catch is the unexpected.
          onclick: () => account.signOut().catch((error) => toast(error.message, { tone: 'error' })),
        }),
      ]),
    );
    if (account.message) dom.account.append(el('p', { class: 'hint', text: account.message }));
    return;
  }

  /* signed out */
  const email = el('input', {
    type: 'email', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email',
    value: state.accountEmail,
    oninput: (event) => { state.accountEmail = event.target.value; },
  });
  const password = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const busy = (on) => { for (const node of [email, password, ...buttons]) node.disabled = on; };

  const run = async (action) => {
    state.accountEmail = email.value.trim();
    if (!state.accountEmail) { toast('Enter your email address first.', { tone: 'error' }); return; }
    busy(true);
    try {
      await action();
    } catch (error) {
      toast(error.message, { tone: 'error', timeout: 10000 });
    } finally {
      // No re-render here: the account emits 'change' when the status actually
      // moves, and rebuilding on every attempt would wipe the form mid-typing.
      busy(false);
    }
  };

  const buttons = [
    el('button', {
      class: 'button button-primary button-small', type: 'button', text: 'Sign in',
      onclick: () => run(() => account.signIn(state.accountEmail, password.value)),
    }),
    el('button', {
      class: 'button button-secondary button-small', type: 'button', text: 'Create account',
      onclick: () => run(() => account.signUp(state.accountEmail, password.value)),
    }),
    el('button', {
      class: 'button button-ghost button-small', type: 'button', text: 'Email me a link',
      title: 'Sign in without a password',
      onclick: () => run(() => account.signInWithLink(state.accountEmail)),
    }),
  ];

  /*
   * Apple and Google first, and above the form rather than under it.
   *
   * Not decoration: the emailed link is the part that has broken repeatedly,
   * and a provider round trip has no link to lose. Putting them first offers
   * the route most likely to work before the one that needs an inbox.
   *
   * `run` is not used here - it insists on an email address, and the whole
   * point of these is that you do not type one.
   */
  const provider = (id, label) => el('button', {
    class: 'button button-secondary button-small', type: 'button', text: label,
    onclick: async () => {
      try {
        await account.signInWithProvider(id);
      } catch (error) {
        toast(error.message, { tone: 'error', timeout: 10000 });
      }
    },
  });

  dom.account.append(
    el('p', { class: 'hint', style: 'margin-bottom:10px', text: 'Sign in to keep your folders across devices.' }),
    el('div', { class: 'account-actions' }, [provider('apple', 'Continue with Apple'), provider('google', 'Continue with Google')]),
    el('p', { class: 'hint account-or', text: 'or with an email address' }),
    email,
    password,
    el('div', { class: 'account-actions' }, buttons),
  );
  if (account.message) dom.account.append(el('p', { class: 'hint', style: 'margin-top:9px', text: account.message }));
}

/* ---------------- pin styling ---------------- */

const selectionKey = (folderId, itemId) => `${folderId}:${itemId}`;

function selectedIn(folderId) {
  const prefix = `${folderId}:`;
  return [...state.selection].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

function clearSelection(folderId = null) {
  if (!folderId) { state.selection.clear(); return; }
  for (const id of selectedIn(folderId)) state.selection.delete(selectionKey(folderId, id));
}

/**
 * Inline editor for a pin's colour and icon.
 *
 * One component serves both the single-pin and bulk cases: `itemIds` of null
 * means the whole folder, an array means just those pins. Bulk edits are the
 * common case after an import, where fifty points arrive looking identical.
 */
function openStyleEditor(folder, itemIds, anchor) {
  dom.folderList.querySelectorAll('.style-editor').forEach((node) => node.remove());
  // Saving anything calls emit(), which rebuilds the whole folder list and
  // would take this editor with it. Remember what is open so the rebuild can
  // put it back — otherwise adding a photo or renaming a pin closes the editor
  // out from under you.
  state.openEditor = { folderId: folder.id, itemIds };

  const single = Array.isArray(itemIds) && itemIds.length === 1;
  const target = single ? folder.items.find((item) => item.id === itemIds[0]) : null;
  const count = itemIds === null ? folder.items.length : itemIds.length;
  if (!count) {
    toast('Nothing to style — that folder is empty.', { tone: 'error' });
    return;
  }

  let chosenColor = single ? (target?.feature.properties.color || null) : null;
  let chosenIcon = single ? (target?.feature.properties.icon || null) : null;
  // Only fields the user actually touches are applied. Without this, opening
  // the bulk editor to change an icon would also wipe every pin's colour back
  // to the folder default, which is not what "change the icon" means.
  let colorTouched = false;
  let iconTouched = false;

  const editor = el('div', { class: 'style-editor' });

  const heading = single
    ? `Style “${target.feature.properties.name}”`
    : `Style ${count} pin${count === 1 ? '' : 's'} in “${folder.name}”`;
  editor.append(el('h3', { class: 'style-editor-title', text: heading }));

  if (single) {
    editor.append(el('input', {
      type: 'text', class: 'style-name', value: target.feature.properties.name,
      'aria-label': 'Pin name', placeholder: 'Pin name',
      onchange: (event) => state.folders.renameItem(folder.id, target.id, event.target.value),
    }));
    editor.append(el('textarea', {
      class: 'style-desc', rows: '3', 'aria-label': 'Pin description',
      placeholder: 'Notes — road surface, access, what you found here…',
      text: target.feature.properties.description || '',
      onchange: (event) => state.folders.describeItem(folder.id, target.id, event.target.value),
    }));
  }

  if (single) editor.append(photoSection(folder, target));

  /* colour */
  editor.append(el('div', { class: 'style-label', text: 'Color' }));
  const colorRow = el('div', { class: 'swatch-row' });
  const paintSwatches = () => {
    colorRow.querySelectorAll('.swatch').forEach((node) => {
      node.classList.toggle('is-chosen', node.dataset.color === (chosenColor || ''));
    });
  };
  colorRow.append(el('button', {
    class: 'swatch is-inherit', type: 'button', dataset: { color: '' },
    title: 'Clear the override and use the folder color',
    'aria-label': 'Use the folder color',
    style: `--swatch:${folder.color}`,
    onclick: () => { chosenColor = null; colorTouched = true; paintSwatches(); },
  }));
  for (const color of FOLDER_COLORS) {
    colorRow.append(el('button', {
      class: 'swatch', type: 'button', dataset: { color },
      title: color, 'aria-label': `Color ${color}`, style: `--swatch:${color}`,
      onclick: () => { chosenColor = color; colorTouched = true; paintSwatches(); },
    }));
  }
  editor.append(colorRow);
  paintSwatches();

  /* icon */
  editor.append(el('div', { class: 'style-label', text: 'Icon' }));
  const iconWrap = el('div', { class: 'icon-picker' });
  const paintIcons = () => {
    iconWrap.querySelectorAll('.icon-choice').forEach((node) => {
      node.classList.toggle('is-chosen', node.dataset.icon === (chosenIcon || ''));
    });
  };
  iconWrap.append(el('button', {
    class: 'icon-choice is-inherit', type: 'button', dataset: { icon: '' },
    title: 'Clear the override and use the plain pin',
    'aria-label': 'Use the default pin icon',
    html: pinIconSVG(DEFAULT_PIN_ICON, { size: 17 }),
    onclick: () => { chosenIcon = null; iconTouched = true; paintIcons(); },
  }));
  for (const [group, icons] of pinIconGroups()) {
    iconWrap.append(el('div', { class: 'icon-group-label', text: group }));
    const grid = el('div', { class: 'icon-grid' });
    for (const icon of icons) {
      grid.append(el('button', {
        class: 'icon-choice', type: 'button', dataset: { icon: icon.id },
        title: icon.name, 'aria-label': icon.name,
        html: pinIconSVG(icon.id, { size: 17 }),
        onclick: () => { chosenIcon = icon.id; iconTouched = true; paintIcons(); },
      }));
    }
    iconWrap.append(grid);
  }
  editor.append(iconWrap);
  paintIcons();

  const actions = el('div', { class: 'picker-row' }, [
    el('button', {
      class: 'button button-primary button-small', type: 'button', text: 'Apply',
      onclick: () => {
        const patch = {};
        if (colorTouched || single) patch.color = chosenColor;
        if (iconTouched || single) patch.icon = chosenIcon;
        if (!Object.keys(patch).length) {
          state.openEditor = null;
          editor.remove();
          toast('Pick a colour or an icon first.', { tone: 'info' });
          return;
        }
        const changed = state.folders.styleItems(folder.id, patch, itemIds);
        state.openEditor = null;
        editor.remove();
        clearSelection(folder.id);
        renderFoldersTab();
        toast(changed
          ? `Styled ${changed} pin${changed === 1 ? '' : 's'}.`
          : 'Those pins already had that style.', { tone: changed ? 'ok' : 'info' });
      },
    }),
    el('button', {
      class: 'button button-ghost button-small', type: 'button', text: 'Cancel',
      onclick: () => { state.openEditor = null; editor.remove(); },
    }),
  ]);
  editor.append(actions);

  /*
   * The folder's own actions, as words.
   *
   * Only when the editor is for the whole folder — styling one pin is not the
   * place to offer to delete the folder it is in. Delete sits apart from the
   * others and asks first, because it is the one that cannot be undone.
   */
  if (itemIds === null) {
    editor.append(el('div', { class: 'picker-row editor-folder-actions' }, [
      // Icon plus label. Three text-only buttons could not fit the panel and
      // ran off its right edge; a mark each lets the words be short enough to
      // sit inside it.
      el('button', {
        class: 'button button-ghost button-small', type: 'button',
        title: `Zoom the map to ${folder.name}`,
        html: `${icons.target}<span>Zoom</span>`,
        onclick: () => {
          const bounds = geojsonBounds(state.folders.folderGeoJSON(folder.id));
          if (boundsAreValid(bounds)) fitTo(bounds);
          else toast('That folder has nothing in it yet.', { tone: 'error' });
        },
      }),
      el('button', {
        class: 'button button-ghost button-small', type: 'button',
        title: `Export ${folder.name} as a GPX file`,
        html: `${icons.export}<span>Export</span>`,
        onclick: () => exportFolder(folder),
      }),
      el('button', {
        class: 'button button-ghost button-small is-danger', type: 'button',
        title: `Delete ${folder.name}`,
        html: `${icons.trash}<span>Delete</span>`,
        onclick: () => {
          const total = state.folders.counts(folder).total;
          const message = total
            ? `Delete “${folder.name}” and its ${total} item${total === 1 ? '' : 's'}? This cannot be undone.`
            : `Delete “${folder.name}”?`;
          if (!window.confirm(message)) return;

          const tombstone = state.folders.remove(folder.id);
          // Push the tombstone so other devices learn of the deletion; without
          // it the folder would simply reappear on the next sync.
          if (tombstone && state.account?.user) state.account.pushFolder(tombstone);
          state.openEditor = null;
        },
      }),
    ]));
  }

  anchor.after(editor);
  editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------- importing into folders ---------------- */

/**
 * Inline picker: choose a loaded map, choose what to take from it, choose the
 * destination folder. Kept in the panel rather than a modal so the map stays
 * visible while you file things.
 */
function toggleImportPicker() {
  const existing = dom.folderList.querySelector('.picker');
  if (existing) { existing.remove(); return; }

  const documents = [...state.documents.values()];
  if (!documents.length) {
    toast('Load or open a map first — then you can file its waypoints into a folder.', { tone: 'error' });
    return;
  }

  const sourceSelect = el('select', { 'aria-label': 'Map to import from' },
    documents.map((entry) => el('option', { value: entry.key, text: entry.name })));

  const whatSelect = el('select', { 'aria-label': 'What to import' }, [
    el('option', { value: 'waypoints', text: 'Waypoints only' }),
    el('option', { value: 'tracks', text: 'Tracks and routes only' }),
    el('option', { value: 'all', text: 'Everything' }),
  ]);

  const folders = state.folders.list();
  const targetSelect = el('select', { 'aria-label': 'Destination folder' }, [
    ...folders.map((folder) => el('option', { value: folder.id, text: folder.name })),
    el('option', { value: '__new__', text: folders.length ? '— New folder —' : 'New folder' }),
  ]);
  targetSelect.value = folders.length ? folders[folders.length - 1].id : '__new__';

  const nameField = el('input', {
    type: 'text', placeholder: 'New folder name', 'aria-label': 'New folder name',
    hidden: targetSelect.value !== '__new__',
  });
  targetSelect.addEventListener('change', () => { nameField.hidden = targetSelect.value !== '__new__'; });

  // KML files carry their own folder structure; offer to preserve it.
  const byFolderToggle = el('label', { class: 'picker-note', style: 'display:flex;gap:7px;align-items:center' }, [
    el('input', { type: 'checkbox', id: 'import-by-folder' }),
    el('span', { text: "Split into folders using the file's own folder names" }),
  ]);

  const photoToggle = el('label', { class: 'picker-note', style: 'display:flex;gap:7px;align-items:center' }, [
    el('input', { type: 'checkbox', id: 'import-photos' }),
    el('span', { text: 'Also download photos the file links to' }),
  ]);

  const picker = el('div', { class: 'picker' }, [
    el('h3', { text: 'Import into a folder' }),
    sourceSelect,
    whatSelect,
    targetSelect,
    nameField,
    byFolderToggle,
    photoToggle,
    el('div', { class: 'picker-row' }, [
      el('button', {
        class: 'button button-primary button-small', type: 'button', text: 'Import',
        onclick: () => {
          runImport({
            entry: state.documents.get(sourceSelect.value),
            what: whatSelect.value,
            target: targetSelect.value,
            newName: nameField.value,
            splitByFolder: byFolderToggle.querySelector('input').checked,
            withPhotos: photoToggle.querySelector('input').checked,
          });
          picker.remove();
        },
      }),
      el('button', {
        class: 'button button-ghost button-small', type: 'button', text: 'Cancel',
        onclick: () => picker.remove(),
      }),
    ]),
  ]);

  dom.folderList.prepend(picker);
  sourceSelect.focus();
}

function selectFeatures(entry, what) {
  return entry.doc.geojson.features.filter((feature) => {
    const kind = feature.properties.kind;
    if (what === 'waypoints') return kind === 'waypoint';
    if (what === 'tracks') return kind === 'track' || kind === 'route';
    return true;
  }).map((feature) => ({
    ...feature,
    properties: { ...feature.properties, sourceName: entry.name },
  }));
}

/**
 * Download the photos an imported file links to.
 *
 * Most GaiaGPS links will fail: a browser may not read another site's images
 * unless that site sends CORS headers, and Gaia does not. Rather than fail
 * silently, this counts the outcomes and says exactly why.
 */
async function importLinkedPhotos(folderId) {
  const folder = state.folders.get(folderId);
  if (!folder) return;

  const targets = folder.items.filter((item) => item.feature.properties.link);
  if (!targets.length) {
    toast('None of those waypoints linked to a photo.', { tone: 'info' });
    return;
  }

  setStatus(true, `Fetching ${targets.length} linked photo${targets.length === 1 ? '' : 's'}…`);
  let saved = 0;
  const reasons = new Map();

  for (const item of targets) {
    const result = await fetchLinkedPhoto(item.feature.properties.link, {
      name: item.feature.properties.name,
    });
    if (result.ok) {
      state.folders.addPhotos(folder.id, item.id, [result.photo]);
      saved++;
    } else {
      reasons.set(result.reason, (reasons.get(result.reason) || 0) + 1);
    }
  }
  setStatus(false);

  if (saved) toast(`Saved ${saved} photo${saved === 1 ? '' : 's'} into “${folder.name}”.`, { tone: 'ok' });
  if (reasons.size) {
    const [reason, count] = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    toast(`${count} photo${count === 1 ? '' : 's'} could not be fetched — ${reason}. `
      + 'Sites like GaiaGPS do not permit other sites to read their images; add those photos from your device instead.',
    { tone: 'error', timeout: 15000 });
  }
}

function runImport({ entry, what, target, newName, splitByFolder, withPhotos = false }) {
  if (!entry) return;
  const features = selectFeatures(entry, what);
  if (!features.length) {
    toast(`“${entry.name}” has no ${what === 'all' ? 'features' : what} to import.`, { tone: 'error' });
    return;
  }

  let added = 0;
  let skipped = 0;
  const touched = new Set();

  if (splitByFolder) {
    // Group by the source file's own folder path, falling back to the map name.
    const groups = new Map();
    for (const feature of features) {
      const label = (feature.properties.folder || '').split(' / ').pop() || entry.name;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(feature);
    }
    for (const [label, group] of groups) {
      const folder = state.folders.ensure(label);
      const result = state.folders.addFeatures(folder.id, group, { keepTimes: what !== 'waypoints' });
      added += result.added;
      skipped += result.skipped;
      touched.add(folder.name);
    }
  } else {
    const folder = target === '__new__'
      ? state.folders.create(newName?.trim() || entry.name)
      : state.folders.get(target);
    if (!folder) return;
    const result = state.folders.addFeatures(folder.id, features, { keepTimes: what !== 'waypoints' });
    added = result.added;
    skipped = result.skipped;
    touched.add(folder.name);
  }

  if (withPhotos) {
    for (const folder of state.folders.list()) {
      if (touched.has(folder.name)) importLinkedPhotos(folder.id);
    }
  }

  const where = touched.size === 1 ? `“${[...touched][0]}”` : `${touched.size} folders`;
  const duplicates = skipped ? ` ${skipped} already there.` : '';
  toast(added
    ? `Filed ${added} item${added === 1 ? '' : 's'} into ${where}.${duplicates}`
    : `Nothing new to add — everything was already in ${where}.`,
  { tone: added ? 'ok' : 'info' });
}

/** Save a single feature (typically from a map popup) into a folder. */
function saveFeatureToFolder(feature, folderId, newName) {
  const folder = folderId === '__new__'
    ? state.folders.create(newName?.trim() || 'Saved places')
    : state.folders.get(folderId);
  if (!folder) return;
  const { added } = state.folders.addFeatures(folder.id, [feature], { keepTimes: false });
  toast(added
    ? `Saved “${feature.properties?.name || 'item'}” to “${folder.name}”.`
    : `“${feature.properties?.name || 'That item'}” is already in “${folder.name}”.`,
  { tone: added ? 'ok' : 'info' });
}

/* ------------------------------------------------------------------ elevation profile */

const PROFILE_SAMPLES = 320;

/**
 * Reduce a document's line geometry to a fixed-width elevation series.
 * Returns null when nothing in the file carries elevation.
 */
function buildProfile(doc) {
  const positions = [];
  for (const feature of doc.geojson.features) {
    if (feature.properties.kind === 'waypoint' || feature.properties.kind === 'area') continue;
    positions.push(...linePositions(feature.geometry));
  }
  const withElevation = positions.filter((p) => Number.isFinite(p[2]));
  if (withElevation.length < 4) return null;

  const distances = cumulativeDistances(positions);
  const total = distances[distances.length - 1];
  if (!total) return null;

  const step = Math.max(1, Math.floor(positions.length / PROFILE_SAMPLES));
  const samples = [];
  for (let i = 0; i < positions.length; i += step) {
    const ele = positions[i][2];
    if (!Number.isFinite(ele)) continue;
    samples.push({ distance: distances[i], elevation: ele, position: positions[i] });
  }
  const last = positions[positions.length - 1];
  if (Number.isFinite(last[2]) && samples[samples.length - 1]?.distance !== total) {
    samples.push({ distance: total, elevation: last[2], position: last });
  }
  if (samples.length < 4) return null;

  const elevations = samples.map((s) => s.elevation);
  return {
    samples,
    total,
    min: Math.min(...elevations),
    max: Math.max(...elevations),
  };
}

function renderProfile(profile) {
  const width = 304;
  const height = 116;
  const padTop = 8;
  const padBottom = 18;
  const span = Math.max(profile.max - profile.min, 1);

  const x = (distance) => (distance / profile.total) * width;
  const y = (elevation) => padTop + (1 - (elevation - profile.min) / span) * (height - padTop - padBottom);

  const points = profile.samples.map((s) => `${x(s.distance).toFixed(1)},${y(s.elevation).toFixed(1)}`);
  const linePath = `M${points.join('L')}`;
  const areaPath = `${linePath}L${width},${height - padBottom}L0,${height - padBottom}Z`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'profile');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Elevation profile: ${formatElevation(profile.min, state.units)} to ${formatElevation(profile.max, state.units)} over ${formatDistance(profile.total, state.units)}`);

  svg.innerHTML = `
    <defs>
      <linearGradient id="profile-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--clay)" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="var(--clay)" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" stroke="var(--line)" stroke-width="1"/>
    <path d="${areaPath}" fill="url(#profile-fill)"/>
    <path d="${linePath}" fill="none" stroke="var(--clay)" stroke-width="1.6" stroke-linejoin="round"/>
    <line class="profile-cursor" x1="0" y1="${padTop}" x2="0" y2="${height - padBottom}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 2" opacity="0"/>
    <text x="2" y="${height - 5}" font-size="9" fill="var(--ink-3)">0</text>
    <text x="${width - 2}" y="${height - 5}" font-size="9" fill="var(--ink-3)" text-anchor="end">${escapeHTML(formatDistance(profile.total, state.units))}</text>
    <text x="2" y="${padTop + 8}" font-size="9" fill="var(--ink-3)">${escapeHTML(formatElevation(profile.max, state.units))}</text>
  `;

  const readout = el('div', { class: 'profile-readout' });
  const cursor = svg.querySelector('.profile-cursor');

  const onMove = (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const targetDistance = ratio * profile.total;
    let nearest = profile.samples[0];
    for (const sample of profile.samples) {
      if (Math.abs(sample.distance - targetDistance) < Math.abs(nearest.distance - targetDistance)) nearest = sample;
    }
    cursor.setAttribute('x1', x(nearest.distance));
    cursor.setAttribute('x2', x(nearest.distance));
    cursor.setAttribute('opacity', '1');
    readout.replaceChildren(
      el('span', {}, [document.createTextNode('at '), el('b', { text: formatDistance(nearest.distance, state.units) })]),
      el('span', {}, [el('b', { text: formatElevation(nearest.elevation, state.units) })]),
    );
    setCursor(nearest.position);
  };
  const onLeave = () => {
    cursor.setAttribute('opacity', '0');
    readout.replaceChildren();
    // Back to the tapped point rather than to nothing: the profile borrows the
    // same cursor, and clearing it here would rub out a mark it did not put
    // down.
    setCursor(state.probeMark);
  };

  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onMove);
  svg.addEventListener('pointerleave', onLeave);

  const wrapper = document.createDocumentFragment();
  wrapper.append(svg, readout);
  return wrapper;
}

/* ------------------------------------------------------------------ actions */

async function shareView() {
  writeURL();
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — it restores these maps, this basemap and this view.', { tone: 'ok' });
  } catch {
    toast('Copy this URL to share the current view:', { tone: 'info' });
  }
}

/**
 * Everything on the map right now, as one GeoJSON file.
 *
 * Both halves of what is on screen: the map files that are open, and the saved
 * folders that are switched on. It used to be only the former, from a time when
 * loading a file was the only way to get anything onto the map — so somebody
 * with a hundred saved waypoints and no file open pressed it and got told
 * there was nothing to export.
 *
 * Every feature is stamped with where it came from, because a merged file with
 * no provenance is hard to take apart again.
 */
async function downloadVisible(asGeoJSON = false) {
  const features = [];

  for (const entry of state.documents.values()) {
    if (!entry.visible) continue;
    for (const feature of entry.doc.geojson.features) {
      features.push({ ...feature, properties: { ...feature.properties, source: entry.name } });
    }
  }

  for (const feature of state.folders.toGeoJSON({ visibleOnly: true }).features) {
    features.push({
      ...feature,
      properties: { ...feature.properties, source: feature.properties.folderName || 'Saved' },
    });
  }

  if (!features.length) {
    toast('Nothing on the map to export yet.', { tone: 'error' });
    return;
  }
  const geojson = { type: 'FeatureCollection', features };
  const count = `${features.length} feature${features.length === 1 ? '' : 's'}`;

  /*
   * GPX by default, GeoJSON when asked for.
   *
   * A .geojson file is the right format for another map to read and the wrong
   * one to hand a person: nothing on a phone opens it, and the honest reaction
   * to downloading one is to wonder what it was for. GPX is the format Garmin,
   * Gaia, AllTrails and every handheld already import, which makes the export
   * the start of something rather than a file in a downloads folder.
   *
   * GeoJSON stays, because it carries properties GPX has nowhere to put and
   * because anything already built on it should keep working.
   */
  if (asGeoJSON) {
    await downloadText('american-byways-maps.geojson', JSON.stringify(geojson, null, 2), 'application/geo+json');
    toast(`Exported ${count} as GeoJSON.`, { tone: 'ok' });
    return;
  }
  const how = await downloadText('american-byways-maps.gpx',
    toGPX(geojson, { name: 'American Byways' }), 'application/gpx+xml');
  if (how !== 'cancelled') toast(`Exported ${count} as GPX.`, { tone: 'ok' });
}

/* ------------------------------------------------------------------ */

main().catch((error) => {
  console.error(error);
  const container = document.getElementById('map');
  if (container) {
    container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-2)">
      <h2>The map could not start</h2><p>${escapeHTML(error.message)}</p></div>`;
  }
});

export { state };
