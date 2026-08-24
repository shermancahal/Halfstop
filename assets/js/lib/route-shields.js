/**
 * Route shields, drawn by us.
 *
 * The first version of this asked Mapbox's sprite for shield images by name —
 * `us-interstate-2`, `us-highway-3` and so on. On the map, I-64 came out with
 * no shield at all, and that failure is invisible from the style: an
 * `icon-image` naming an image the sprite does not have renders nothing and
 * reports nothing. Which sprite carries which name is also outside our control
 * and changes between style versions.
 *
 * So these are drawn here, on a canvas, and registered with the map the same
 * way the pin icons are. Four designs at four widths is sixteen small images,
 * generated once per style load, and they cannot go missing because nothing
 * external supplies them.
 *
 * The shapes follow the real signs closely enough to be recognised at a glance,
 * which is the entire job: you should not have to read a shield to know that a
 * blue one is an interstate.
 */

/** Widths are indexed by how many characters the route number has. */
const MIN_LEN = 2;
const MAX_LEN = 4;

export const SHIELD_DESIGNS = ['interstate', 'us', 'state', 'default'];

/**
 * Map Mapbox's `shield` field onto one of our four designs.
 *
 * Mapbox ships a long tail of shield values, most of them variants
 * (`us-interstate-duplex`, `us-highway-business`). Collapsing them to four
 * keeps the image count small, and a variant drawn as its parent design is far
 * better than a variant drawn as nothing.
 */
export function shieldDesign(value = '') {
  const text = String(value).toLowerCase();
  if (text.startsWith('us-interstate')) return 'interstate';
  if (text.startsWith('us-highway')) return 'us';
  if (text.startsWith('us-state') || text.startsWith('us-')) return 'state';
  return 'default';
}

export function shieldImageId(design, length) {
  const clamped = Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round(length) || MIN_LEN));
  return `abmap-shield-${design}-${clamped}`;
}

/** Every image id this module can register, for tests and for the style. */
export function shieldImageIds() {
  const ids = [];
  for (const design of SHIELD_DESIGNS) {
    for (let length = MIN_LEN; length <= MAX_LEN; length += 1) ids.push(shieldImageId(design, length));
  }
  return ids;
}

/* ------------------------------------------------------------------ drawing */

const COLOURS = {
  interstate: { fill: '#1b3f70', stroke: '#ffffff', crown: '#b0202f', text: '#ffffff' },
  us: { fill: '#ffffff', stroke: '#2b2b2b', text: '#1c1c1c' },
  state: { fill: '#ffffff', stroke: '#3d3225', text: '#1c1c1c' },
  default: { fill: '#fbf7ee', stroke: '#64513b', text: '#3a3026' },
};

const HEIGHT = 20;

function shieldWidth(length) {
  return { 2: 22, 3: 27, 4: 33 }[length] || 22;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The interstate outline: a rounded escutcheon, wider at the shoulders than the
 * foot. Approximated with curves rather than traced exactly — at 20 pixels the
 * silhouette is what reads, not the fidelity.
 */
function interstatePath(ctx, w, h) {
  const inset = 1.5;
  ctx.beginPath();
  ctx.moveTo(w / 2, inset);
  ctx.bezierCurveTo(w * 0.78, inset, w - inset, h * 0.16, w - inset, h * 0.34);
  ctx.bezierCurveTo(w - inset, h * 0.66, w * 0.72, h * 0.9, w / 2, h - inset);
  ctx.bezierCurveTo(w * 0.28, h * 0.9, inset, h * 0.66, inset, h * 0.34);
  ctx.bezierCurveTo(inset, h * 0.16, w * 0.22, inset, w / 2, inset);
  ctx.closePath();
}

/** The US route outline: a squarer shield with a flat top and a pointed foot. */
function usRoutePath(ctx, w, h) {
  const inset = 1.5;
  ctx.beginPath();
  ctx.moveTo(inset, inset + h * 0.08);
  ctx.lineTo(w - inset, inset + h * 0.08);
  ctx.lineTo(w - inset, h * 0.55);
  ctx.quadraticCurveTo(w - inset, h * 0.82, w / 2, h - inset);
  ctx.quadraticCurveTo(inset, h * 0.82, inset, h * 0.55);
  ctx.closePath();
}

/**
 * Draw one shield into an ImageData the GL engine can take.
 *
 * Returns null where there is no canvas — Node, or a browser refusing one —
 * so the caller can skip registration rather than throw.
 */
export function rasterizeShield(design, length, { pixelRatio = 2 } = {}) {
  if (typeof document === 'undefined') return null;

  const width = shieldWidth(Math.max(MIN_LEN, Math.min(MAX_LEN, length)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(HEIGHT * pixelRatio);

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(pixelRatio, pixelRatio);

  const colours = COLOURS[design] || COLOURS.default;
  ctx.lineJoin = 'round';

  if (design === 'interstate') {
    interstatePath(ctx, width, HEIGHT);
    ctx.fillStyle = colours.fill;
    ctx.fill();

    // The red crown across the top, clipped to the shield outline.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = colours.crown;
    ctx.fillRect(0, 0, width, HEIGHT * 0.3);
    ctx.restore();

    interstatePath(ctx, width, HEIGHT);
    ctx.strokeStyle = colours.stroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  } else if (design === 'us') {
    usRoutePath(ctx, width, HEIGHT);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.strokeStyle = colours.stroke;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  } else {
    roundedRect(ctx, 1, 2, width - 2, HEIGHT - 4, design === 'state' ? 3 : 2.5);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.strokeStyle = colours.stroke;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Register every shield image with a map.
 *
 * Idempotent, and safe to call after each style load — a style swap discards
 * registered images, so this has to run again on the other side of one.
 */
export function registerShieldImages(map, { pixelRatio = 2 } = {}) {
  let added = 0;
  for (const design of SHIELD_DESIGNS) {
    for (let length = MIN_LEN; length <= MAX_LEN; length += 1) {
      const id = shieldImageId(design, length);
      if (map.hasImage && map.hasImage(id)) continue;
      const data = rasterizeShield(design, length, { pixelRatio });
      if (!data) continue;
      try {
        map.addImage(id, data, { pixelRatio });
        added += 1;
      } catch {
        // Already present, or the style changed mid-loop. Neither is fatal.
      }
    }
  }
  return added;
}

/**
 * The expression that picks a shield image for a road feature.
 *
 * Built from the feature's own `shield` and `reflen`, clamped to the widths we
 * actually generated so a seven-character route reference lands on the widest
 * image rather than on a name that does not exist.
 */
export function shieldImageExpression() {
  return [
    'concat',
    'abmap-shield-',
    [
      'match', ['get', 'shield'],
      ['us-interstate', 'us-interstate-business', 'us-interstate-duplex', 'us-interstate-truck'], 'interstate',
      ['us-highway', 'us-highway-business', 'us-highway-duplex', 'us-highway-truck', 'us-highway-alternate'], 'us',
      ['us-state', 'us-state-duplex'], 'state',
      'default',
    ],
    '-',
    ['to-string', ['max', MIN_LEN, ['min', MAX_LEN, ['coalesce', ['get', 'reflen'], MIN_LEN]]]],
  ];
}

export const SHIELD_TEXT_COLOUR = [
  'match', ['get', 'shield'],
  ['us-interstate', 'us-interstate-business', 'us-interstate-duplex', 'us-interstate-truck'], '#ffffff',
  '#1c1c1c',
];
