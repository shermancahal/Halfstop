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
import { SHIELD_BOXES, SHIELD_IMAGES } from './shield-boxes.js';

const MIN_LEN = 2;
const MAX_LEN = 4;

/*
 * `circle` is what a numbered road gets when nothing says whose number it is.
 *
 * Probing Michigan settled this. Two miles apart in Leelanau County:
 *
 *   M-22          ref=22   shield=circle-white  shield_image=us-state-diamond-2
 *   county road   ref=641  shield=default       shield_image=default-3
 *
 * A signed state route carries a shape; a county road carries `default`. So
 * the two are told apart by the data, and `default` can stop borrowing the
 * state's own marker — which is how Michigan's county roads came to be drawn
 * on the M diamond that belongs to its state routes.
 */
export const SHIELD_DESIGNS = ['interstate', 'us', 'state', 'circle', 'default', 'scenic', 'forest'];

/*
 * Two designs chosen by the road's number rather than by Mapbox's `shield`.
 *
 * Every other design here is picked from what the tiles say a road is. These
 * two cannot be: Mapbox has no idea a route is scenic, and a forest road
 * arrives as an unclaimed number like any county road. Both are legible in the
 * ref itself - "US 40 Scenic", "FSR 300" - so that is what selects them.
 *
 * `scenic` is knowingly an approximation. The real scenic byway marker is not
 * a brown US shield; it is a separate sign entirely. But the brown reads as
 * "scenic" instantly to anyone who has driven in America, and a recognisable
 * approximation beats a correct sign nobody recognises at twenty pixels.
 *
 * `forest` is the USFS route marker, which is its own trapezoid and genuinely
 * distinctive - the shape is half of why FSR 300 stopped being readable as a
 * generic circle.
 */
export const REF_DESIGNS = ['scenic', 'forest'];

/**
 * Where the real shield blanks live, and how a design maps onto one.
 *
 * Forty-five states are drawn from the actual sign blanks rather than
 * approximated on a canvas — Alaska's Big Dipper, Kansas's sunflower,
 * Nebraska's wagon, the Zia on New Mexico. Nothing hand-drawn at twenty pixels
 * was ever going to be those, and the drawn versions stay only as the fallback
 * for the states with no blank and for the two national shields, which are not
 * in the set.
 */
const SHIELD_IMAGE_ROOT = 'assets/shields';

/**
 * The blank for a design, if there is one.
 *
 * Keys are the state code for `st-XX` and the design name itself for the two
 * national shields — every interstate marker in the country is the same marker,
 * so it needs no state. Three characters or more wants the wide blank where one
 * exists; a state with no blank at all returns null and gets drawn instead.
 */
export function shieldBlankFor(design, length) {
  const code = design.startsWith('st-') ? design.slice(3) : design;
  const available = SHIELD_IMAGES[code];
  if (!available) return null;

  const variant = length >= 3 && available.includes('wide') ? 'wide' : 'narrow';
  return { code, variant, url: `${SHIELD_IMAGE_ROOT}/${code}-${variant}.png`, key: `${code}-${variant}` };
}

/** Whether this design is drawn from a blank rather than on a canvas. */
export const hasShieldBlank = (design, length) => !!shieldBlankFor(design, length);

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
  // Anything else is a numbered road nobody has claimed — see SHIELD_DESIGNS.
  return 'circle';
}

export function shieldImageId(design, length) {
  const clamped = Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round(length) || MIN_LEN));
  return `abmap-shield-${design}-${clamped}`;
}

/**
 * The designs in play when looking at a given state.
 *
 * The four base designs plus that state's own marker, if it has one.
 * Registering only the state on screen keeps this to fifteen small images
 * rather than a hundred and fifty, and re-registering at a border costs three
 * canvas draws.
 *
 * Shared, because the registrar and the enumeration of what it registers each
 * had their own copy of this list and the copies disagreed — the enumeration
 * left out the state marker, so every check written against it was blind to
 * precisely the shields the feature exists for.
 */
export function shieldDesignsFor(state = '') {
  const designs = [...SHIELD_DESIGNS];
  const forState = stateDesign(state);
  if (forState !== 'state') designs.push(forState);
  return designs;
}

/**
 * Every image id that would be registered for a given state.
 *
 * Takes the same options as `registerShieldImages` and enumerates the same
 * set, because it exists to be checked against it. It used to ignore its
 * argument and return only the four base designs, which made it silently wrong
 * about exactly the case that matters — a state with a marker of its own.
 */
