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

/* ------------------------------------------------------------ state shields */

/**
 * What each state's route marker looks like.
 *
 * Shapes are simplified deliberately. A marker is drawn about 20 pixels tall,
 * and at that size a silhouette and one or two flat colours are the whole of
 * what a reader perceives — an accurate Louisiana coastline and a rounded blob
 * are the same picture. Simplifying is the correct answer here, not a
 * compromise.
 *
 * Read off a reference sheet of the real markers rather than recalled, after a
 * first pass from memory got a third of them wrong — Florida is an outline and
 * not a circle, Ohio a square and not an outline, Arizona white and not black.
 * Anything not listed falls back to the plain rounded rectangle.
 *
 * Lettering on the real signs (MONTANA, TEXAS, the Nebraska wagon, the
 * Washington profile) is deliberately dropped: at twenty pixels it is a smudge
 * that competes with the route number, which is the part you need.
 *
 * Adding a state is one line. Correcting one is one word.
 */
export const STATE_SHIELDS = {
  /* Plain squares — the most common marker by a wide margin */
  AL: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  AZ: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  CT: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  GA: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  HI: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  IL: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  IN: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  ME: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  MD: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  MA: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  MT: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  NE: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  NV: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  NY: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  OH: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  RI: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  TN: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  TX: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  WV: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  WI: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  WA: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },

  /* Circles */
  DE: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  IA: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  KY: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  MS: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  NJ: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  VA: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },

  /* Diamonds */
  MI: { shape: 'diamond', bg: '#ffffff', fg: '#1c1c1c' },
  NC: { shape: 'diamond', bg: '#ffffff', fg: '#1c1c1c' },

  /* State outlines — simplified; at this size the silhouette is all that reads */
  AK: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  AR: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  DC: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  FL: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  MO: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  NH: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  ND: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  OK: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  ID: { shape: 'outline', bg: '#1c1c1c', fg: '#ffffff' },
  LA: { shape: 'outline', bg: '#0b6b3a', fg: '#ffffff' },
  SD: { shape: 'outline', bg: '#0b6b3a', fg: '#ffffff' },

  /* The distinctive ones, and the reason this was worth doing at all */
  CA: { shape: 'spade', bg: '#0b6b3a', fg: '#ffffff' },
  PA: { shape: 'keystone', bg: '#ffffff', fg: '#1c1c1c' },
  UT: { shape: 'beehive', bg: '#ffffff', fg: '#1c1c1c' },
  NM: { shape: 'zia', bg: '#ffffff', fg: '#b0202f' },
  CO: { shape: 'flag-co', bg: '#ffffff', fg: '#1c1c1c' },
  KS: { shape: 'sunflower', bg: '#f2c744', fg: '#1c1c1c' },
  OR: { shape: 'shield', bg: '#ffffff', fg: '#1c1c1c' },

  /* Coloured plates */
  WY: { shape: 'square', bg: '#f2c744', fg: '#1c1c1c' },
  MN: { shape: 'square', bg: '#1e4b8f', fg: '#ffffff' },
  VT: { shape: 'square', bg: '#0b6b3a', fg: '#ffffff' },
  SC: { shape: 'square', bg: '#ffffff', fg: '#1e4b8f' },
};

/**
 * The design name for a state, or the generic rounded rectangle.
 *
 * A state with no entry, or one marked unconfident, gets the fallback rather
 * than a guess.
 */
export function stateDesign(code = '') {
  const key = String(code).trim().toUpperCase();
  return STATE_SHIELDS[key] ? `st-${key}` : 'state';
}

/** Every state currently drawn with its own marker, for tests and for docs. */
export function statesWithShields() {
  return Object.keys(STATE_SHIELDS).sort();
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

/* ---- shape primitives, all normalised to the box (w × h) ---- */

function diamondPath(ctx, w, h) {
  ctx.beginPath();
  ctx.moveTo(w / 2, 1);
  ctx.lineTo(w - 1, h / 2);
  ctx.lineTo(w / 2, h - 1);
  ctx.lineTo(1, h / 2);
  ctx.closePath();
}

function circlePath(ctx, w, h) {
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2 - 1, h / 2 - 1, 0, 0, Math.PI * 2);
  ctx.closePath();
}

