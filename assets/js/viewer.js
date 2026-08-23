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
  DEFAULT_VIEW, DEFAULT_UNITS, TRACK_COLORS,
} from './config.js';
import { loadEngine, buildRasterStyle, hasMapboxToken } from './lib/engine.js';
import { loadCatalog, findMap } from './lib/catalog.js';
import { parseMapFile, linePositions } from './lib/parse.js';
import {
  boundsAreValid, cumulativeDistances, formatDistance, formatDuration, formatElevation,
  geojsonBounds, mergeBounds, padBounds,
} from './lib/geo.js';
import { el, escapeHTML, createToaster, downloadText, initTheme, formatDate } from './lib/ui.js';
import { icons } from './lib/icons.js';
import { FolderStore, FOLDER_COLORS } from './lib/folders.js';
import {
  PIN_ICONS, DEFAULT_PIN_ICON, pinIconGroups, pinIconSVG, pinImageId, registerPinImages,
} from './lib/pin-icons.js';
import { toGPX } from './lib/gpx-write.js';
import {
  putPhoto, photoURL, deletePhoto, pruneUnreferenced, fetchLinkedPhoto, formatBytes, PHOTO_TYPES,
} from './lib/photos.js';

/* ------------------------------------------------------------------ state */

const state = {
  gl: null,
  map: null,
  engine: null,
  catalog: { maps: [] },
  /** key -> { key, name, doc, color, visible, origin, slug } */
  documents: new Map(),
  basemapId: DEFAULT_BASEMAP,
  overlays: new Map(OVERLAYS.map((o) => [o.id, { visible: !!o.enabled, opacity: o.opacity ?? 1 }])),
  units: DEFAULT_UNITS,
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
  state.map?.once('style.load', () => run());
}

/** Basemaps needing a Mapbox token are hidden entirely when none is configured. */
const availableBasemaps = () => BASEMAPS.filter((b) => !b.requiresToken || hasMapboxToken());

const sourceIdFor = (key) => `data-${key}`;
const layerIdsFor = (key) => [
  `${key}-fill`, `${key}-fill-line`, `${key}-line-casing`, `${key}-line`, `${key}-point-halo`, `${key}-point`,
];

const FOLDER_SOURCE = 'folders';
const FOLDER_LAYERS = [
  'folders-line-casing', 'folders-line', 'folders-point-halo', 'folders-point', 'folders-point-icon',
];