export function shieldImageIds({ state = '' } = {}) {
  const ids = [];
  for (const design of shieldDesignsFor(state)) {
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
/*
 * bg and fg describe the real sign, not a stylised idea of it.
 *
 * Six of these declared white numerals on a dark field - Michigan and North
 * Carolina as dark diamonds, Vermont and South Dakota green, South Carolina
 * blue, Nevada black. That was a reasonable sketch of each state's marker and
 * it stopped being true the moment the real blanks arrived: every one of those
 * blanks puts the number in a white field, so white numerals rendered white on
 * white and the shield came up empty. The reported symptom was a generic
 * circle flashing with its number and then the state shield appearing without
 * one - which is exactly this, the base design drawing first and the blank
 * replacing it.
 *
 * Measured rather than judged: `shields: the number is legible on its own
 * blank` decodes each PNG and reads the luminance of the box the text is
 * actually drawn in, so a blank that gets redrawn darker fails the test rather
 * than quietly swallowing its number.
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
  /*
   * Texas is the one drawn design that carries lettering.
   *
   * Its marker is a white square inside a heavy black border with TEXAS across
   * the foot, and without the word it is indistinguishable from the dozen other
   * plain white squares. The lettering also moves the number: it sits in the
   * upper two thirds rather than in the middle, the same way it does on the
   * blanks whose states put their name across the top.
   *
   * Texas also signs Farm to Market, Loop and Spur routes with markers of their
   * own, and those cannot be drawn from this data: Mapbox tags all of them
   * `us-state`, with the number and nothing to say which family it belongs to.
   */
  TX: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c', name: 'TEXAS', heavy: true },
  WV: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  WI: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  WA: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },

  /* Circles */
  DE: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  IA: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  // White with black numerals, like the other five circle states. It was drawn
  // the other way round — black disc, white numerals — which is not the sign.
  KY: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  MS: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  NJ: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },
  VA: { shape: 'circle', bg: '#ffffff', fg: '#1c1c1c' },

  /* Diamonds */
  MI: { shape: 'diamond', bg: '#ffffff', fg: '#1c1c1c' },
  NC: { shape: 'diamond', bg: '#ffffff', fg: '#1c1c1c' },

  /* State outlines — simplified; at this size the silhouette is all that reads */
  AK: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  AR: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  DC: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  FL: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  MO: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  NH: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  ND: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  OK: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  ID: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  LA: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },
  SD: { shape: 'outline', bg: '#ffffff', fg: '#1c1c1c' },

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
  VT: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
  SC: { shape: 'square', bg: '#ffffff', fg: '#1c1c1c' },
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
  // The generic county-and-unclassified marker: a plain white circle, which is
  // what an unsigned numbered road looks like on most state maps and is
  // deliberately not any state's own shape.
  circle: { fill: '#ffffff', stroke: '#3d3225', text: '#1c1c1c' },
  default: { fill: '#fbf7ee', stroke: '#64513b', text: '#3a3026' },
  // The brown of a recreation sign, which is the whole point of both.
  scenic: { fill: '#5f3a22', stroke: '#ffffff', text: '#ffffff' },
  forest: { fill: '#5f3a22', stroke: '#ffffff', text: '#ffffff' },
};

/**
 * How much bigger than the drawn baseline every marker sits on screen.
 *
 * One constant, because the marker's size is not one number: the drawn shields
 * are canvassed at a CSS size, the blanks are PNGs of a fixed pixel size scaled
 * by the ratio they are registered at, and the number on top is sized and
 * offset from measurements taken in the blank's own pixels. Growing any one of
 * those alone moves the number off the shield.
 */
export const SHIELD_SCALE = 1.2;

/**
 * The ratio the blanks are registered at.
 *
 * They are 44x40 device pixels, so at 2 they land 22x20 CSS pixels — the drawn
 * shields' baseline size. Dividing by the scale is what makes the same PNG draw
 * bigger, and it is also the number that converts a SHIELD_BOXES measurement
 * into CSS pixels, which is why both come from here rather than from a literal.
 */
export const BLANK_PIXEL_RATIO = 2 / SHIELD_SCALE;

const HEIGHT = 20 * SHIELD_SCALE;

function shieldWidth(length) {
  return ({ 2: 22, 3: 27, 4: 33 }[length] || 22) * SHIELD_SCALE;
}

/**
 * How wide a shield sits on screen, in CSS pixels.
 *
 * The drawn shields are canvassed at this width and the blanks are added at
 * pixelRatio 2 from a 44px image, so both land at the same size. Callers need
 * it to place two shields side by side without them touching.
 */
