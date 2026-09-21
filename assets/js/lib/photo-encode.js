/**
 * Getting a phone photograph down to something worth keeping on a phone.
 *
 * WHY THIS EXISTS
 *
 * A picture off a modern phone is three to six megabytes of twelve-megapixel
 * JPEG. Stored as it arrives, twenty of them on one trip is a hundred
 * megabytes in IndexedDB, every thumbnail decodes the full frame to draw at
 * 80px, and the day these sync they are a hundred megabytes over whatever
 * signal a back road has. None of that buys anything: the photo is there to
 * remind somebody what the light was doing at this pin, and that survives the
 * shrink intact.
 *
 * THE TWO NUMBERS
 *
 * 1024 on the long edge, 100 KB in the file.
 *
 * 1024 is not arbitrary. The card these are shown on is about 340 CSS pixels
 * wide on a phone, and a phone is a 3x display, so a photo filling it wants
 * about 1020 device pixels. 1024 is the first round number above that: full
 * width on the screen it will actually be looked at on, and nothing spent
 * above it.
 *
 * 100 KB against a 1024x768 frame is a shade over one bit per pixel, which
 * WebP holds comfortably at ordinary quality and JPEG reaches at a slightly
 * lower one. Detail holds; what goes is the headroom for pixel-peeping that a
 * field note does not need.
 *
 * HOW IT GETS THERE
 *
 * Quality first, dimensions second, and that order matters. Dropping quality
 * costs fine texture; dropping dimensions costs everything at once. So the
 * search leans on quality as far as it reasonably can, and only steps the
 * frame down when the lowest quality worth shipping still misses - which
 * happens on frames that are genuinely busy, where the smaller frame is the
 * better-looking answer anyway.
 *
 * WHAT IS PURE AND WHAT IS NOT
 *
 * The two decisions - what size to aim for, and which quality to settle on -
 * are pure functions with the encoder injected, so they are tested in node
 * against a fake encoder. Only the part that actually needs a canvas touches
 * one. That split is the same one the rest of this project uses, and it is
 * what lets the interesting behaviour be checked without a browser.
 */

/** The long edge a stored photo is fitted inside. See the header for why 1024. */
export const LONG_EDGE = 1024;

/** What one stored photo is allowed to weigh. */
export const TARGET_BYTES = 100 * 1024;

/**
 * The quality range the search works in.
 *
 * It does not go to 1.0: above about 0.92 an encoder spends bytes on
 * differences nobody can see on a phone, and starting there only wastes the
 * first probe. It does not go below 0.45 either - past that the blocking is
 * visible enough to be a worse answer than the same picture in a smaller
 * frame, which is what the dimension step below is for.
 */
export const QUALITY_FLOOR = 0.45;
export const QUALITY_CEILING = 0.92;

/** How far the frame steps down when quality alone could not get there. */
export const DIMENSION_STEP = 0.8;
export const DIMENSION_TRIES = 3;

/**
 * The box an image fits into, never upscaled.
 *
 * A photo already smaller than the limit is left at its own size: enlarging it
 * would invent pixels and cost bytes to store the invention.
 *
 * @returns {{width: number, height: number}}
 */
export function fitWithin(width, height, longEdge = LONG_EDGE) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };

  const longest = Math.max(w, h);
  const limit = Math.max(1, Math.round(Number(longEdge) || 0));
  if (longest <= limit) return { width: w, height: h };

  const scale = limit / longest;
  // Rounded, then floored at 1: a panorama scaled hard enough would otherwise
  // round its short edge to zero and produce a canvas nothing can draw on.
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * The highest quality whose output still fits the budget.
 *
 * A binary search rather than a walk down a ladder: an encoder call is the
 * expensive part here - on a phone, a full-frame encode is tens of
 * milliseconds - so six probes across the range beats fifteen steps down it,
 * and lands within about half a percent of the same answer.
 *
 * Returns the best result that fits, or, when nothing does, the smallest thing
 * it managed. The caller decides what to do about a miss; this never throws,
 * because a photograph that will not compress is still a photograph somebody
 * wants kept.
 *
 * @param {(quality: number) => Promise<Blob>} encode  injected, so this is testable
 * @param {object} options
 * @param {number} options.budget  bytes
 * @param {number} options.probes  how many encodes to spend
 * @returns {Promise<{blob: Blob, quality: number, fits: boolean, probes: number}>}
 */
export async function searchQuality(encode, {
  budget = TARGET_BYTES,
  low = QUALITY_FLOOR,
  high = QUALITY_CEILING,
  probes = 6,
} = {}) {
  let lo = low;
  let hi = high;
  let best = null;      // the largest that fits
  let smallest = null;  // the smallest seen at all, for when nothing fits
  let spent = 0;

  for (let i = 0; i < probes; i += 1) {
    const quality = (lo + hi) / 2;
    const blob = await encode(quality);
    spent += 1;

    if (!smallest || blob.size < smallest.blob.size) smallest = { blob, quality };

    if (blob.size <= budget) {
      // Fits. Keep it and look for something better-looking above it.
      if (!best || quality > best.quality) best = { blob, quality };
      lo = quality;
    } else {
      hi = quality;
    }

    /*
     * Stop once the window is narrower than the difference is worth. A
     * quality of 0.83 against 0.84 is not a visible change, and the probe it
     * would cost is the most expensive thing in this loop.
     */
    if (hi - lo < 0.02) break;
  }

  if (best) return { ...best, fits: true, probes: spent };
  return { ...smallest, fits: false, probes: spent };
}

