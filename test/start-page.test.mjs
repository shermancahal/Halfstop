/**
 * Opening straight onto the map, where it was left.
 *
 * Asked for as "a checkbox in settings so they can skip the splash screen and
 * go straight to the map to where they were last at". What can go wrong is
 * quiet: the home page becoming unreachable, a link losing to the kept place,
 * a place kept for somebody who never asked, or the few lines in index.html
 * drifting from the module they copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  CAMERA_KEY, LAUNCH_KEY, OPENS_ON_MAP_KEY,
  cameraText, deviceStorage, keepCamera, opensOnMap, parseCamera, resumeCamera,
  setOpensOnMap, skipsHome, startRow,
} from '../assets/js/lib/start-page.js';

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
    items,
  };
}

const here = { center: { lng: -111.86098765, lat: 40.7777777 }, zoom: 13.456, bearing: 12.34, pitch: 45.67 };

test('start page: a camera is kept to a metre and read back, and junk is nowhere', () => {
  const text = cameraText(here);
  assert.deepEqual(JSON.parse(text), { center: [-111.86099, 40.77778], zoom: 13.46, bearing: 12.3, pitch: 45.7 });
  assert.deepEqual(parseCamera(text), { center: [-111.86099, 40.77778], zoom: 13.46, bearing: 12.3, pitch: 45.7 });
  assert.deepEqual(parseCamera(cameraText({ center: [10, 20], zoom: 4 })),
    { center: [10, 20], zoom: 4, bearing: 0, pitch: 0 }, 'an array centre, flat and north up');

  for (const junk of ['', 'null', '{', '[]', '{"center":[1,2]}', '{"center":[200,0],"zoom":3}',
    '{"center":[0,95],"zoom":3}', '{"center":[0,0],"zoom":30}', '{"center":["1","2"],"zoom":3}']) {
    assert.equal(parseCamera(junk), null, junk);
  }
  assert.equal(cameraText({ center: { lng: NaN, lat: 1 }, zoom: 3 }), null);
});

test('start page: off, nothing is kept and the map is not sent anywhere', () => {
  const storage = memoryStorage();
  assert.equal(opensOnMap(storage), false);
  assert.equal(keepCamera(storage, here), false, 'a place is kept only for somebody who asked');
  assert.equal(storage.items.has(CAMERA_KEY), false);
  assert.equal(resumeCamera(memoryStorage({ [CAMERA_KEY]: cameraText(here) })), null,
    'a place left over from before does not move a map that was not asked to');
});

test('start page: on, the map is put back where it was, and off forgets the place', () => {
  const storage = memoryStorage();
  setOpensOnMap(storage, true, here);
  assert.equal(storage.getItem(OPENS_ON_MAP_KEY), '1');
  assert.deepEqual(resumeCamera(storage).center, [-111.86099, 40.77778], 'turned on from the map: where it is now');

  assert.equal(keepCamera(storage, { center: [-105, 39.5], zoom: 9 }), true);
  assert.deepEqual(resumeCamera(storage), { center: [-105, 39.5], zoom: 9, bearing: 0, pitch: 0 });

  setOpensOnMap(storage, false);
  assert.equal(storage.items.size, 0, 'off removes the choice and the place with it');
});

test('start page: the gear row reads and writes the device choice', () => {
  const storage = memoryStorage();
  let asked = 0;
  const row = startRow({ storage, camera: () => { asked += 1; return here; } });
  assert.equal(row.label, 'Opens on');
  assert.deepEqual(row.options.map((option) => option.value), ['home', 'map']);
  assert.equal(row.read(), 'home', 'off unless chosen');

  row.write('map');
  assert.equal(row.read(), 'map');
  assert.equal(asked, 1, 'the place now is kept as it is turned on');
  assert.ok(resumeCamera(storage));

  row.write('home');
  assert.equal(row.read(), 'home');
  assert.equal(asked, 1, 'turning it off asks for no place');
  assert.equal(resumeCamera(storage), null);
});

test('start page: a device that refuses storage is a device that opens on the home page', () => {
  const refusing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(opensOnMap(refusing), false);
  assert.doesNotThrow(() => setOpensOnMap(refusing, true, here));
  assert.equal(resumeCamera(refusing), null);
  const blocked = Object.defineProperty({}, 'localStorage', { get() { throw new Error('SecurityError'); } });
  assert.equal(deviceStorage(blocked), null, 'reaching for storage can throw, and must not take the map down');
  assert.doesNotThrow(() => startRow({ storage: refusing }).read());
});

test('start page: only a launch skips the home page', () => {
  const origin = 'https://app.halfstop.app';
  const launch = { on: true, origin };
  assert.equal(skipsHome(launch), true, 'opened from the app icon, a bookmark or the address bar');
  assert.equal(skipsHome({ ...launch, on: false }), false, 'not chosen');
  assert.equal(skipsHome({ ...launch, launched: true }), false, 'Back, a reload: already in this visit');
  assert.equal(skipsHome({ ...launch, referrer: `${origin}/map.html#view=12/40/-111` }), false,
    'the brand link on the map, which is the only way back to the home page');
  assert.equal(skipsHome({ ...launch, referrer: 'https://www.google.com/' }), true, 'a search result is a launch');
  assert.equal(skipsHome({ ...launch, hash: '#costs' }), false, 'a link to a part of the page');
  assert.equal(skipsHome({ ...launch, search: '?ref=x' }), false);
});

/*
 * The lines in index.html are what run, before the page is drawn, and cannot
 * import the module. So they are run here, against the module's rule, in every
 * case above.
 */
