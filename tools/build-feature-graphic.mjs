#!/usr/bin/env node
/**
 * The feature graphic Google Play puts at the top of the store listing.
 *
 * Usage:  node tools/build-feature-graphic.mjs
 *
 * Play asks for exactly 1024 x 500, JPEG or 24-bit PNG with no alpha. It is
 * drawn from the same pieces as the website - the topographic hero photograph,
 * the medallion, the name and the line under it - laid out as HTML and
 * photographed by the Chromium Playwright already brings for the smoke test,
 * because typesetting is what a browser is for and what this repository's own
 * rasteriser is not.
 *
 * The fonts are whatever this machine has for the site's font stacks. On a Mac
 * that is Iowan Old Style, as on the site; elsewhere it falls back to a similar
 * serif. Run it on the Mac for the version that goes to Play.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { readMaster, renderIcon } from './build-app-icons.mjs';
import { encodePNG, decodePNG } from './raster.mjs';
import { SITE } from '../assets/js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under docs/, not assets/: everything in assets/ is published with the
// website, and this is for Play Console, not for visitors.
const OUT = path.join(ROOT, 'docs', 'store', 'play-feature-graphic.png');
export const SIZE = { width: 1024, height: 500 };

/** The page that gets photographed. */
export function featureGraphicHtml({ photo, mark, name, tagline }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${SIZE.width}px; height: ${SIZE.height}px; overflow: hidden; }
  body {
    background: #1f2846 url(${photo}) center / cover no-repeat;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Charter, "Bitstream Charter", Georgia, serif;
    color: #f2ece3;
  }
  .wash {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, rgba(31,40,70,.96) 0%, rgba(31,40,70,.9) 48%, rgba(31,40,70,.45) 100%);
  }
  .row { position: absolute; inset: 0; display: flex; align-items: center; gap: 44px; padding: 0 72px; }
  img { width: 240px; height: 240px; flex: none; filter: drop-shadow(0 10px 24px rgba(0,0,0,.45)); }
  h1 { margin: 0; font-size: 96px; font-weight: 600; letter-spacing: -.01em; line-height: 1; }
  p { margin: 18px 0 0; font: 500 30px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #e8dfd2; max-width: 560px; }
</style></head><body><div class="wash"></div><div class="row">
  <img src="${mark}" alt=""><div><h1>${name}</h1><p>${tagline}</p></div>
</div></body></html>`;
}

async function main() {
  const master = await readMaster();
  const medallion = renderIcon(master, { size: 480, shape: 'tight' });
  const mark = `data:image/png;base64,${Buffer.from(encodePNG(medallion.width, medallion.height, medallion.rgba)).toString('base64')}`;
  const photo = `data:image/jpeg;base64,${(await readFile(path.join(ROOT, 'assets', 'img', 'hero-topo.jpg'))).toString('base64')}`;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    await page.setContent(featureGraphicHtml({
      photo, mark, name: SITE.name, tagline: 'A field atlas for photographers. Scout it, pin it, time the light.',
    }), { waitUntil: 'load' });
    const shot = await page.screenshot({ type: 'png', omitBackground: false });
    // Re-encoded through the repository's own encoder, which writes an opaque
    // image as RGB - Play refuses a feature graphic with an alpha channel.
    const decoded = decodePNG(shot);
    await writeFile(OUT, encodePNG(decoded.width, decoded.height, decoded.rgba));
    console.log(`Wrote ${path.relative(ROOT, OUT)} (${decoded.width} x ${decoded.height})`);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