export function shieldDisplayWidth(length) {
  return shieldWidth(Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round(length) || MIN_LEN)));
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

/*
 * The two national shields.
 *
 * Both are anchored to the edges in pixels rather than in fractions of the
 * width, and the reason is the widths: a two-digit shield is 22px across and a
 * four-digit one is 33px, at the same height. Scaling the curves by width made
 * a wide shield a stretched version of a narrow one — the corners flattened out
 * and the foot spread until it read as a bowl. Real shields widen by extending
 * the straight middle and leave the corners and the taper alone, which is what
 * anchoring in pixels does.
 */

/**
 * The interstate shield: a flat top with rounded corners, straight sides down
 * to the shoulder, then a long sweep in to a rounded point at the foot.
 *
 * The first version was a symmetric lens, round on top as well as underneath.
 * That is not a shield — with a red bar across it, it read as a blue pill.
 */
function interstatePath(ctx, w, h) {
  const left = 1.2;
  const right = w - 1.2;
  const top = h * 0.07;
  const shoulder = h * 0.34;
  const radius = 3;
  const centre = w / 2;

  ctx.beginPath();
  ctx.moveTo(left + radius, top);
  ctx.lineTo(right - radius, top);
  ctx.quadraticCurveTo(right, top, right, top + radius);
  ctx.lineTo(right, shoulder);
  // Down the right and in to the point. The controls stay a fixed distance in
  // from the edge so the taper keeps its angle at any width.
  ctx.bezierCurveTo(right, h * 0.70, right - (right - centre) * 0.52, h * 0.90, centre + (right - centre) * 0.26, h * 0.965);
  ctx.quadraticCurveTo(centre, h * 1.0, centre - (centre - left) * 0.26, h * 0.965);
  ctx.bezierCurveTo(left + (centre - left) * 0.52, h * 0.90, left, h * 0.70, left, shoulder);
  ctx.lineTo(left, top + radius);
  ctx.quadraticCurveTo(left, top, left + radius, top);
  ctx.closePath();
}

/**
 * The US route shield: two peaks at the top corners with a shallow dip between
 * them, straight sides, and a rounded foot.
 *
 * The peaks are the identifying feature and were missing entirely — the old
 * path ran a straight line across the top, which is a plain box that could be
 * any state's marker. They are small and the dip between them is shallow;
 * drawn deep, the shield reads as a heart.
 */
