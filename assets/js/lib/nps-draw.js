/**
 * Drawing the National Park Service symbols: the badge on the map, the key in
 * the panel.
 *
 * Split from nps-icons.js, which is generated from the library and was
 * overwritten with these functions still in it - the generator knew nothing
 * of them. Data is generated; drawing is written; they live apart.
 */

import { NPS_ICONS, NPS_VIEWBOX, npsIcon } from './nps-icons.js';

/* ------------------------------------------------------------------ drawing */

/**
 * The badge these symbols are meant to sit on.
 *
 * NPS draws them white on a solid colour, and that is not decoration — it is
 * what makes them legible. The app's own pin glyphs are thin white strokes with
 * a drop shadow, which works on the coloured circle of the waypoint editor and
 * disappears into a topo map full of brown contours and green woodland. Reading
 * an icon means separating it from its background first, and a filled badge is
 * how a road sign does that.
 *
 * The rounded square is the shape the recreation symbols use on real signage,
 * as opposed to the circle this app uses for a saved waypoint — which is a
 * useful difference to keep: one is a place somebody published, the other is a
 * place you marked.
 */
const BADGE = '#3d5c3a';
const PAD = 3.4;

export function rasterizeNPSIcon(id, { size = 26, pixelRatio = 2, badge = BADGE } = {}) {
  const icon = npsIcon(id);
  if (!icon || typeof document === 'undefined') return null;

  const px = Math.round(size * pixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  // Draw on the symbol's own 22-unit grid plus the padding the badge needs, so
  // the paths below are the library's numbers untouched.
  const board = NPS_VIEWBOX + PAD * 2;
  ctx.scale(px / board, px / board);

  const radius = 5;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(board, 0, board, board, radius);
  ctx.arcTo(board, board, 0, board, radius);
  ctx.arcTo(0, board, 0, 0, radius);
  ctx.arcTo(0, 0, board, 0, radius);
  ctx.closePath();
  ctx.fillStyle = badge;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.translate(PAD, PAD);
  ctx.fillStyle = '#ffffff';
  for (const d of icon.f) ctx.fill(new Path2D(d));

  return ctx.getImageData(0, 0, px, px);
}

/**
 * The same symbol as inline SVG, for the panel's key.
 *
 * A key made of coloured squares beside words cannot answer "which of these is
 * the tent" — the reader has to hold a colour in their head and go looking. The
 * key should be the symbol itself, at the size it is drawn on the map.
 *
 * Built by joining rather than as one indented template: innerHTML keeps the
 * whitespace between tags as real text nodes, and this repository has already
 * lost an afternoon to a row whose textContent began with ten blank lines.
 */
export function npsIconSVG(id, { size = 18, badge = BADGE } = {}) {
  const icon = npsIcon(id);
  if (!icon) return '';
  const board = NPS_VIEWBOX + PAD * 2;
  return [
    `<svg viewBox="0 0 ${board} ${board}" width="${size}" height="${size}" aria-hidden="true">`,
    `<rect x="0.5" y="0.5" width="${board - 1}" height="${board - 1}" rx="5"`,
    ` fill="${badge}" stroke="rgba(255,255,255,0.9)"/>`,
    `<g transform="translate(${PAD} ${PAD})" fill="#ffffff">`,
    ...icon.f.map((d) => `<path d="${d}"/>`),
    '</g></svg>',
  ].join('');
}

/** Map image id, kept beside the drawing so a layer spec cannot disagree. */
export const npsImageId = (id) => `nps-${id}`;

/**
 * Register every symbol as a map image.
 *
 * Idempotent, and safe to call again after a style change — a style swap
 * discards every registered image, and a layer naming one that is not there
 * draws nothing and says nothing.
 */
export function registerNPSImages(map, { pixelRatio = 2 } = {}) {
  let added = 0;
  for (const icon of NPS_ICONS) {
    const imageId = npsImageId(icon.id);
    if (map.hasImage?.(imageId)) continue;
    const data = rasterizeNPSIcon(icon.id, { pixelRatio });
    if (!data) continue;
    try {
      map.addImage(imageId, data, { pixelRatio });
      added += 1;
    } catch {
      // Already there, or the style changed mid-loop. Neither is fatal.
    }
  }
  return added;
}
