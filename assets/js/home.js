/**
 * Landing page: renders the published catalogue with search and facet filters.
 *
 * Card thumbnails are drawn from the `preview` polyline the build step stores in
 * catalog.json — normalised to a unit box — so the grid never has to download
 * the actual track files.
 */

import { SITE } from './config.js';
import { loadCatalog, facet, filterMaps } from './lib/catalog.js';
import { el, escapeHTML, initTheme, formatDate } from './lib/ui.js';
import { formatDistance, formatElevation } from './lib/geo.js';
import { registerServiceWorker } from './lib/pwa.js';

const dom = {};
let catalog = { maps: [] };

function cacheDom() {
  dom.grid = document.getElementById('catalog-grid');
  dom.message = document.getElementById('catalog-message');
  dom.search = document.getElementById('search');
  dom.region = document.getElementById('filter-region');
  dom.tag = document.getElementById('filter-tag');
  dom.count = document.getElementById('library-count');
  dom.strip = document.getElementById('stat-strip');
}

function applyBranding() {
  document.title = `Map library — ${SITE.name}`;
  const set = (id, value) => { const node = document.getElementById(id); if (node && value) node.textContent = value; };
  set('brand-name', SITE.name);
  set('brand-parent', SITE.parent?.name);
  set('parent-name', SITE.parent?.name);
  set('footer-name', SITE.name);
  set('footer-tagline', SITE.tagline);
  set('footer-holder', SITE.copyrightHolder);
  const link = document.getElementById('footer-parent-link');
  if (link && SITE.parent?.url) { link.href = SITE.parent.url; link.textContent = SITE.parent.name; }
}