const IS_LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const IS_POLY = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const IS_POINT = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

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
  state.folders.onChange(() => {
    renderFoldersTab();
    renderDropTarget();
    refreshFolderData();
    if (state.folders.lastError) toast(state.folders.lastError, { tone: 'error', timeout: 10000 });
  });
  // On a phone the panel covers the map, so the map is what you should land on.
  // Desktop has room for both, so it stays open there.
  setPanelOpen(!window.matchMedia('(max-width: 820px)').matches);

  wirePanel();
  wireFolders();
  wireDropzone();
  if (!state.folders.storage) {
    const note = document.getElementById('folder-storage-note');
    if (note) {
      note.textContent = 'This browser is not allowing site storage, so folders will be lost when you '
        + 'close the tab. Export anything you want to keep as GPX.';
    }
  }

  const { gl, engine } = await loadEngine();
  state.gl = gl;
  state.engine = engine;

  const initial = readURL();
  state.basemapId = initial.basemap || defaultBasemapId();
  if (initial.overlays) {
    for (const [id, entry] of state.overlays) entry.visible = initial.overlays.includes(id);
  }
  if (initial.units) state.units = initial.units;

  const basemap = basemapById(state.basemapId);
  state.map = new gl.Map({
    container: 'map',
    style: basemap.style && hasMapboxToken() ? basemap.style : buildRasterStyle(basemap, activeOverlays()),
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    hash: 'view',
    attributionControl: { compact: true },
    maxPitch: 75,
  });

  state.map.addControl(new gl.NavigationControl({ visualizePitch: true }), 'top-right');
  state.map.addControl(new gl.ScaleControl({ unit: state.units === 'metric' ? 'metric' : 'imperial' }), 'bottom-left');
  state.map.addControl(new gl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }), 'top-right');
  if (gl.FullscreenControl) state.map.addControl(new gl.FullscreenControl(), 'top-right');

  state.map.on('sourcedata', (event) => {
    if (event.sourceId && event.isSourceLoaded) noteLayerHealth(event.sourceId, true);
  });

  state.map.on('error', (event) => {
    if (event?.sourceId) noteLayerHealth(event.sourceId, false);
    const message = event?.error?.message || '';
    // Individual tile 404s are noisy and self-correcting; everything else is
    // worth seeing, because a style-level failure is otherwise silent.
    if (/Failed to fetch|NetworkError|AbortError/i.test(message)) return;
    console.error('[map]', message || event);
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
  // A Mapbox vector style starts without our overlays; the raster path bakes
  // them into the initial style, so this only has work to do in the former case.
  if (basemap.style && hasMapboxToken()) {
    for (const overlay of activeOverlays()) addOverlayLayer(overlay);
  }
  renderLayersTab();
  renderFoldersTab();
  renderDropTarget();
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
  const name = document.getElementById('brand-name');
  if (name) name.textContent = SITE.name;
  const parent = document.getElementById('brand-parent');
  if (parent && SITE.parent?.name) parent.textContent = SITE.parent.name;
}

function cacheDom() {
  dom.app = document.querySelector('.app');
  dom.panel = document.getElementById('panel');
  dom.tabs = [...document.querySelectorAll('.panel-tab')];
  dom.tabPanels = {
    layers: document.getElementById('tab-layers'),
    maps: document.getElementById('tab-maps'),
    folders: document.getElementById('tab-folders'),
    details: document.getElementById('tab-details'),
  };
  dom.basemapList = document.getElementById('basemap-list');
  dom.overlayList = document.getElementById('overlay-list');
  dom.catalogList = document.getElementById('catalog-list');
  dom.loadedList = document.getElementById('loaded-list');
  dom.loadedCount = document.getElementById('loaded-count');
  dom.details = document.getElementById('details-body');
  dom.dropzone = document.getElementById('dropzone');
  dom.fileInput = document.getElementById('file-input');
  dom.toasts = document.getElementById('toasts');
  dom.status = document.getElementById('map-status');
  dom.statusText = document.getElementById('map-status-text');
  dom.unitsToggle = document.getElementById('units-toggle');
  dom.folderList = document.getElementById('folder-list');
  dom.folderTotals = document.getElementById('folder-totals');
  dom.newFolder = document.getElementById('new-folder');
  dom.importIntoFolder = document.getElementById('import-into-folder');
  dom.dropTarget = document.getElementById('drop-target');
  dom.quickLayers = document.getElementById('quick-layers');
  dom.quickFolders = document.getElementById('quick-folders');
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
  dom.unitsToggle?.addEventListener('click', () => {
    state.units = state.units === 'imperial' ? 'metric' : 'imperial';
    dom.unitsToggle.textContent = state.units === 'imperial' ? 'mi / ft' : 'km / m';
    renderMapsTab();
    renderDetailsTab();
    writeURL();
  });
  dom.quickLayers?.addEventListener('click', () => openTab('layers'));
  dom.quickFolders?.addEventListener('click', () => openTab('folders'));
  document.getElementById('share-button')?.addEventListener('click', shareView);
  document.getElementById('download-button')?.addEventListener('click', downloadVisible);
  document.getElementById('fit-button')?.addEventListener('click', fitAll);
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
 * Track whether a tile source is actually serving tiles.
 *
 * Third-party tile endpoints move and retire without notice, and a dead one is
 * indistinguishable from a slow one until enough requests have failed. Counting
 * outcomes per source lets the layer picker say so instead of leaving the user
 * staring at an empty map wondering what they broke.
 */
function noteLayerHealth(sourceId, ok) {
  const layerId = sourceId === 'basemap' ? state.basemapId
    : sourceId.startsWith('overlay-') ? sourceId.slice('overlay-'.length)
      : null;
  if (!layerId) return;

  const health = state.layerHealth.get(layerId) || { ok: 0, failed: 0 };
  if (ok) health.ok++; else health.failed++;
  state.layerHealth.set(layerId, health);

  // Only call it dead once several requests have failed with none succeeding.
  if (!ok && health.failed === 4 && health.ok === 0) renderLayersTab();
}

function layerIsBroken(id) {
  const health = state.layerHealth.get(id);
  return Boolean(health && health.ok === 0 && health.failed >= 4);
}

function activeOverlays() {
  return OVERLAYS
    .filter((o) => state.overlays.get(o.id)?.visible)
    .map((o) => ({ ...o, opacity: state.overlays.get(o.id).opacity }));
}

function renderLayersTab() {
  dom.basemapList.replaceChildren();

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
        control: el('input', {
          type: 'radio', name: 'basemap', value: basemap.id, checked: selected,
          onchange: () => setBasemap(basemap.id),
        }),
      }));
    }
  }

  const activeCount = OVERLAYS.filter((o) => state.overlays.get(o.id)?.visible).length;
  const counter = document.getElementById('overlay-count');
  if (counter) counter.textContent = activeCount ? `${activeCount} on` : '';

  dom.overlayList.replaceChildren();
  for (const overlay of OVERLAYS) {
    const entry = state.overlays.get(overlay.id);
    const opacityRow = el('div', { class: 'opacity-row', hidden: !entry.visible }, [
      el('input', {
        type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(entry.opacity * 100)),
        'aria-label': `${overlay.name} opacity`,
        oninput: (event) => {
          const value = Number(event.target.value) / 100;
          entry.opacity = value;
          event.target.nextElementSibling.value = `${Math.round(value * 100)}%`;
          if (state.map.getLayer(`overlay-${overlay.id}`)) {
            state.map.setPaintProperty(`overlay-${overlay.id}`, 'raster-opacity', value);
          }
        },
      }),
      el('output', { text: `${Math.round(entry.opacity * 100)}%` }),
    ]);

    dom.overlayList.append(
      layerRow({
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
      }),
      opacityRow,
    );
  }
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
function layerRow({ entry, selected, control }) {
  const description = entry.description || '';
  const descriptionNode = description
    ? el('p', { class: 'layer-desc', hidden: true, text: description })
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
      'aria-expanded': 'false', 'aria-label': `About ${entry.name}`,
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
      el('span', { class: 'layer-option-name' }, [
        el('span', { class: 'layer-option-label', text: entry.name }),
        layerBadge(entry),
      ]),
    ]),
    info,
  ]);

  if (!descriptionNode) return row;
  const wrap = document.createDocumentFragment();
  wrap.append(row, descriptionNode);
  return wrap;
}

