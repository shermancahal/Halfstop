import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: 'block' })).newPage();
await page.goto('http://localhost:8104/map.html', { waitUntil: 'load' });
await page.waitForTimeout(3500);

console.log(JSON.stringify(await page.evaluate(() => {
  const corner = document.querySelector('.maplibregl-ctrl-top-right, .mapboxgl-ctrl-top-right');
  const groups = [...(corner?.children || [])];
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at ? `${at.tagName}.${(at.className.baseVal ?? at.className).toString().split(' ')[0]}` : 'nothing';
  };
  return {
    corner: corner?.className,
    cornerZ: corner ? getComputedStyle(corner).zIndex : null,
    cornerPointer: corner ? getComputedStyle(corner).pointerEvents : null,
    groups: groups.map((g) => ({
      cls: g.className,
      z: getComputedStyle(g).zIndex,
      pointer: getComputedStyle(g).pointerEvents,
      rect: (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(g.getBoundingClientRect()),
      whatIsThere: hit(g),
    })),
  };
}, null), null, 1));
await browser.close();