/** California's miner's spade: square shoulders tapering to a rounded point. */
function spadePath(ctx, w, h) {
  ctx.beginPath();
  ctx.moveTo(w / 2, 1);
  ctx.bezierCurveTo(w * 0.62, h * 0.16, w - 1, h * 0.3, w - 1, h * 0.52);
  ctx.bezierCurveTo(w - 1, h * 0.82, w * 0.72, h - 1, w / 2, h - 1);
  ctx.bezierCurveTo(w * 0.28, h - 1, 1, h * 0.82, 1, h * 0.52);
  ctx.bezierCurveTo(1, h * 0.3, w * 0.38, h * 0.16, w / 2, 1);
  ctx.closePath();
}

/** Pennsylvania's keystone: narrow at the top, splayed shoulders, flat foot. */
function keystonePath(ctx, w, h) {
  ctx.beginPath();
  ctx.moveTo(w * 0.28, 1);
  ctx.lineTo(w * 0.72, 1);
  ctx.lineTo(w - 1, h * 0.3);
  ctx.lineTo(w * 0.86, h - 1);
  ctx.lineTo(w * 0.14, h - 1);
  ctx.lineTo(1, h * 0.3);
  ctx.closePath();
}

/** Utah's beehive: a dome on a plinth. */
function beehivePath(ctx, w, h) {
  ctx.beginPath();
  ctx.moveTo(1, h - 1);
  ctx.lineTo(1, h * 0.72);
  ctx.bezierCurveTo(w * 0.06, h * 0.24, w * 0.32, 1, w / 2, 1);
  ctx.bezierCurveTo(w * 0.68, 1, w * 0.94, h * 0.24, w - 1, h * 0.72);
  ctx.lineTo(w - 1, h - 1);
  ctx.closePath();
}

