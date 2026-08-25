/**
 * Turn full-size highway shield blanks into map icons.
 *
 * The blanks are 1280–1920px PNGs from Wikimedia Commons' "Highway shield
 * blanks of the United States". On the map they are drawn about 20 CSS pixels
 * tall, so shipping the originals would be three megabytes to render forty
 * pixels — this reduces them to the two sizes the style actually asks for and
 * writes them into assets/shields/.
 *
 * Done here rather than at runtime because it is a one-off: the blanks do not
 * change, and the browser should not be downscaling a 1280px image to 44px on
 * every pan.
 *
 * Scaling happens in Chromium rather than in Node because there is no image
 * library here and the browser is already a dependency of the smoke test. Each
 * blank is trimmed to its own ink first — many are a small mark on a large
 * transparent canvas, and scaling that untrimmed wastes most of the 40 pixels
 * on empty space.
 *
 *   node tools/build-shields.mjs <source-directory>
 */

import { chromium } from 'playwright';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'shields');

/** The two boxes the style asks for, in device pixels at pixelRatio 2. */
const SIZES = { narrow: { width: 44, height: 40 }, wide: { width: 66, height: 40 } };

/**
 * Which blank belongs to which state, and which is the wide variant.
 *
 * Built by hand from the filenames because they are not systematic — Kansas is
 * `K-blank`, Michigan is `M-Blank`, Wisconsin is `WIS_blank`. A state with no
 * entry keeps the drawn fallback in lib/route-shields.js.
 */
const BLANKS = {
  // The two national shields. Keyed by design name rather than a state code,
  // because that is what the style asks for: every interstate marker in the
  // country is the same marker.
  interstate: { narrow: 'I-blank', wide: 'I-blank_wide' },
  us: { narrow: 'US_blank', wide: 'US_blank_wide' },

  AL: { narrow: 'Alabama_blank', wide: 'Alabama_blank_wide' },
  AK: { narrow: 'Alaska_blank_shield' },
  AZ: { narrow: 'Arizona_blank', wide: 'Arizona_blank_wide' },
  AR: { narrow: 'Arkansas_blank', wide: 'Arkansas_blank_wide' },
  CA: { narrow: 'California_blank', wide: 'California_blank_wide' },
  CO: { narrow: 'Colorado_blank' },
  CT: { narrow: 'Connecticut_Highway_blank' },
  DC: { narrow: 'DC_Blank' },
  FL: { narrow: 'Florida_blank', wide: 'Florida_blank_wide' },
  GA: { narrow: 'Georgia_blank', wide: 'Georgia_blank_wide' },
  HI: { narrow: 'HI-blank' },
  ID: { narrow: 'Idaho_blank', wide: 'Idaho_blank_wide' },
  IL: { narrow: 'Illinois_blank', wide: 'Illinois_blank_wide' },
  IN: { narrow: 'Indiana_blank', wide: 'Indiana_blank_wide' },
  KS: { narrow: 'K-blank', wide: 'K-blank_wide' },
  LA: { narrow: 'Louisiana_blank_2008' },
  MA: { narrow: 'MA_Route_blank', wide: 'MA_Route_blank_wide' },
  MD: { narrow: 'MD_blank', wide: 'MD_blank_wide' },
  ME: { narrow: 'Maine_blank', wide: 'Maine_blank_wide' },
  MI: { narrow: 'M-Blank', wide: 'M-Blank3' },
  MN: { narrow: 'MN-blank', wide: 'MN-blank_wide' },
  MO: { narrow: 'MO-blank' },
  MT: { narrow: 'MT-blank', wide: 'MT-blank-3d' },
  NC: { narrow: 'NC_blank' },
  ND: { narrow: 'ND-blank', wide: 'ND-blank_wide' },
  NE: { narrow: 'Nebraska_state_highway_ma', wide: 'Nebraska_wide_state_highw' },
  NH: { narrow: 'NH_Route_blank' },
  NM: { narrow: 'New_Mexico_blank' },
  NV: { narrow: 'Nevada_blank' },
  NY: { narrow: 'NY-blank' },
  OH: { narrow: 'OH-blank' },
  OK: { narrow: 'Oklahoma_State_Highway_bl', wide: 'Oklahoma_State_Highway_bl' },
  OR: { narrow: 'OR_blank_2', wide: 'OR_blank_wide' },
  PA: { narrow: 'PA-blank2di', wide: 'PA-blank3di' },
  RI: { narrow: 'Rhode_Island_blank' },
  SC: { narrow: 'SC-blank', wide: 'SC-blank-wide' },
  SD: { narrow: 'SD_Blank-2d', wide: 'SD_Blank-3d' },
  TN: { narrow: 'Tennessee_blank', wide: 'Tennessee_blank' },
  UT: { narrow: 'Utah_blank', wide: 'Utah_blank_wide' },
  VA: { narrow: 'Virginia_blank', wide: 'Virginia_blank_wide' },
  VT: { narrow: 'Vermont_blank_border', wide: 'Vermont_blank_wide' },
  WA: { narrow: 'WA-blank' },
  WI: { narrow: 'WIS_blank' },
  WV: { narrow: 'WV-blank' },
  WY: { narrow: 'WY-blank' },
};