/** Small marker beside a layer name: unverified endpoint, or one that is failing. */
function layerBadge(entry) {
  if (layerIsBroken(entry.id)) {
    return el('span', {
      class: 'layer-badge is-broken',
      title: 'This layer\u2019s tile server is not responding. The endpoint may have moved — see assets/js/config.js.',
      text: 'not responding',
    });
  }
  if (entry.unverified) {
    return el('span', {
      class: 'layer-badge',
      title: 'This endpoint has not been confirmed working. If it stays blank, the service has probably moved.',
      text: 'unverified',
    });
  }
  return null;
}

function setBasemap(id) {
  state.basemapId = id;
  const basemap = basemapById(id);
  const useVectorStyle = Boolean(basemap.style) && hasMapboxToken();

  // A style swap wipes every source, so the data layers are rebuilt on the other
  // side of 'style.load'. The parsed documents live in memory, so this is cheap.
  state.map.setStyle(useVectorStyle ? basemap.style : buildRasterStyle(basemap, activeOverlays()));
  state.map.once('style.load', () => {
    if (useVectorStyle) for (const overlay of activeOverlays()) addOverlayLayer(overlay);
    addAppLayers();
    for (const entry of state.documents.values()) addDocumentLayers(entry);
    applyVisibility();
    addFolderLayers();
    refreshFolderData();
  });
  renderLayersTab();
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

function addOverlayLayer(overlay) {
  if (!styleReady()) { whenStyleReady(() => addOverlayLayer(overlay)); return; }
  const id = `overlay-${overlay.id}`;
  if (state.map.getLayer(id)) return;
  const entry = state.overlays.get(overlay.id);
  if (!state.map.getSource(id)) {
    state.map.addSource(id, {
      type: 'raster',
      tiles: overlay.tiles,
      tileSize: overlay.tileSize || 256,
      maxzoom: overlay.maxzoom || 19,
      attribution: overlay.attribution || '',
    });
  }
  state.map.addLayer({
    id, type: 'raster', source: id,
    paint: { 'raster-opacity': entry?.opacity ?? overlay.opacity ?? 1, 'raster-fade-duration': 180 },
  }, firstDataLayerId());
}

function removeOverlayLayer(id) {
  const layerId = `overlay-${id}`;
  if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
  if (state.map.getSource(layerId)) state.map.removeSource(layerId);
}

/* ------------------------------------------------------------------ data layers */

/**
 * Sources and layers the app owns, as opposed to a loaded map file: the
 * selection highlight, the elevation-profile cursor, and the user's folders.
 * Re-run after every style change, which wipes all of them.
 */
function addAppLayers() {
  if (!styleReady()) { whenStyleReady(addAppLayers); return; }
  const empty = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  if (!state.map.getSource('scratch-highlight')) state.map.addSource('scratch-highlight', empty);
  if (!state.map.getSource('scratch-cursor')) state.map.addSource('scratch-cursor', empty);
  if (!state.map.getSource(FOLDER_SOURCE)) state.map.addSource(FOLDER_SOURCE, empty);

  if (!state.map.getLayer('scratch-highlight-line')) {
    state.map.addLayer({
      id: 'scratch-highlight-line', type: 'line', source: 'scratch-highlight', filter: IS_LINE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.55, 'line-blur': 1 },
    });
  }
  if (!state.map.getLayer('scratch-cursor-point')) {
    state.map.addLayer({
      id: 'scratch-cursor-point', type: 'circle', source: 'scratch-cursor',
      paint: {
        'circle-radius': 6, 'circle-color': '#ffffff',
        'circle-stroke-color': '#b4441f', 'circle-stroke-width': 3,
      },
    });
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
  if (!styleReady()) return;
  for (const entry of state.documents.values()) {
    const visibility = entry.visible ? 'visible' : 'none';
    for (const id of layerIdsFor(entry.key)) {
      if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}

/* ------------------------------------------------------------------ interactions */

function bindFeatureInteractions(layerId) {
  state.map.on('mouseenter', layerId, () => { state.map.getCanvas().style.cursor = 'pointer'; });
  state.map.on('mouseleave', layerId, () => { state.map.getCanvas().style.cursor = ''; });
  state.map.on('click', layerId, (event) => {
    const feature = event.features?.[0];
    if (feature) showFeaturePopup(feature, event.lngLat);
  });
}

function showFeaturePopup(feature, lngLat) {
  const props = feature.properties || {};
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
  if (props.symbol) rows.push(['Symbol', props.symbol]);
  if (props.folderName) rows.push(['Folder', props.folderName]);
  else if (props.folder) rows.push(['Folder', props.folder]);

  const description = props.description ? String(props.description).slice(0, 1200) : '';
  const content = el('div', {});
  content.innerHTML = `
    <div class="popup-title">${escapeHTML(props.name || 'Untitled')}</div>
    <div class="popup-kind">${escapeHTML(props.kind || 'feature')}</div>
    ${description ? `<p class="popup-desc">${escapeHTML(description)}</p>` : ''}
    ${rows.length ? `<dl class="popup-stats">${rows.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}</dl>` : ''}
  `;

  const popup = new state.gl.Popup({ closeButton: true, maxWidth: '300px', offset: 12 })
    .setLngLat(feature.geometry?.type === 'Point' ? feature.geometry.coordinates : lngLat);

  content.append(props.itemId
    ? savedItemActions(props, popup)
    : saveToFolderActions(feature, popup));

  popup.setDOMContent(content).addTo(state.map);
}

/** Actions for a feature that is not yet in a folder: pick one and save. */
function saveToFolderActions(feature, popup) {
  const folders = state.folders.list();
  const select = el('select', { 'aria-label': 'Folder to save into' }, [
    ...folders.map((folder) => el('option', { value: folder.id, text: folder.name })),
    el('option', { value: '__new__', text: folders.length ? '— New folder —' : 'New folder' }),
  ]);
  select.value = folders.length ? folders[folders.length - 1].id : '__new__';

  return el('div', { class: 'popup-actions' }, [
    select,
    el('button', {
      type: 'button', text: 'Save to folder',
      onclick: () => {
        const name = select.value === '__new__'
          ? window.prompt('Name the new folder', 'Saved places')
          : null;
        if (select.value === '__new__' && name === null) return;
        saveFeatureToFolder(feature, select.value, name);
        popup.remove();
        openTab('folders');
      },
    }),
  ]);
}

/** Actions for a feature already saved in a folder. */
function savedItemActions(props, popup) {
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

  children.push(el('button', {
    type: 'button', text: 'Edit style',
    onclick: () => {
      const folder = state.folders.get(props.folderId);
      popup.remove();
      openTab('folders');
      if (!folder) return;
      // Re-render first so the row the editor anchors to exists.
      renderFoldersTab();
      const row = dom.folderList.querySelector(`[data-item="${props.itemId}"]`);
      if (row) openStyleEditor(folder, [props.itemId], row);
    },
  }));

  children.push(el('button', {
    type: 'button', text: 'Remove',
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
      if (filed) filedInto.push(filed);
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
      toast(waypoints
        ? `${loaded} Nothing was uploaded — pick a destination above to file waypoints automatically.`
        : `${loaded} These stay in your browser — nothing is uploaded.`,
      { tone: 'ok', timeout: 9000 });
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
  const entry = state.documents.get(state.activeKey);
  dom.details.replaceChildren();

  if (!entry) {
    dom.details.append(el('div', { class: 'panel-section' }, [
      el('p', { class: 'hint', text: 'Select or load a map to see its distance, elevation profile and waypoints.' }),
    ]));
    return;
  }

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

  dom.details.append(el('div', { class: 'panel-section' }, [
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
      el('h2', { class: 'panel-title', text: 'Elevation profile' }),
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
  if (!styleReady()) return;
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
  dom.importIntoFolder?.addEventListener('click', () => toggleImportPicker());
}

function renderFoldersTab() {
  if (!dom.folderList) return;
  const folders = state.folders.list();
  const totals = state.folders.totals();
  dom.folderTotals.textContent = totals.folders
    ? `${totals.waypoints} waypoint${totals.waypoints === 1 ? '' : 's'}${totals.tracks ? `, ${totals.tracks} track${totals.tracks === 1 ? '' : 's'}` : ''}`
    : '';

  const existingPicker = dom.folderList.querySelector('.picker');
  dom.folderList.replaceChildren();
  if (existingPicker) dom.folderList.append(existingPicker);

  if (!folders.length) {
    dom.folderList.append(el('p', {
      class: 'hint',
      html: 'No folders yet. Create one, then use <b>Import from a map…</b> to file waypoints into it — '
        + 'or click any waypoint on the map and save it.',
    }));
    return;
  }

  for (const folder of folders) {
    dom.folderList.append(renderFolder(folder));
  }

  restoreOpenEditor();
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
    el('input', {
      type: 'checkbox', checked: folder.visible, 'aria-label': `Show ${folder.name} on the map`,
      onchange: (event) => state.folders.update(folder.id, { visible: event.target.checked }),
    }),
    el('button', {
      class: 'folder-swatch', type: 'button', style: `background:${folder.color}`,
      title: 'Change colour', 'aria-label': `Change the colour of ${folder.name}`,
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
    el('div', { class: 'folder-head-actions' }, [
      el('button', {
        class: `icon-button${chosen.length ? ' is-armed' : ''}`, type: 'button',
        title: chosen.length
          ? `Style the ${chosen.length} selected pin${chosen.length === 1 ? '' : 's'}`
          : 'Style every pin in this folder',
        'aria-label': `Style pins in ${folder.name}`,
        html: icons.brush,
        onclick: (event) => openStyleEditor(folder, chosen.length ? chosen : null, event.currentTarget.closest('.folder-head')),
      }),
      el('button', {
        class: 'icon-button', type: 'button', title: 'Zoom to this folder',
        'aria-label': `Zoom to ${folder.name}`, html: icons.target,
        onclick: () => {
          const bounds = geojsonBounds(state.folders.folderGeoJSON(folder.id));
          if (boundsAreValid(bounds)) fitTo(bounds);
          else toast('That folder has nothing in it yet.', { tone: 'error' });
        },
      }),
      el('button', {
        class: 'icon-button', type: 'button', title: 'Export this folder as GPX',
        'aria-label': `Export ${folder.name} as GPX`, html: icons.download,
        onclick: () => exportFolder(folder),
      }),
      el('button', {
        class: 'icon-button', type: 'button', title: 'Delete this folder',
        'aria-label': `Delete ${folder.name}`, html: icons.trash,
        onclick: () => {
          const message = counts.total
            ? `Delete “${folder.name}” and its ${counts.total} item${counts.total === 1 ? '' : 's'}? This cannot be undone.`
            : `Delete “${folder.name}”?`;
          if (window.confirm(message)) state.folders.remove(folder.id);
        },
      }),
    ]),
  ]);

  const body = el('div', { class: 'folder-body' });
  if (!folder.items.length) {
    body.append(el('p', { class: 'folder-empty', text: 'Empty — drag items here, or import from a loaded map.' }));
  } else {
    for (const item of folder.items) body.append(renderFolderItem(folder, item));
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

  node.append(head, body);
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
      onclick: () => focusFolderItem(item),
      onkeydown: (event) => { if (event.key === 'Enter') focusFolderItem(item); },
    }),
    meta ? el('span', { class: 'folder-item-meta', text: meta }) : null,
    isWaypoint
      ? el('button', {
        class: 'icon-button', type: 'button', title: 'Edit colour and icon',
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

function focusFolderItem(item) {
  const feature = item.feature;
  if (feature.geometry?.type === 'Point') {
    state.map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 14), duration: 600 });
    showFeaturePopup(feature, feature.geometry.coordinates);
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
  editor.append(el('div', { class: 'style-label', text: 'Colour' }));
  const colorRow = el('div', { class: 'swatch-row' });
  const paintSwatches = () => {
    colorRow.querySelectorAll('.swatch').forEach((node) => {
      node.classList.toggle('is-chosen', node.dataset.color === (chosenColor || ''));
    });
  };
  colorRow.append(el('button', {
    class: 'swatch is-inherit', type: 'button', dataset: { color: '' },
    title: 'Clear the override and use the folder colour',
    'aria-label': 'Use the folder colour',
    style: `--swatch:${folder.color}`,
    onclick: () => { chosenColor = null; colorTouched = true; paintSwatches(); },
  }));
  for (const color of FOLDER_COLORS) {
    colorRow.append(el('button', {
      class: 'swatch', type: 'button', dataset: { color },
      title: color, 'aria-label': `Colour ${color}`, style: `--swatch:${color}`,
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

  editor.append(el('div', { class: 'picker-row' }, [
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
  ]));

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
    setCursor(null);
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

function downloadVisible() {
  const features = [];
  for (const entry of state.documents.values()) {
    if (!entry.visible) continue;
    for (const feature of entry.doc.geojson.features) {
      features.push({ ...feature, properties: { ...feature.properties, source: entry.name } });
    }
  }
  if (!features.length) {
    toast('Nothing visible to export.', { tone: 'error' });
    return;
  }
  downloadText('american-byways-maps.geojson',
    JSON.stringify({ type: 'FeatureCollection', features }, null, 2), 'application/geo+json');
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
