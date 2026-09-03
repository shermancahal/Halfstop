import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|404/.test(m.text())) console.log('console error:', m.text().slice(0, 500)); });
page.on('pageerror', (e) => console.log('page error:', (e.stack || String(e)).slice(0, 900)));
await page.goto(process.env.MAP_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
console.log('map present:', await page.evaluate(() => Boolean(window.__map || document.querySelector('.maplibregl-canvas, .mapboxgl-canvas'))));
await browser.close();
