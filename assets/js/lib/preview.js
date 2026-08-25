/**
 * A thumbnail of what each basemap looks like, where you are looking.
 *
 * A list of nine names — USGS Topo, USGS Topo (classic), USGS Imagery + Topo,
 * Esri imagery — tells you almost nothing about which one you want. One tile
 * from each tells you immediately: imagery is a photograph, a topo is brown
 * contours, a street map is white and grey.
 *
 * Three cases, and the difference is what each basemap can actually produce:
 *
 *   - raster basemaps hand over one of their own tiles, which is exact;
 *   - a hosted Mapbox style renders through the Static Images API, also exact;
 *   - Byways Topo is a style document this app builds in the browser, so
 *     nothing renders it server-side. It gets a drawn swatch of its own palette
 *     instead of a photograph of somebody else's map, which would be a lie.
 *
 * The previews follow the map: they are built from the current centre, so they
 * answer "what would this look like *here*" rather than showing the same
 * corner of Tennessee to everyone.
 */

const SPAN = 20037508.342789244;

/** Tile x/y for a position, in the XYZ scheme every one of these services uses. */
export function tileFor(lon, lat, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  const limit = n - 1;
  return { x: Math.min(Math.max(0, x), limit), y: Math.min(Math.max(0, y), limit), z: zoom };
}

/** That tile's bounds in web mercator metres, for the bbox-templated services. */
export function tileBBox({ x, y, z }) {
  const size = (SPAN * 2) / 2 ** z;
  const west = -SPAN + x * size;
  const north = SPAN - y * size;
  return [west, north - size, west + size, north];
}

/**
 * Fill a tile template for one tile.
 *
 * The same three shapes the app's tile sources come in: {z}/{x}/{y}, an ArcGIS
 * or WMS bounding box, and a subdomain letter.
 */
export function tileURL(template, tile) {
  const [w, s, e, n] = tileBBox(tile);
  return String(template)
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y))
    .replace(/\{bbox-epsg-3857\}/g, `${w},${s},${e},${n}`)
    .replace(/\{s\}/g, 'a');
}

/**
 * How a basemap should be previewed.
 *
 * @returns {{kind: 'image', src: string} | {kind: 'swatch'} | null}
 */
export function previewFor(basemap, { lon = -84.28, lat = 35.96, zoom = 10, token = '' } = {}) {
  if (!basemap) return null;

  // Byways Topo is built here, in the browser. Nothing else can render it, and
  // its raster `tiles` are the no-token fallback — a different map entirely, so
  // previewing with them would advertise the wrong thing.
  if (basemap.custom === 'byways') return { kind: 'swatch' };

  if (basemap.style && token) {
    const hosted = String(basemap.style).replace(/^mapbox:\/\/styles\//, '');
    // Retina, because a 48px thumbnail of a 48px render is mush.
    return {
      kind: 'image',
      src: `https://api.mapbox.com/styles/v1/${hosted}/static/`
        + `${lon.toFixed(4)},${lat.toFixed(4)},${Math.round(zoom)},0/144x100@2x`
        + `?access_token=${encodeURIComponent(token)}&attribution=false&logo=false`,
    };
  }
  if (basemap.style) return null;

  if (!basemap.tiles?.length) return null;

  // Clamped to what the service actually publishes: asking USGS for z16 over
  // open country returns a blank tile, which previews as an empty grey box.
  const z = Math.min(Math.max(3, Math.round(zoom)), basemap.maxzoom || 16);
  return { kind: 'image', src: tileURL(basemap.tiles[0], tileFor(lon, lat, z)) };
}

/**
 * The drawn stand-in for a style this app renders itself.
 *
 * Its own palette rather than a generic map glyph: parchment, contours, a green
 * of woodland and the red of a US route. Anyone who has seen the map once will
 * recognise it, which is the whole job of a thumbnail.
 */
export function swatchSVG({ paper, contour, wood, water, road } = {}) {
  /*
   * Joined rather than written as one indented template.
   *
   * `innerHTML` keeps the whitespace between tags as real text nodes, so an
   * indented SVG puts ten blank lines into the row's textContent ahead of its
   * name — invisible on screen, and enough to break anything that matches the
   * row by the text it starts with.
   */
  return [
    '<svg viewBox="0 0 48 34" preserveAspectRatio="none" aria-hidden="true">',
    `<rect width="48" height="34" fill="${paper || '#f4ecdd'}"/>`,
    `<path d="M0 24 Q 12 19 24 23 T 48 21 L48 34 L0 34 Z" fill="${wood || '#cfd9b8'}" opacity=".55"/>`,
    `<g fill="none" stroke="${contour || '#b9a184'}" stroke-width=".8" opacity=".8">`,
    '<path d="M0 8 Q 14 3.5 26 8 T 48 6.5"/>',
    '<path d="M0 13 Q 14 8.5 26 13 T 48 11.5"/>',
    '<path d="M0 18 Q 14 13.5 26 18 T 48 16.5"/>',
    '</g>',
    `<path d="M0 29 Q 16 26 30 30 T 48 28" fill="none" stroke="${water || '#7fa9c4'}" stroke-width="1.3"/>`,
    `<path d="M7 34 Q 11 21 21 15 T 43 5" fill="none" stroke="${road || '#c0392b'}" stroke-width="1.7"/>`,
    '</svg>',
  ].join('');
}
