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
  SITE, BASEMAPS, DEFAULT_BASEMAP, OVERLAYS, DEFAULT_VIEW, DEFAULT_UNITS, TRACK_COLORS,
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
};

const dom = {};
let toast = () => {};

/* ------------------------------------------------------------------ helpers */

const basemapById = (id) => BASEMAPS.find((b) => b.id === id) || BASEMAPS[0];

/** Basemaps needing a Mapbox token are hidden entirely when none is configured. */
const availableBasemaps = () => BASEMAPS.filter((b) => !b.requiresToken || hasMapboxToken());

const sourceIdFor = (key) => `data-${key}`;
const layerIdsFor = (key) => [
  `${key}-fill`, `${key}-fill-line`, `${key}-line-casing`, `${key}-line`, `${key}-point-halo`, `${key}-point`,
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
  document.title = `Map viewer · ${SITE.name}`;
  toast = createToaster(dom.toasts);
  initTheme(document.getElementById('theme-toggle'));
  wirePanel();
  wireDropzone();

  const { gl, engine } = await loadEngine();
  state.gl = gl;
  state.engine = engine;

  const initial = readURL();
  state.basemapId = initial.basemap || DEFAULT_BASEMAP;
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

  state.map.on('error', (event) => {
    // Tile 404s are noisy and self-correcting; only surface real failures.
    const message = event?.error?.message || '';
    if (/Failed to fetch|NetworkError/i.test(message)) return;
    console.warn('[map]', message || event);
  });

  await new Promise((resolve) => state.map.on('load', resolve));
  addScratchLayers();
  renderLayersTab();

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

function cacheDom() {
  dom.app = document.querySelector('.app');
  dom.panel = document.getElementById('panel');
  dom.tabs = [...document.querySelectorAll('.panel-tab')];
  dom.tabPanels = {
    layers: document.getElementById('tab-layers'),
    maps: document.getElementById('tab-maps'),
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
  if (state.basemapId !== DEFAULT_BASEMAP) params.set('b', state.basemapId);

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
    dom.panel.hidden = !dom.panel.hidden;
  });
  dom.unitsToggle?.addEventListener('click', () => {
    state.units = state.units === 'imperial' ? 'metric' : 'imperial';
    dom.unitsToggle.textContent = state.units === 'imperial' ? 'mi / ft' : 'km / m';
    renderMapsTab();
    renderDetailsTab();
    writeURL();
  });
  document.getElementById('share-button')?.addEventListener('click', shareView);
  document.getElementById('download-button')?.addEventListener('click', downloadVisible);
  document.getElementById('fit-button')?.addEventListener('click', fitAll);
}

function selectTab(name) {
  for (const tab of dom.tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    dom.tabPanels[tab.dataset.tab].hidden = !selected;
  }
}

function setStatus(busy, text = 'Loading…') {
  if (!dom.status) return;
  dom.status.hidden = !busy;
  if (busy) dom.statusText.textContent = text;
}

/* ------------------------------------------------------------------ basemaps & overlays */

function activeOverlays() {
  return OVERLAYS
    .filter((o) => state.overlays.get(o.id)?.visible)
    .map((o) => ({ ...o, opacity: state.overlays.get(o.id).opacity }));
}

function renderLayersTab() {
  dom.basemapList.replaceChildren();
  let currentGroup = null;
  for (const basemap of availableBasemaps()) {
    if (basemap.group !== currentGroup) {
      currentGroup = basemap.group;
      dom.basemapList.append(el('div', { class: 'layer-group-label', text: currentGroup }));
    }
    const selected = basemap.id === state.basemapId;
    dom.basemapList.append(el('label', { class: `layer-option${selected ? ' is-selected' : ''}` }, [
      el('input', {
        type: 'radio', name: 'basemap', value: basemap.id, checked: selected,
        onchange: () => setBasemap(basemap.id),
      }),
      el('span', { class: 'layer-option-text' }, [
        el('span', { class: 'layer-option-name', text: basemap.name }),
        el('span', { class: 'layer-option-desc', text: basemap.description || '' }),
      ]),
    ]));
  }

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
      el('label', { class: 'layer-option' }, [
        el('input', {
          type: 'checkbox', checked: entry.visible,
          onchange: (event) => {
            entry.visible = event.target.checked;
            opacityRow.hidden = !entry.visible;
            if (entry.visible) addOverlayLayer(overlay); else removeOverlayLayer(overlay.id);
            writeURL();
          },
        }),
        el('span', { class: 'layer-option-text' }, [
          el('span', { class: 'layer-option-name', text: overlay.name }),
          el('span', { class: 'layer-option-desc', text: overlay.description || '' }),
        ]),
      ]),
      opacityRow,
    );
  }
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
    addScratchLayers();
    for (const entry of state.documents.values()) addDocumentLayers(entry);
    applyVisibility();
  });
  renderLayersTab();
  writeURL();
}

function firstDataLayerId() {
  const layers = state.map.getStyle()?.layers || [];
  const found = layers.find((layer) => layer.id.startsWith('data-') || /-line-casing$|-fill$|^scratch-/.test(layer.id));
  return found?.id;
}

function addOverlayLayer(overlay) {
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

/** Sources used for selection highlight and the elevation-profile cursor. */
function addScratchLayers() {
  const empty = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  if (!state.map.getSource('scratch-highlight')) state.map.addSource('scratch-highlight', empty);
  if (!state.map.getSource('scratch-cursor')) state.map.addSource('scratch-cursor', empty);

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
}

function removeDocumentLayers(key) {
  for (const id of layerIdsFor(key)) if (state.map.getLayer(id)) state.map.removeLayer(id);
  const sourceId = sourceIdFor(key);
  if (state.map.getSource(sourceId)) state.map.removeSource(sourceId);
}

function applyVisibility() {
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
  if (props.folder) rows.push(['Folder', props.folder]);

  const description = props.description ? String(props.description).slice(0, 1200) : '';
  const html = `
    <div class="popup-title">${escapeHTML(props.name || 'Untitled')}</div>
    <div class="popup-kind">${escapeHTML(props.kind || 'feature')}</div>
    ${description ? `<p class="popup-desc">${escapeHTML(description)}</p>` : ''}
    ${rows.length ? `<dl class="popup-stats">${rows.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}</dl>` : ''}
  `;

  new state.gl.Popup({ closeButton: true, maxWidth: '300px', offset: 12 })
    .setLngLat(feature.geometry?.type === 'Point' ? feature.geometry.coordinates : lngLat)
    .setHTML(html)
    .addTo(state.map);
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
  for (const file of accepted) {
    try {
      const isBinary = /\.kmz$/i.test(file.name);
      const payload = isBinary ? await file.arrayBuffer() : await file.text();
      const doc = await parseMapFile(payload, file.name);
      if (!doc.geojson.features.length) {
        toast(`“${file.name}” contained no mappable features.`, { tone: 'error' });
        continue;
      }
      await addDocument({ name: doc.name || file.name, doc, origin: 'local', fit: false });
      bounds = bounds ? mergeBounds(bounds, doc.bbox) : doc.bbox;
    } catch (error) {
      toast(`${file.name}: ${error.message}`, { tone: 'error', timeout: 9000 });
    }
  }
  setStatus(false);
  if (bounds) {
    fitTo(bounds);
    toast(`Loaded ${accepted.length} file${accepted.length > 1 ? 's' : ''}. These stay in your browser — nothing is uploaded.`, { tone: 'ok' });
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