test('start page: the home page script follows skipsHome, with the same keys', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*(\/\*[\s\S]*?A shared map link[\s\S]*?)<\/script>/);
  assert.ok(script, 'the redirect script left the home page');
  assert.ok(html.indexOf(script[0]) < html.indexOf('<link rel="stylesheet"'),
    'it runs before the stylesheet, or the home page is drawn before it leaves');

  const run = ({ on, launched = false, search = '', hash = '', referrer = '' }) => {
    const origin = 'https://app.halfstop.app';
    const local = memoryStorage(on ? { [OPENS_ON_MAP_KEY]: '1' } : {});
    const session = memoryStorage(launched ? { [LAUNCH_KEY]: '1' } : {});
    let went = null;
    vm.runInNewContext(script[1], {
      URL, URLSearchParams,
      localStorage: local,
      sessionStorage: session,
      document: { referrer },
      location: { search, hash, origin, replace: (to) => { went = to; } },
    });
    assert.equal(session.getItem(LAUNCH_KEY), '1', 'the visit is marked as begun');
    return { went, expected: skipsHome({ on, launched, search, hash, referrer, origin }) };
  };

  for (const visit of [
    { on: true }, { on: false }, { on: true, launched: true },
    { on: true, referrer: 'https://app.halfstop.app/map.html' }, { on: true, referrer: 'https://www.google.com/' },
    { on: true, hash: '#costs' }, { on: false, hash: '#costs' },
  ]) {
    const { went, expected } = run(visit);
    assert.equal(went === 'map.html', expected, JSON.stringify(visit));
  }

  // And the links that always went on still do, chosen or not.
  assert.equal(run({ on: false, search: '?m=blue-ridge' }).went, 'map.html?m=blue-ridge');
  assert.equal(run({ on: true, hash: '#whats-new' }).went, 'faq.html#whats-new');
});

test('start page: the map keeps its place, opens on it, and a link still wins', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /const resume = arrivedWithAView \|\| initial\.pin \|\| initial\.slugs\.length \|\| initial\.link\s*\? null : resumeCamera\(/,
    'a shared view, a pin, a folder or a sent link must decide where the map goes');
  assert.match(viewer, /center: resume\?\.center \|\| DEFAULT_VIEW\.center/, 'the map is built where it was left');
  assert.match(viewer, /!initial\.link && !resume\) centreOnYou\(\)/, 'and is not then moved to the reader');
  assert.match(viewer, /on\('moveend', \(\) => keepCamera\(/);
  assert.match(viewer, /sessionStore\(\)\?\.setItem\(LAUNCH_KEY/, 'a visit begun on the map is not a launch of the home page');
  assert.match(viewer, /startRow\(\{ camera: cameraNow \}\)/, 'the gear on the map offers it');
  const pages = await readFile(new URL('../assets/js/lib/page-settings.js', import.meta.url), 'utf8');
  assert.match(pages, /THEME_ROW, startRow\(\)/, 'and so does the gear on the home page');
});