function usRoutePath(ctx, w, h) {
  const left = 1.1;
  const right = w - 1.1;
  const centre = w / 2;

  /*
   * The peaks have to be big enough to survive being drawn 20 pixels tall.
   *
   * A first pass put them where they sit on the real sign — a dip about a
   * fifteenth of the height below the crest — and at this size the outline
   * stroke simply filled the gap in. What reads as two peaks on a road sign
   * two feet across reads as a wobbly top edge on an icon, so the dip is
   * exaggerated to about a fifth of the height. That is the difference between
   * a marker you recognise at a glance and a rounded box.
   */
  const apexY = h * 0.015;
  const dip = h * 0.18;
  const inset = Math.min(w * 0.34, 9);

  ctx.beginPath();
  ctx.moveTo(centre, dip);
  // One cubic per hump, not two quadratics meeting at the apex: two of them
  // join at a corner, and a corner at the top of a small shape is a cat's ear.
  ctx.bezierCurveTo(centre - inset * 0.40, apexY, left + inset * 0.34, apexY, left, h * 0.31);
  ctx.lineTo(left, h * 0.48);
  // The foot narrows to about a third of the width before it rounds off.
  // Running the side straight down and then turning hard gave a flat-bottomed
  // tub; converging first is what makes it read as a shield.
  ctx.bezierCurveTo(left, h * 0.74, left + (centre - left) * 0.40, h * 0.91, centre - (centre - left) * 0.30, h * 0.97);
  ctx.quadraticCurveTo(centre, h * 1.005, centre + (right - centre) * 0.30, h * 0.97);
  ctx.bezierCurveTo(right - (right - centre) * 0.40, h * 0.91, right, h * 0.74, right, h * 0.48);
  ctx.lineTo(right, h * 0.31);
  ctx.bezierCurveTo(right - inset * 0.34, apexY, centre + inset * 0.40, apexY, centre, dip);
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

/**
 * The USFS route marker: a trapezoid, wider at the top than the bottom.
 *
 * Drawn rather than blanked because there is no blank for it, and it is worth
 * drawing: the real sign carries "National Forest" across its foot in script,
 * which is unreadable at this size, so the shape has to do that work alone.
 * A trapezoid does - nothing else on the map is one.
 */
function forestPath(ctx, w, h) {
  const inset = 1;
  const shoulder = w * 0.11;
  const radius = 2;
  ctx.beginPath();
  ctx.moveTo(inset + radius, inset);
  ctx.lineTo(w - inset - radius, inset);
  ctx.quadraticCurveTo(w - inset, inset, w - inset - radius * 0.4, inset + radius);
  ctx.lineTo(w - inset - shoulder, h - inset - radius);
  ctx.quadraticCurveTo(w - inset - shoulder, h - inset, w - inset - shoulder - radius, h - inset);
  ctx.lineTo(inset + shoulder + radius, h - inset);
  ctx.quadraticCurveTo(inset + shoulder, h - inset, inset + shoulder, h - inset - radius);
  ctx.lineTo(inset + radius * 0.4, inset + radius);
  ctx.quadraticCurveTo(inset, inset, inset + radius, inset);
  ctx.closePath();
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
  forest: forestPath,
};

/** The shapes the renderer can draw, so the table cannot name one it cannot. */
export const SHAPE_NAMES = Object.keys(SHAPE_PATHS);

/**
 * A state's name across the foot of its marker.
 *
 * Small, because it is small on the sign: the word identifies the marker and
 * the number is what anyone actually reads. `NAME_BAND` is how much of the
 * height it claims, and `shieldTextOffset` lifts the number by the same amount
 * so the two never overlap.
 */
const NAME_BAND = 0.3;

function nameDecoration(ctx, w, h, entry) {
  ctx.save();
  ctx.fillStyle = entry.fg;
  ctx.font = `600 ${(h * 0.185).toFixed(2)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // Inside the field rather than on the border it sits above: the square is
  // drawn to h - 1.5 with a heavy stroke straddling that edge, so a baseline
  // any lower puts the lettering into the frame.
  ctx.fillText(entry.name, w / 2, h - h * 0.175, w - 7);
  ctx.restore();
}

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

  /*
   * Always draws, even for a design that has a real blank.
   *
   * Preferring the blank is `registerShieldImages`' decision, not this
   * function's: an early return here left nothing to fall back to when a PNG
   * failed to load, which is the one case the drawing exists for.
   */
  if (design.startsWith('st-')) {
    const entry = STATE_SHIELDS[design.slice(3)];
    if (!entry) return null;

    const path = SHAPE_PATHS[entry.shape] || SHAPE_PATHS.square;
    path(ctx, width, HEIGHT);
    ctx.fillStyle = entry.bg;
    ctx.fill();
    ctx.strokeStyle = entry.bg === '#ffffff' ? '#2b2b2b' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = entry.heavy ? 2.4 : 1.3;
    ctx.stroke();

    SHAPE_DECORATIONS[entry.shape]?.(ctx, width, HEIGHT, entry);
    if (entry.name) nameDecoration(ctx, width, HEIGHT, entry);
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
    ctx.fillRect(0, 0, width, HEIGHT * 0.27);
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
    // Thinner than the others on purpose: this shape is nearly all outline, and
    // a heavy one closes the notch between the peaks back up.
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (design === 'scenic') {
    // The US shield outline in brown: same shape, so a scenic route still
    // reads as the route it is, and the colour says what kind.
    usRoutePath(ctx, width, HEIGHT);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.strokeStyle = colours.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (design === 'forest') {
    forestPath(ctx, width, HEIGHT);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.strokeStyle = colours.stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else if (design === 'circle') {
    // Round, and drawn to the shield's height rather than its width, so a
    // three-character number widens the box without turning the circle into an
    // ellipse that reads as a different sign.
    ctx.beginPath();
    ctx.ellipse(width / 2, HEIGHT / 2, Math.min(width / 2, HEIGHT / 2) - 1, HEIGHT / 2 - 1, 0, 0, Math.PI * 2);
    ctx.closePath();
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
 * Where the route number sits on a shield, in ems, and how big it can be.
 *
 * Both are per-shield rather than global because the blanks are not
 * interchangeable: a third of them carry the state's name across the top, so a
 * number centred in the image lands on the lettering. The measurements come
 * from tools/build-shields.mjs, which finds the largest clear rectangle in each
 * blank's own field colour.
 *
 * Offsets are in ems of the text size, which is how `text-offset` is specified;
 * the box is measured in device pixels of a 40px-tall icon, so a pixel is half
 * a CSS pixel and an em is NOMINAL_TEXT of them.
 */
const NOMINAL_TEXT = 11 * SHIELD_SCALE;

/**
 * The smallest the number is allowed to get, whatever the shield.
 *
 * A few markers have less clear space than this needs — Alaska's Big Dipper
 * leaves a 12-pixel band — and there the number is allowed to overrun its
 * rectangle slightly. That is the right way round: a number half a pixel over
 * its box is still read at a glance, and one shrunk to fit is not read at all.
 */
export const MIN_TEXT = 6.5 * SHIELD_SCALE;

function boxFor(design, length) {
  const blank = shieldBlankFor(design, length);
  return blank ? SHIELD_BOXES[blank.key] : null;
}

/** Text size that fits the clear space, in CSS pixels. */
/** The drawn design behind `st-XX`, or null for the two national shields. */
function drawnState(design) {
  return design.startsWith('st-') ? STATE_SHIELDS[design.slice(3)] || null : null;
}

export function shieldTextSize(design, length) {
  const box = boxFor(design, length);
  /*
   * A drawn marker, which until now was the same size whatever the number was.
   *
   * "and the same amount whatever the number is" was true of the *name* across
   * the top, not of the number under it: four characters at two-character size
   * run outside a drawn circle exactly as they do outside a blank one. It
   * narrows on the same terms as the measured branch below, from the same
   * nominal size at two characters.
   */
  if (!box) {
    const room = drawnState(design)?.name ? NOMINAL_TEXT * 0.82 : NOMINAL_TEXT;
    // Never larger than it was: two characters keep the size they have always
    // had, and only the numbers that did not fit are made to fit.
    return Math.max(MIN_TEXT, room * Math.min(1, 2.35 / Math.max(2, length)));
  }
  // Two digits across the box width, and most of its height. The box is
  // measured in the blank's own pixels, so it converts by the ratio the blank
  // is registered at — not by a literal 2, which is what it was when that
  // ratio could not change.
  const byHeight = (box.h / BLANK_PIXEL_RATIO) * 0.82;
  const byWidth = (box.w / BLANK_PIXEL_RATIO) / Math.max(2, length) * 1.55;
  return Math.max(MIN_TEXT, Math.min(NOMINAL_TEXT, byHeight, byWidth));
}

/** Offset from the icon's centre to the middle of the clear space, in ems. */
export function shieldTextOffset(design, length) {
  const box = boxFor(design, length);
  if (!box) {
    const drawn = drawnState(design);
    if (!drawn?.name) return [0, 0];
    // Up by half the band, in ems of the size chosen just above.
    const size = shieldTextSize(design, length);
    return [0, Math.round((-(HEIGHT * NAME_BAND) / 2 / size) * 100) / 100];
  }
  const size = shieldTextSize(design, length);
  const round = (value) => Math.round(value * 100) / 100;
  return [round((box.dx / BLANK_PIXEL_RATIO) / size), round((box.dy / BLANK_PIXEL_RATIO) / size)];
}

/**
 * The per-shield text size and offset as style expressions.
 *
 * Same shape as `shieldImageExpression`: three arms keyed on the road's own
 * `shield` field, with the state arm resolved for wherever the map is looking.
 * The nationals are drawn rather than loaded from a blank, so their numbers sit
 * where those drawings put them — the interstate's below its red crown.
 */
export function shieldTextSizeExpression(state = '', length = 2, refLength = null) {
  /*
   * Sized from the number the road actually carries, when the caller can say.
   *
   * Every layer used to pass the default of two, so a four or five character
   * number was drawn at two-character size and ran outside the blank — which
   * is exactly what a West Virginia secondary route looks like: "21/2" is four
   * characters in a circle sized for "21". `shieldTextSize` already shrinks
   * with length; nothing was ever telling it the length.
   *
   * A `case` per width rather than one size for all, because the widths are
   * measured per blank and a two-digit number should not be shrunk to fit the
   * worst case that might land on the same design.
   */
  const sized = (design) => {
    const at = (chars) => (design === LOCAL ? shieldTextSize(stateDesign(state), chars) : NOMINAL_TEXT);
    if (!refLength) return at(length);
    return ['case',
      ['>=', refLength, 5], at(5),
      ['>=', refLength, 4], at(4),
      ['>=', refLength, 3], at(3),
      at(2)];
  };

  return [
    'match', ['get', 'shield'],
    ...SHIELD_MATCH.flatMap((arm) => [arm.values, sized(arm.design)]),
    sized(UNCLAIMED),
  ];
}

/**
 * @param shiftPx how far sideways to move the number, in CSS pixels. Text
 *        offsets are in ems, and the em is a different size on every design,
 *        so the conversion has to happen per arm rather than once.
 */
export function shieldTextOffsetExpression(state = '', length = 2, shiftPx = 0, { override = null } = {}) {
  const local = shieldTextOffset(stateDesign(state), length);
  // The interstate number clears its crown; the US shield's sits centre.
  const national = (design) => (design === 'interstate' ? [0, 0.18] : [0, 0.06]);
  const shift = (base, design) => {
    if (!shiftPx) return base;
    const size = design === LOCAL ? shieldTextSize(stateDesign(state), length) : NOMINAL_TEXT;
    return [Math.round((base[0] + shiftPx / size) * 100) / 100, base[1]];
  };
  const byShield = [
    'match', ['get', 'shield'],
    ...SHIELD_MATCH.flatMap((arm) => [
      arm.values,
      ['literal', shift(arm.design === LOCAL ? local : national(arm.design), arm.design)],
    ]),
    ['literal', shift(shieldTextOffset(UNCLAIMED, length), UNCLAIMED)],
  ];
  if (!override) return byShield;

  /*
   * Both brown designs are drawn rather than blanked, so their numbers sit
   * where the drawings put them. The scenic shield is the US outline and takes
   * its offset; the forest trapezoid is narrower at the foot than the head, so
   * its number rides slightly high to stay off the taper.
   */
  return ['let', 'chosen', override,
    ['case',
      ['==', ['var', 'chosen'], 'forest'], ['literal', shift([0, -0.04], 'forest')],
      ['==', ['var', 'chosen'], 'scenic'], ['literal', shift(national('us'), 'us')],
      byShield]];
}

/**
 * Load a shield blank and hand it to the map.
 *
 * Asynchronous, which is why it is separate from `rasterizeShield`: that draws
 * on a canvas and returns immediately, and this has to wait for a PNG. GL asks
 * for an image it does not have by firing `styleimagemissing` and re-renders
 * once one is added, so arriving late is fine — a shield appears a frame or two
 * after the road it belongs to.
 *
 * @param base URL prefix for the shield directory, so a page served from a
 *        subpath resolves it the same way it resolves the rest of its assets.
 * @returns {Promise<boolean>} whether an image was added.
 */
export async function loadShieldBlank(map, id, { base = '', pixelRatio = BLANK_PIXEL_RATIO } = {}) {
  const parsed = parseShieldId(id);
  if (!parsed) return false;

  const blank = shieldBlankFor(parsed.design, parsed.length);
  if (!blank) return false;
  if (map.hasImage?.(id)) return true;

  try {
    const response = await fetch(`${base}${blank.url}`);
    if (!response.ok) return false;
    const bitmap = await createImageBitmap(await response.blob());
    // A style swap between the request and its answer would make this an
    // orphan; GL throws on a duplicate id, so check again on arrival.
    if (map.hasImage?.(id)) return true;
    map.addImage(id, bitmap, { pixelRatio });
    return true;
  } catch {
    // The drawn fallback covers this: a missing blank is a plainer shield, not
    // a missing one.
    return false;
  }
}

/** Split `abmap-shield-st-CA-2` into its design and length. */
export function parseShieldId(id) {
  const prefix = 'abmap-shield-';
  if (!String(id).startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const cut = rest.lastIndexOf('-');
  if (cut < 0) return null;
  const length = Number(rest.slice(cut + 1));
  if (!Number.isFinite(length)) return null;
  return { design: rest.slice(0, cut), length };
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
/**
 * @param pixelRatio the resolution to *draw* at. It does not change how big a
 *        shield is — that is SHIELD_SCALE — only how sharp a drawn one looks.
 */
export function registerShieldImages(map, { pixelRatio = 2, state = '', base = '' } = {}) {
  let added = 0;
  const trouble = [];

  for (const design of shieldDesignsFor(state)) {
    for (let length = MIN_LEN; length <= MAX_LEN; length += 1) {
      const id = shieldImageId(design, length);
      if (map.hasImage && map.hasImage(id)) continue;

      /*
       * A design with a real sign blank gets the blank, which arrives over the
       * network and therefore later. Drawing one now as a placeholder would
       * take the id and stop the real one ever being registered — GL will not
       * replace an image that is already there — so this leaves the slot empty
       * and lets the load fill it. The drawing stays as the answer if it never
       * arrives.
       */
      if (shieldBlankFor(design, length)) {
        /*
         * The blank goes in at BLANK_PIXEL_RATIO, not at `pixelRatio`.
         *
         * They are different jobs wearing the same name. For a drawing,
         * pixelRatio is resolution — the canvas grows with it and the shield
         * stays the same size, only sharper. For a fixed-size PNG it is the
         * size itself. Passing the drawing's ratio to the loader is what would
         * leave the blanks at the old size while everything drawn grew.
         */
        loadShieldBlank(map, id, { base, pixelRatio: BLANK_PIXEL_RATIO }).then((loaded) => {
          if (loaded || map.hasImage?.(id)) return;
          const drawn = rasterizeShield(design, length, { pixelRatio });
          if (drawn) { try { map.addImage(id, drawn, { pixelRatio }); } catch { /* raced */ } }
        }).catch((error) => { trouble.push(`${id}: ${error.message}`); });
        continue;
      }

      const data = rasterizeShield(design, length, { pixelRatio });
      if (!data) { trouble.push(`${id}: nothing was drawn for it`); continue; }
      try {
        map.addImage(id, data, { pixelRatio });
        added += 1;
      } catch (error) {
        /*
         * This used to be `catch {}` with a comment saying neither case was
         * fatal. One of them was: `addImage` on a style that has not loaded
         * throws, and swallowing it meant a whole state's markers were absent
         * with nothing anywhere to say so. The registrar was being called from
         * the geocoder callback, which lands before the style is up more often
         * than not.
         *
         * Racing a duplicate is still fine, and is what the `hasImage` check
         * distinguishes: if the image is there, somebody else added it.
         */
        if (!map.hasImage?.(id)) trouble.push(`${id}: ${error.message}`);
      }
    }
  }

  lastRegistration = { state: state || '(none)', added, trouble };
  if (trouble.length) {
    console.warn(`[shields] ${trouble.length} image(s) could not be registered: ${trouble.slice(0, 4).join('; ')}`);
  }
  return added;
}

/** What the last registration managed, for `abmapShields()` to report. */
let lastRegistration = { state: '(never run)', added: 0, trouble: [] };
export const shieldRegistrationReport = () => lastRegistration;

/**
 * The expression that picks a shield image for a road feature.
 *
 * Built from the feature's own `shield` and `reflen`, clamped to the widths we
 * actually generated so a seven-character route reference lands on the widest
 * image rather than on a name that does not exist.
 */
/*
 * The one table both the style expression and any code asking "which image
 * would this road get" are built from.
 *
 * Two hand-written copies of this mapping is how a diagnostic ends up
 * confidently reporting images as missing that were never asked for — it built
 * `abmap-shield-us-interstate-2` from the raw Mapbox field while the style
 * asked for `abmap-shield-interstate-2`. Generating both from one list makes
 * that particular disagreement impossible rather than merely unlikely.
 *
 * `LOCAL` stands in for "whatever design the state we are looking at uses",
 * which is resolved per-caller.
 */
const LOCAL = Symbol('local state design');

/*
 * The ref-based shield inference is out, for now.
 *
 * It read "US 40 Scenic" with shield "default" and drew a US marker, which is
 * right - and it was the only change in that commit touching the match input
 * of every shield expression, after which North Carolina lost its numbers,
 * Vermont and South Carolina went missing and Michigan flickered.
 *
 * None of that reproduces here. Every expression compiles, the sizes and
 * colours evaluate, and every image id the style asks for is registered for
 * all five states. So the fault is at runtime and this sandbox cannot see it.
 * Reverting the one broad change is the honest first bisect step rather than
 * defending it because the static checks pass - they passed before the report
 * too.
 *
 * The suffix rule stays: it only rewrites label text, and a table of eleven
 * refs covers it.
 */

const SHIELD_MATCH = [
  {
    design: 'interstate',
    values: ['us-interstate', 'us-interstate-business', 'us-interstate-duplex', 'us-interstate-truck'],
  },
  {
    design: 'us',
    values: ['us-highway', 'us-highway-business', 'us-highway-duplex', 'us-highway-truck', 'us-highway-alternate'],
  },
  /*
   * The state arm, and the shape names are not a guess.
   *
   * Mapbox Streets v8 documents `us-state`, and it is in this list, but asking
   * the Tilequery API what it puts on a real state route came back with
   * something else entirely:
   *
   *   class=tertiary type=tertiary ref=677 shield=circle-white reflen=3
   *
   * That is KY 677. Mapbox names the shield by its *shape*, not by who numbered
   * the road, and it picks the shape a state's real marker resembles —
   * Kentucky's is a white circle. So `us-state` may never appear at all, and
   * `circle-white`, `rectangle-white` and the rest are what actually arrives.
   *
   * The trailing fallback below already sent these to the state design, so this
   * list changes no behaviour. It is here because "works by falling off the end
   * of the table" and "works" are the same until someone tightens the fallback,
   * and the next person reading this should not have to re-run the probe to
   * learn that the documented value is not the live one.
   */
  {
    design: LOCAL,
    values: [
      'us-state', 'us-state-duplex',
      'circle-white', 'rectangle-white', 'rounded-square-white', 'square-white',
      'diamond-white', 'pentagon-white', 'hexagon-white', 'octagon-white',
      'triangle-white', 'trapezoid-white', 'shield-white',
    ],
  },
];

/**
 * The design a road with this `shield` value gets, from the map's state.
 *
 * The fallback is the circle, not the state's own marker. A shield value the
 * table does not list is a road nothing has told us about, and Mapbox says
 * `default` for exactly the roads a state has not signed — putting the state's
 * marker on those is how a Leelanau County road ended up wearing Michigan's M.
 */
export function designForShield(shield, state = '') {
  const local = stateDesign(state);
  const arm = SHIELD_MATCH.find((entry) => entry.values.includes(String(shield || '').toLowerCase()));
  const design = arm ? arm.design : UNCLAIMED;
  return design === LOCAL ? local : design;
}

/** What a road gets when nothing identifies its system. */
const UNCLAIMED = 'circle';

/** The image id a road would ask for — the same one the style expression builds. */
export function shieldImageIdFor(shield, reflen, state = '') {
  return shieldImageId(designForShield(shield, state), reflen);
}

export function shieldImageExpression(state = '', { length = null, override = null } = {}) {
  // Interstates and US routes look the same in every state, so only the state
  // branch varies. Which state that is comes from where the map is looking
  // rather than from the road's own tags — the road data does not reliably
  // carry it, and a marker matching the state you are panning through is right
  // everywhere except within a few miles of a border.
  const local = stateDesign(state);

  const byShield = [
    'match', ['get', 'shield'],
    ...SHIELD_MATCH.flatMap((arm) => [arm.values, arm.design === LOCAL ? local : arm.design]),
    // Not `local`: a shield value the table does not list is a road nothing
    // has claimed, and it gets the circle rather than the state's marker.
    UNCLAIMED,
  ];

  return [
    'concat',
    'abmap-shield-',
    /*
     * An override, when the number itself names the design.
     *
     * Scenic routes and forest roads are not distinguishable from the tiles -
     * Mapbox does not know a byway is scenic, and a forest road arrives
     * unclaimed like any county road - so the caller passes an expression that
     * reads the ref. It answers '' for everything else, and the ordinary
     * shield table decides those.
     */
    override ? ['let', 'chosen', override,
      ['case', ['!=', ['var', 'chosen'], ''], ['var', 'chosen'], byShield]] : byShield,
    '-',
    // `length` lets a caller size the image from something other than the
    // road's own `reflen` — a shield carrying half of a concurrency is as wide
    // as its own half, not as the pair.
    ['to-string', ['max', MIN_LEN, ['min', MAX_LEN, length || ['coalesce', ['get', 'reflen'], MIN_LEN]]]],
  ];
}

/**
 * The number colour, which has to follow whatever the shield is drawn in.
 *
 * A dark-on-dark number is invisible, and several state markers are dark:
 * Arizona's black square, Idaho's black outline, South Carolina's blue disc.
 */
export function shieldTextColour(state = '', { override = null } = {}) {
  const entry = STATE_SHIELDS[String(state).trim().toUpperCase()];
  const localText = entry ? entry.fg : '#1c1c1c';

  const byShield = [
    'match', ['get', 'shield'],
    ['us-interstate', 'us-interstate-business', 'us-interstate-duplex', 'us-interstate-truck'], '#ffffff',
    ['us-state', 'us-state-duplex'], localText,
    localText,
  ];

  // Both brown designs carry white numerals, and both are chosen by the same
  // override that chose the image - so the colour has to consult it or a
  // scenic shield gets its state's dark ink on brown.
  if (!override) return byShield;
  return ['let', 'chosen', override,
    ['case', ['!=', ['var', 'chosen'], ''], COLOURS.scenic.text, byShield]];
}

/** The base-design colours, kept for callers that have no state in hand. */
export const SHIELD_TEXT_COLOUR = shieldTextColour('');