/**
 * The sequence of frame sizes to try, largest first.
 *
 * Pure, so the shape of the climb-down is checked rather than trusted. Each
 * step is DIMENSION_STEP of the one before, and the list stops before any edge
 * gets too small to be worth looking at.
 */
export function dimensionLadder(width, height, longEdge = LONG_EDGE, tries = DIMENSION_TRIES) {
  const first = fitWithin(width, height, longEdge);
  if (!first.width) return [];

  const ladder = [first];
  for (let i = 1; i <= tries; i += 1) {
    const limit = Math.round(longEdge * DIMENSION_STEP ** i);
    // 320 on the long edge is about where a photo stops being able to show
    // what the light was doing, which is the whole reason it is kept.
    if (limit < 320) break;
    const next = fitWithin(width, height, limit);
    if (next.width === ladder[ladder.length - 1].width) break;
    ladder.push(next);
  }
  return ladder;
}

/* ------------------------------------------------------------ the browser */

/**
 * Which format to write.
 *
 * WebP where it exists, which is everywhere current - it holds roughly a third
 * more detail than JPEG at the same weight, and at this budget that difference
 * is the difference between a photo and a smear. JPEG is the fallback, and
 * PNG is deliberately not an option: it is lossless, so it cannot be asked to
 * hit a budget at all.
 *
 * Probed once by encoding a single pixel and reading back what came out,
 * because `canvas.toBlob` with a type it does not know silently writes a PNG
 * rather than failing - which would sail past a check on whether it threw.
 */
let formatPromise = null;
export function bestFormat({ canvas = null } = {}) {
  if (formatPromise) return formatPromise;
  formatPromise = (async () => {
    try {
      const probe = canvas || document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      const blob = await new Promise((resolve) => probe.toBlob(resolve, 'image/webp', 0.8));
      if (blob && blob.type === 'image/webp') return 'image/webp';
    } catch {
      // Fall through: a browser that cannot answer gets the format that has
      // worked since 1992.
    }
    return 'image/jpeg';
  })();
  return formatPromise;
}

/**
 * Decode a blob to something drawable, with the camera's rotation applied.
 *
 * `imageOrientation: 'from-image'` is the whole reason this is not one line.
 * A phone writes the sensor's pixels and an EXIF tag saying which way up they
 * go; drawing the bitmap without honouring that tag is how a portrait photo
 * ends up on its side, and re-encoding it that way makes it permanent, because
 * the tag does not survive the canvas.
 */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Safari refused `imageOrientation` for a while. Ask again without it
      // rather than falling all the way back to an <img>.
      try {
        return await createImageBitmap(blob);
      } catch {
        // Fall through to the element.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file could not be read as an image.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (source) => ({
  width: source.width || source.naturalWidth || 0,
  height: source.height || source.naturalHeight || 0,
});

/**
 * Fit a photograph inside the long edge and the byte budget.
 *
 * Returns the original blob untouched when it is already small enough both
 * ways - re-encoding an image that already fits would spend time to make it
 * slightly worse, and the point of the whole exercise is speed.
 *
 * Never throws for a picture it merely could not get under budget: it returns
 * the best it managed and says `fits: false`. Losing somebody's photograph
 * because it would not compress would be the wrong way to fail.
 *
 * @returns {Promise<{blob: Blob, width: number, height: number, type: string,
 *                    fits: boolean, quality: number|null, from: number}>}
 */
export async function shrinkToBudget(blob, {
  longEdge = LONG_EDGE,
  budget = TARGET_BYTES,
  type = null,
} = {}) {
  const from = blob.size;

  const source = await decode(blob);
  const { width, height } = sizeOf(source);
  if (!width || !height) throw new Error('That file could not be read as an image.');

  /*
   * Already small enough, in both senses. Handed back as it came: the bytes
   * are fine, and a round trip through the canvas would only cost quality and
   * time.
   */
  const fitted = fitWithin(width, height, longEdge);
  if (from <= budget && fitted.width === width && fitted.height === height) {
    source.close?.();
    return { blob, width, height, type: blob.type, fits: true, quality: null, from };
  }

  const out = type || await bestFormat();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  let result = null;
  for (const size of dimensionLadder(width, height, longEdge)) {
    canvas.width = size.width;
    canvas.height = size.height;

    /*
     * White behind the picture, for the formats that have no alpha.
     *
     * A PNG with a transparent background drawn straight onto a fresh canvas
     * and written as JPEG comes out with black where the transparency was,
     * because an untouched canvas is transparent black. Filling first makes
     * that white instead, which is what anybody would expect.
     */
    if (out === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size.width, size.height);
    } else {
      context.clearRect(0, 0, size.width, size.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, size.width, size.height);

    const attempt = await searchQuality(
      (quality) => new Promise((resolve, reject) => {
        canvas.toBlob(
          (made) => (made ? resolve(made) : reject(new Error('The image could not be re-encoded.'))),
          out,
          quality,
        );
      }),
      { budget },
    );

    result = { ...attempt, width: size.width, height: size.height };
    if (attempt.fits) break;
  }

  source.close?.();
  if (!result) throw new Error('That file could not be read as an image.');

  /*
   * And if the shrink made it bigger, keep the original.
   *
   * It happens: a small, already heavily compressed JPEG re-encoded at a
   * higher quality than it was saved with comes out larger than it went in.
   * Storing that would be worse on both counts.
   */
  if (result.blob.size >= from && fitted.width === width && fitted.height === height) {
    return { blob, width, height, type: blob.type, fits: from <= budget, quality: null, from };
  }

  return {
    blob: result.blob,
    width: result.width,
    height: result.height,
    type: out,
    fits: result.fits,
    quality: result.quality,
    from,
  };
}
