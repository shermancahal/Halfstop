/**
 * The two decisions behind shrinking a photograph.
 *
 * What size to aim for, and which quality to settle on. Both are pure, with
 * the encoder injected, so the interesting behaviour is checked here rather
 * than inferred from a picture that came out looking about right. What a
 * canvas actually produces is checked in a browser instead - see
 * tools/smoke.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fitWithin, searchQuality, dimensionLadder,
  LONG_EDGE, TARGET_BYTES, QUALITY_FLOOR, QUALITY_CEILING,
} from '../assets/js/lib/photo-encode.js';

test('photos: the frame is fitted inside the long edge, whichever edge that is', () => {
  // Landscape, portrait and square all measured against their own longest
  // side - a rule that only looked at width would leave a portrait photo at
  // 1365 tall while reporting success.
  assert.deepEqual(fitWithin(4032, 3024), { width: 1024, height: 768 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 768, height: 1024 });
  assert.deepEqual(fitWithin(2000, 2000), { width: 1024, height: 1024 });
});

test('photos: something already small is left exactly as it is', () => {
  /*
   * Never upscaled. Enlarging invents pixels and then charges storage for the
   * invention, and the caller uses "the size did not change" to decide it can
   * skip re-encoding altogether.
   */
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1024, 200), { width: 1024, height: 200 }, 'exactly on the limit is not over it');
  assert.deepEqual(fitWithin(1, 1), { width: 1, height: 1 });
});

test('photos: a panorama keeps a short edge it can be drawn on', () => {
  // 10000x120 scaled to a 1024 long edge is 12.288 on the short edge. Rounded
  // that is 12; the failure this guards is a rule that floors to 0 and hands
  // back a canvas with no area, which throws on the first drawImage.
  const wide = fitWithin(10000, 120);
  assert.equal(wide.width, 1024);
  assert.ok(wide.height >= 1, `short edge collapsed to ${wide.height}`);

  const extreme = fitWithin(20000, 3);
  assert.ok(extreme.height >= 1, 'a one-pixel-tall strip still has a pixel');
});

test('photos: nonsense in is nothing out, rather than a broken canvas', () => {
  for (const [w, h] of [[0, 0], [-10, 10], [NaN, 500], [undefined, undefined], ['x', 'y']]) {
    assert.deepEqual(fitWithin(w, h), { width: 0, height: 0 }, `${w}x${h}`);
  }
});

/* ----------------------------------------------------------- the quality */

/**
 * A stand-in encoder with a plausible shape: bytes rise with quality, and
 * `atQuality` says where it crosses the budget. Nothing here depends on the
 * real curve - only on the search finding the best point under the line.
 */
const fakeEncoder = (bytesFor) => {
  const calls = [];
  const encode = async (quality) => {
    calls.push(quality);
    return { size: bytesFor(quality), quality };
  };
  return { encode, calls };
};

test('photos: the search settles on the best quality that still fits', async () => {
  const SLOPE = 143000;
  const { encode } = fakeEncoder((q) => Math.round(q * SLOPE));
  // Worked out rather than asserted from memory, so the test cannot be wrong
  // about its own fixture: this curve crosses the budget here.
  const crossing = TARGET_BYTES / SLOPE;

  const found = await searchQuality(encode, { budget: TARGET_BYTES });

  assert.equal(found.fits, true);
  assert.ok(found.blob.size <= TARGET_BYTES, `kept ${found.blob.size} bytes`);
  // Under the crossing, and close enough to it that nothing visible was left
  // on the table. The search stops once the window is narrower than a
  // difference anybody could see, which is about two hundredths of quality.
  assert.ok(found.quality <= crossing, `settled on ${found.quality}, above the crossing ${crossing}`);
  assert.ok(crossing - found.quality < 0.03,
    `settled on ${found.quality}, which leaves ${(crossing - found.quality).toFixed(3)} unspent`);
});

test('photos: it spends few encodes, because an encode is the expensive part', async () => {
  const { encode, calls } = fakeEncoder((q) => Math.round(q * 143000));
  await searchQuality(encode, { budget: TARGET_BYTES });
  // Six is the cap; the early exit usually stops it sooner. A walk down a
  // ladder in 0.05 steps would be ten to fifteen full-frame encodes.
  assert.ok(calls.length <= 6, `spent ${calls.length} encodes`);
  assert.ok(calls.every((q) => q >= QUALITY_FLOOR && q <= QUALITY_CEILING),
    `probed outside the range: ${calls.join(', ')}`);
});

test('photos: a picture that fits at any quality keeps the best one', async () => {
  // Everything is small. The answer should be at the top of the range, not
  // wherever the first probe happened to land.
  const { encode } = fakeEncoder(() => 20000);
  const found = await searchQuality(encode, { budget: TARGET_BYTES });
  assert.equal(found.fits, true);
  assert.ok(found.quality > 0.8, `settled on ${found.quality} when everything fitted`);
});

test('photos: a picture that fits at no quality comes back anyway', async () => {
  /*
   * The direction this fails in is the whole point. A photograph that will not
   * compress is still a photograph somebody wants kept, so the search returns
   * the smallest thing it managed and says so, and the caller decides. Throwing
   * here would lose somebody's picture to an encoder's opinion.
   */
  const { encode } = fakeEncoder((q) => Math.round(400000 + q * 100000));
  const found = await searchQuality(encode, { budget: TARGET_BYTES });

  assert.equal(found.fits, false);
  assert.ok(found.blob, 'it still handed something back');
  // And it is the smallest it saw, which is the one at the bottom of the range.
  assert.ok(found.quality <= 0.6, `kept the ${found.quality} attempt rather than the smallest`);
});

/* -------------------------------------------------------- the climb-down */

test('photos: the frame steps down only after quality has been spent', () => {
  const ladder = dimensionLadder(4032, 3024);
  assert.equal(ladder[0].width, 1024, 'it starts at the full size');
  // Each step is smaller than the last, and strictly so - a ladder with a
  // repeated rung would re-encode the same frame and call it progress.
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i].width < ladder[i - 1].width,
      `rung ${i} (${ladder[i].width}) is not smaller than ${ladder[i - 1].width}`);
  }
  assert.ok(ladder.length >= 2 && ladder.length <= 4, `${ladder.length} rungs`);
});

test('photos: it stops before the photo stops being worth looking at', () => {
  // Below about 320 on the long edge a photograph can no longer show what the
  // light was doing, which is the only reason it is being kept.
  for (const rung of dimensionLadder(4032, 3024)) {
    assert.ok(Math.max(rung.width, rung.height) >= 320,
      `${rung.width}x${rung.height} is too small to be worth storing`);
  }
});

test('photos: an image already under the limit has nowhere to climb down to', () => {
  const ladder = dimensionLadder(600, 400);
  assert.deepEqual(ladder[0], { width: 600, height: 400 });
  // Every rung would be a downscale of something that already fits, so the
  // first one is the answer and the rest are wasted encodes.
  assert.equal(ladder.length, 1);
  assert.deepEqual(dimensionLadder(0, 0), []);
});

test('photos: the two numbers are the ones that were asked for', () => {
  // Stated in one place and checked here, because they are quoted to the
  // reader in the interface and written into the help page.
  assert.equal(LONG_EDGE, 1024);
  assert.equal(TARGET_BYTES, 100 * 1024);
});