const source = process.argv[2];
if (!source) {
  console.error('Usage: node tools/build-shields.mjs <source-directory>');
  process.exit(2);
}

const files = await readdir(source);
/** Match a stem to a file, ignoring the resolution prefix and the .svg suffix. */
const find = (stem) => files.find((name) => name.replace(/^\d+px-/, '').replace(/\.svg\.png$/, '.png') === `${stem}.png`);

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
await page.goto('data:text/html,<body>');

const boxes = {};
let written = 0;
let bytes = 0;
const missing = [];

for (const [code, variants] of Object.entries(BLANKS)) {
  for (const [variant, stem] of Object.entries(variants)) {
    const file = find(stem);
    if (!file) { missing.push(`${code} ${variant}: no file matching ${stem}`); continue; }

    const raw = await readFile(path.join(source, file));
    const box = SIZES[variant];

    const dataURL = await page.evaluate(async ({ base64, box: target }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();

      // Trim to the ink: many blanks are a small mark on a large transparent
      // canvas, and scaling that untrimmed spends most of the height on air.
      const probe = document.createElement('canvas');
      probe.width = image.width;
      probe.height = image.height;
      const probeCtx = probe.getContext('2d');
      probeCtx.drawImage(image, 0, 0);
      const pixels = probeCtx.getImageData(0, 0, probe.width, probe.height).data;

      let top = probe.height;
      let bottom = -1;
      let left = probe.width;
      let right = -1;
      for (let y = 0; y < probe.height; y += 1) {
        for (let x = 0; x < probe.width; x += 1) {
          if (pixels[(y * probe.width + x) * 4 + 3] > 12) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      if (bottom < 0) { top = 0; left = 0; bottom = probe.height - 1; right = probe.width - 1; }

      const cropWidth = right - left + 1;
      const cropHeight = bottom - top + 1;

      // Fit inside the target box, centred, preserving aspect.
      const scale = Math.min(target.width / cropWidth, target.height / cropHeight);
      const drawWidth = Math.round(cropWidth * scale);
      const drawHeight = Math.round(cropHeight * scale);

      const out = document.createElement('canvas');
      out.width = target.width;
      out.height = target.height;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        image, left, top, cropWidth, cropHeight,
        Math.round((target.width - drawWidth) / 2), Math.round((target.height - drawHeight) / 2),
        drawWidth, drawHeight,
      );
      /*
       * Where the number goes.
       *
       * A third of these markers carry the state's name across the top, and a
       * number centred in the image lands on top of it. Rather than hand-tune
       * forty-five offsets, find the largest clear rectangle in the shield's
       * own field colour: the letters of "ILLINOIS" are holes in that field,
       * so the largest rectangle avoiding them is exactly the space left for
       * the number.
       */
      const box = ctx.getImageData(0, 0, out.width, out.height);

      /*
       * Candidate field colours, commonest first.
       *
       * Taking the single most common colour is not enough: Michigan and North
       * Carolina are a white diamond on a black square, and the black square
       * wins on pixel count while the number plainly goes on the diamond. So
       * the top few colours are each tried and the one offering the largest
       * clear rectangle wins — a thin border ring has no room in it, and a
       * diamond does.
       */
      const counts = new Map();
      for (let i = 0; i < box.data.length; i += 4) {
        if (box.data[i + 3] < 200) continue;
        const key = `${box.data[i] >> 4},${box.data[i + 1] >> 4},${box.data[i + 2] >> 4}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const candidates = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([key]) => key.split(',').map(Number));

      const largestClearRect = (field) => {
        const clear = [];
        for (let y = 0; y < out.height; y += 1) {
          const row = [];
          for (let x = 0; x < out.width; x += 1) {
            const i = (y * out.width + x) * 4;
            row.push(box.data[i + 3] > 200
              && (box.data[i] >> 4) === field[0]
              && (box.data[i + 1] >> 4) === field[1]
              && (box.data[i + 2] >> 4) === field[2] ? 1 : 0);
          }
          clear.push(row);
        }

        const heights = new Array(out.width).fill(0);
        let bestArea = 0;
        let best = { x: 0, y: 0, w: 0, h: 0 };
        for (let y = 0; y < out.height; y += 1) {
          for (let x = 0; x < out.width; x += 1) heights[x] = clear[y][x] ? heights[x] + 1 : 0;
          const stack = [];
          for (let x = 0; x <= out.width; x += 1) {
            const height = x === out.width ? 0 : heights[x];
            let start = x;
            while (stack.length && stack[stack.length - 1].height >= height) {
              const top = stack.pop();
              const area = top.height * (x - top.x);
              if (area > bestArea) {
                bestArea = area;
                best = { x: top.x, y: y - top.height + 1, w: x - top.x, h: top.height };
              }
              start = top.x;
            }
            stack.push({ x: start, height });
          }
        }
        return best;
      };

      let bestRect = { x: 0, y: 0, w: out.width, h: out.height };
      let bestScore = 0;
      for (const field of candidates) {
        const rect = largestClearRect(field);
        // Score on area, but a box has to be tall enough to put a number in —
        // a wide two-pixel sliver is not somewhere a route number can go.
        const score = rect.h >= out.height * 0.30 ? rect.w * rect.h : 0;
        if (score > bestScore) { bestScore = score; bestRect = rect; }
      }

      return {
        url: out.toDataURL('image/png'),
        // Centre of the clear space, as an offset from the image centre, in
        // device pixels at this scale.
        box: {
          dx: (bestRect.x + bestRect.w / 2) - out.width / 2,
          dy: (bestRect.y + bestRect.h / 2) - out.height / 2,
          w: bestRect.w,
          h: bestRect.h,
        },
      };
    }, { base64: raw.toString('base64'), box });

    const out = Buffer.from(dataURL.url.split(',')[1], 'base64');
    const name = `${code}-${variant}.png`;
    await writeFile(path.join(OUT, name), out);
    written += 1;
    bytes += out.length;
    boxes[`${code}-${variant}`] = {
      dx: Math.round(dataURL.box.dx * 10) / 10,
      dy: Math.round(dataURL.box.dy * 10) / 10,
      w: dataURL.box.w,
      h: dataURL.box.h,
    };
  }
}

await browser.close();

await writeFile(path.join(OUT, 'boxes.json'), `${JSON.stringify(boxes, null, 2)}\n`);

/*
 * The same data as a module, so the app imports it rather than fetching it.
 *
 * Seventy-two small records — fetching a manifest before the first shield can
 * be drawn would put a network round trip in front of every map load for less
 * than three kilobytes of JSON.
 */
const module = `/**
 * Where the route number goes on each shield blank, and how big it can be.
 *
 * GENERATED by tools/build-shields.mjs — do not edit by hand.
 *
 * \`dx\`/\`dy\` are the offset of the clear space from the image centre and
 * \`w\`/\`h\` its size, all in device pixels of a 40px-tall icon. They are found
 * by looking for the largest rectangle of the shield's own field colour, which
 * is why a marker with the state's name across the top puts its number
 * underneath: the letters are holes in that field and the rectangle avoids
 * them.
 */

export const SHIELD_BOXES = ${JSON.stringify(boxes, null, 2)};

/** Which state codes have a real blank, at which widths. */
export const SHIELD_IMAGES = ${JSON.stringify(
  Object.keys(BLANKS).reduce((all, code) => {
    all[code] = Object.keys(BLANKS[code]);
    return all;
  }, {}),
  null,
  2,
)};
`;
await writeFile(path.join(ROOT, 'assets', 'js', 'lib', 'shield-boxes.js'), module);

console.log(`${written} shield images written to assets/shields (${Math.round(bytes / 1024)}KB total)`);
if (missing.length) {
  console.log('\nNo source file for:');
  for (const line of missing) console.log(`  ${line}`);
}