/** The stacked courses that make a dome read as a hive rather than an arch. */
function beehiveDecoration(ctx, w, h, colour) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 0.9;
  for (const y of [h * 0.34, h * 0.56, h * 0.78]) {
    ctx.beginPath();
    ctx.moveTo(w * 0.14, y);
    ctx.lineTo(w * 0.86, y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A simplified state outline.
 *
 * Deliberately generic: an irregular blob that reads as "the shape of a state"
 * rather than any particular one. At this size a traced boundary and this are
 * indistinguishable, and one shape serves every outline state.
 */
function outlinePath(ctx, w, h) {
  ctx.beginPath();
  ctx.moveTo(w * 0.06, h * 0.22);
  ctx.lineTo(w * 0.44, h * 0.1);
  ctx.lineTo(w * 0.72, h * 0.16);
  ctx.lineTo(w * 0.95, h * 0.34);
  ctx.lineTo(w * 0.88, h * 0.7);
  ctx.lineTo(w * 0.6, h * 0.92);
  ctx.lineTo(w * 0.24, h * 0.86);
  ctx.lineTo(w * 0.04, h * 0.56);
  ctx.closePath();
}

/** Kansas's sunflower: a disc with a ring of short petals. */
function sunflowerDecoration(ctx, w, h, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 1.5;
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 1.3, 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** New Mexico's Zia: a circle with four groups of rays. */
function ziaDecoration(ctx, w, h, colour) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  const cx = w / 2;
  const cy = h / 2;
  // Pushed out to the rim: the number sits in the middle, and rays crossing it
  // made both unreadable.
  const inner = Math.min(w, h) * 0.36;
  const outer = Math.min(w, h) * 0.5;
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (const offset of [-0.2, 0, 0.2]) {
      const a = angle + offset;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Colorado's flag: blue bands top and bottom with a red C. */
function coloradoDecoration(ctx, w, h) {
  ctx.save();
  ctx.fillStyle = '#1e4b8f';
  ctx.fillRect(1, 1, w - 2, h * 0.14);
  ctx.fillRect(1, h * 0.86, w - 2, h * 0.13);

  // The C rings the number rather than crossing it — on the real marker the
  // route number sits inside the C, and drawing it small put the two on top of
  // each other.
  ctx.strokeStyle = '#b0202f';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.42, Math.PI * 0.32, Math.PI * 1.68);
  ctx.stroke();
  ctx.restore();
}

const SHAPE_PATHS = {
  diamond: diamondPath,
  circle: circlePath,
  spade: spadePath,
  keystone: keystonePath,
  beehive: beehivePath,
  outline: outlinePath,
  sunflower: circlePath,
  zia: circlePath,
  'flag-co': (ctx, w, h) => roundedRect(ctx, 1, 1, w - 2, h - 2, 2),
  square: (ctx, w, h) => roundedRect(ctx, 1, 1.5, w - 2, h - 3, 1.5),
  shield: (ctx, w, h) => usRoutePath(ctx, w, h),
};

/** The shapes the renderer can draw, so the table cannot name one it cannot. */
export const SHAPE_NAMES = Object.keys(SHAPE_PATHS);

const SHAPE_DECORATIONS = {
  beehive: (ctx, w, h, entry) => beehiveDecoration(ctx, w, h, entry.fg),
  sunflower: (ctx, w, h, entry) => sunflowerDecoration(ctx, w, h, entry.fg),
  zia: (ctx, w, h, entry) => ziaDecoration(ctx, w, h, entry.fg),
  'flag-co': (ctx, w, h) => coloradoDecoration(ctx, w, h),
};

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

  ctx.lineJoin = 'round';

  // A per-state design: `st-CA` and the like.
  if (design.startsWith('st-')) {
    const entry = STATE_SHIELDS[design.slice(3)];
    if (!entry) return null;

    const path = SHAPE_PATHS[entry.shape] || SHAPE_PATHS.square;
    path(ctx, width, HEIGHT);
    ctx.fillStyle = entry.bg;
    ctx.fill();
    ctx.strokeStyle = entry.bg === '#ffffff' ? '#2b2b2b' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.3;
    ctx.stroke();

    SHAPE_DECORATIONS[entry.shape]?.(ctx, width, HEIGHT, entry);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  const colours = COLOURS[design] || COLOURS.default;

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
 * Rebuild one shield from its image id.
 *
 * The counterpart to the style naming images it expects to exist. Ids look like
 * `abmap-shield-us-3` or `abmap-shield-st-CA-2`, so the split is on the last
 * dash — the design itself contains one.
 *
 * @returns {ImageData|null}
 */
export function rasterizeShieldById(id, options = {}) {
  const prefix = 'abmap-shield-';
  if (!String(id).startsWith(prefix)) return null;

  const rest = id.slice(prefix.length);
  const split = rest.lastIndexOf('-');
  if (split < 1) return null;

  const design = rest.slice(0, split);
  const length = Number(rest.slice(split + 1));
  if (!Number.isFinite(length)) return null;

  return rasterizeShield(design, length, options);
}

/**
 * Register every shield image with a map.
 *
 * Idempotent, and safe to call after each style load — a style swap discards
 * registered images, so this has to run again on the other side of one.
 */
export function registerShieldImages(map, { pixelRatio = 2, state = '' } = {}) {
  let added = 0;

  // The four base designs, plus the current state's if it has one. Registering
  // only the state you are looking at keeps this to fifteen small images rather
  // than a hundred and fifty, and the state is re-registered as you cross a
  // border — which costs three canvas draws.
  const designs = [...SHIELD_DESIGNS];
  const forState = stateDesign(state);
  if (forState !== 'state') designs.push(forState);

  for (const design of designs) {
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
export function shieldImageExpression(state = '') {
  // Interstates and US routes look the same in every state, so only the state
  // branch varies. Which state that is comes from where the map is looking
  // rather than from the road's own tags — the road data does not reliably
  // carry it, and a marker matching the state you are panning through is right
  // everywhere except within a few miles of a border.
  const local = stateDesign(state);

  return [
    'concat',
    'abmap-shield-',
    [
      'match', ['get', 'shield'],
      ['us-interstate', 'us-interstate-business', 'us-interstate-duplex', 'us-interstate-truck'], 'interstate',
      ['us-highway', 'us-highway-business', 'us-highway-duplex', 'us-highway-truck', 'us-highway-alternate'], 'us',
      ['us-state', 'us-state-duplex'], local,
      local,
    ],
    '-',
    ['to-string', ['max', MIN_LEN, ['min', MAX_LEN, ['coalesce', ['get', 'reflen'], MIN_LEN]]]],
  ];
}

/**
 * The number colour, which has to follow whatever the shield is drawn in.
 *
 * A dark-on-dark number is invisible, and several state markers are dark:
 * Arizona's black square, Idaho's black outline, South Carolina's blue disc.
 */
export function shieldTextColour(state = '') {
  const entry = STATE_SHIELDS[String(state).trim().toUpperCase()];
  const localText = entry ? entry.fg : '#1c1c1c';

  return [
    'match', ['get', 'shield'],
    ['us-interstate', 'us-interstate-business', 'us-interstate-duplex', 'us-interstate-truck'], '#ffffff',
    ['us-state', 'us-state-duplex'], localText,
    localText,
  ];
}

/** The base-design colours, kept for callers that have no state in hand. */
export const SHIELD_TEXT_COLOUR = shieldTextColour('');