/** Route thumbnail: the stored preview polyline, fitted to the card's aspect box. */
function thumbnail(record) {
  const width = 320;
  const height = 180;
  const pad = 18;
  const preview = Array.isArray(record.preview) ? record.preview : [];

  if (preview.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="${width}" height="${height}" fill="var(--paper-2)"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="16" fill="none" stroke="var(--line-strong)" stroke-width="2"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="4" fill="var(--line-strong)"/>
    </svg>`;
  }

  // Fit the route's own extent into the card, preserving its aspect ratio so a
  // long east-west road fills the width instead of shrinking to a square.
  const xs = preview.map(([x]) => x);
  const ys = preview.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const extentX = Math.max(...xs) - minX;
  const extentY = Math.max(...ys) - minY;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const scale = Math.min(
    extentX > 0 ? innerW / extentX : Infinity,
    extentY > 0 ? innerH / extentY : Infinity,
  );
  const safeScale = Number.isFinite(scale) ? scale : 1;
  const offsetX = (width - extentX * safeScale) / 2;
  const offsetY = (height - extentY * safeScale) / 2;

  const points = preview.map(([x, y]) => [
    (offsetX + (x - minX) * safeScale).toFixed(1),
    (height - offsetY - (y - minY) * safeScale).toFixed(1),
  ].join(','));
  const path = `M${points.join('L')}`;
  const [startX, startY] = points[0].split(',');
  const [endX, endY] = points[points.length - 1].split(',');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <rect width="${width}" height="${height}" fill="var(--paper-2)"/>
    <path d="${path}" fill="none" stroke="var(--line-strong)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
    <path d="${path}" fill="none" stroke="var(--clay)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${startX}" cy="${startY}" r="3.4" fill="var(--pine)" stroke="var(--surface)" stroke-width="1.6"/>
    <circle cx="${endX}" cy="${endY}" r="3.4" fill="var(--clay)" stroke="var(--surface)" stroke-width="1.6"/>
  </svg>`;
}

function card(record) {
  const viewerURL = `./?m=${encodeURIComponent(record.slug)}`;
  const fileURL = record.path || `data/maps/${record.file}`;
  const stats = record.stats || {};

  const statBits = [];
  if (stats.distance_m) statBits.push(`<span><b>${escapeHTML(formatDistance(stats.distance_m))}</b></span>`);
  if (stats.ascent_m) statBits.push(`<span><b>${escapeHTML(formatElevation(stats.ascent_m))}</b> gain</span>`);
  if (stats.waypointCount) statBits.push(`<span><b>${stats.waypointCount}</b> waypoints</span>`);
  if (!statBits.length && record.updated) statBits.push(`<span>${escapeHTML(formatDate(record.updated))}</span>`);

  const node = el('article', { class: 'map-card' });
  node.innerHTML = `
    <a class="map-card-figure" href="${escapeHTML(viewerURL)}" aria-label="Open ${escapeHTML(record.title)} in the viewer">
      ${thumbnail(record)}
      <span class="map-card-badge">${escapeHTML((record.format || '').toUpperCase())}</span>
    </a>
    <div class="map-card-body">
      <h3><a href="${escapeHTML(viewerURL)}">${escapeHTML(record.title)}</a></h3>
      ${record.region ? `<div class="map-card-region">${escapeHTML(record.region)}</div>` : ''}
      ${record.tags?.length ? `<div class="tag-row">${record.tags.map((t) => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>` : ''}
      ${record.description ? `<p class="map-card-desc">${escapeHTML(record.description)}</p>` : '<p class="map-card-desc"></p>'}
      ${statBits.length ? `<div class="map-card-stats">${statBits.join('')}</div>` : ''}
      <div class="map-card-actions">
        <a class="button button-primary button-small" href="${escapeHTML(viewerURL)}">View map</a>
        <a class="button button-secondary button-small" href="${escapeHTML(fileURL)}" download>Download</a>
      </div>
    </div>`;
  return node;
}

function renderStats() {
  const maps = catalog.maps;
  if (!maps.length) return;
  const distance = maps.reduce((sum, m) => sum + (m.stats?.distance_m || 0), 0);
  const waypoints = maps.reduce((sum, m) => sum + (m.stats?.waypointCount || 0), 0);
  const regions = new Set(maps.map((m) => m.region).filter(Boolean));

  document.getElementById('stat-maps').textContent = maps.length;
  document.getElementById('stat-distance').textContent = distance ? formatDistance(distance) : '—';
  document.getElementById('stat-waypoints').textContent = waypoints || '—';
  document.getElementById('stat-regions').textContent = regions.size || '—';
  dom.strip.hidden = false;
}

function renderFilters() {
  for (const [select, field, label] of [[dom.region, 'region', 'All regions'], [dom.tag, 'tags', 'All tags']]) {
    const values = facet(catalog, field);
    select.replaceChildren(el('option', { value: '', text: label }));
    for (const value of values) select.append(el('option', { value, text: value }));
    select.hidden = values.length === 0;
  }
}

function render() {
  const matches = filterMaps(catalog.maps, {
    query: dom.search.value,
    region: dom.region.value,
    tag: dom.tag.value,
  });

  dom.grid.replaceChildren(...matches.map(card));
  dom.message.replaceChildren();

  if (!catalog.maps.length) {
    dom.message.append(el('div', { class: 'empty-state' }, [
      el('h3', { text: 'The library is empty' }),
      el('p', {
        html: 'Add a GaiaGPS export to <code>data/maps/</code> and run <code>npm run build</code> to publish it. '
          + 'In the meantime, the <a href="./">map</a> will open files straight from your computer.',
      }),
    ]));
  } else if (!matches.length) {
    dom.message.append(el('div', { class: 'empty-state' }, [
      el('h3', { text: 'No maps match those filters' }),
      el('p', { text: 'Try a different search term, or clear the region and tag filters.' }),
    ]));
  }

  dom.count.textContent = catalog.maps.length
    ? `${matches.length} of ${catalog.maps.length} map${catalog.maps.length === 1 ? '' : 's'}`
    : '';
}

async function main() {
  cacheDom();
  applyBranding();
  initTheme(document.getElementById('theme-toggle'));

  try {
    catalog = await loadCatalog();
  } catch (error) {
    dom.message.append(el('div', { class: 'empty-state' }, [
      el('h3', { text: 'The catalogue could not be loaded' }),
      el('p', { text: error.message }),
    ]));
    return;
  }

  renderStats();
  renderFilters();
  render();

  dom.search.addEventListener('input', render);
  dom.region.addEventListener('change', render);
  dom.tag.addEventListener('change', render);
}

main();

// The library page shares the worker's scope, so installing from here works
// too — and an already-installed app opened on this page keeps its cache warm.
registerServiceWorker();
