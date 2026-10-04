/**
 * A map file another app handed to this one.
 *
 * The address says nothing reliable about what the file is - a GPX from a
 * messaging app arrives as application/octet-stream with a number for a name -
 * so these pin the reading of the bytes, the name it is given, and the
 * hand-off from the app being opened to the map that imports it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sniffMapFile, openedFileName, readOpenedFile, bytesFromBase64 } from '../assets/js/lib/opened-file.js';
import {
  OPEN_FILE_KEY, appShell, isFileUrl, takeOpenedFile, watchAppLinks,
} from '../assets/js/lib/native-shell.js';

const bytes = (text) => new TextEncoder().encode(text);

test('opened file: the kind comes from the bytes', () => {
  assert.equal(sniffMapFile(bytes('<?xml version="1.0"?>\n<gpx version="1.1" creator="Halfstop"><wpt/></gpx>')), 'gpx');
  assert.equal(sniffMapFile(bytes('\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n<kml xmlns="http://www.opengis.net/kml/2.2"/>')), 'kml');
  assert.equal(sniffMapFile(bytes('<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"/>')), 'kml', 'a prefixed root');
  assert.equal(sniffMapFile(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), 'kmz');
  assert.equal(sniffMapFile(bytes('  {"type": "FeatureCollection", "features": []}')), 'geojson');
  assert.equal(sniffMapFile(bytes('{"type":"Feature","geometry":null,"properties":{}}')), 'geojson');
});

test('opened file: anything else is not a map file, however it was labelled', () => {
  assert.equal(sniffMapFile(bytes('{"name": "package.json", "version": "1.0.0"}')), '');
  assert.equal(sniffMapFile(bytes('<html><body>not a map</body></html>')), '');
  // A KML that mentions <gpx in a description is still a KML.
  assert.equal(sniffMapFile(bytes('<kml><Document><description>&lt;gpx&gt; and <![CDATA[<gpx>]]></description></Document></kml>')), 'kml');
  assert.equal(sniffMapFile(bytes('%PDF-1.7')), '');
  assert.equal(sniffMapFile(new Uint8Array()), '');
});

test('opened file: a name from the address when it agrees, otherwise one that says what it is', () => {
  assert.equal(openedFileName('content://com.android.providers.downloads.documents/document/Moab%20trip.gpx', 'gpx'), 'Moab trip.gpx');
  assert.equal(openedFileName('content://com.google.android.gm.sapi/attachment/1234', 'gpx'), 'Shared file.gpx');
  assert.equal(openedFileName('content://x/places.json', 'geojson'), 'places.json');
  // A name of another kind is not trusted: the import goes by the extension.
  assert.equal(openedFileName('content://x/track.kml', 'gpx'), 'Shared file.gpx');
  assert.equal(openedFileName('content://x/%E0%A4%A', 'kml'), 'Shared file.kml');
});

test('opened file: read through Capacitor\'s local server, then the plugin', async () => {
  const gpx = '<gpx><wpt lat="38.6" lon="-109.5"/></gpx>';
  const asked = [];
  const capacitor = { convertFileSrc: (url) => `https://localhost/_capacitor_content_/${url.slice('content://'.length)}` };
  const fetch = async (url) => { asked.push(url); return { ok: true, arrayBuffer: async () => bytes(gpx).buffer }; };
  const file = await readOpenedFile('content://com.example/attachment/9', { capacitor, fetch });
  assert.deepEqual(asked, ['https://localhost/_capacitor_content_/com.example/attachment/9']);
  assert.equal(file.name, 'Shared file.gpx');
  assert.equal(await file.text(), gpx);

  // The local server refusing it falls through to the Filesystem plugin.
  const viaPlugin = await readOpenedFile('content://com.example/a.kml', {
    capacitor: {
      convertFileSrc: (url) => `https://localhost/x/${url}`,
      Plugins: { Filesystem: { readFile: async () => ({ data: Buffer.from('<kml/>').toString('base64') }) } },
    },
    fetch: async () => ({ ok: false }),
  });
  assert.equal(viaPlugin.name, 'a.kml');
});

test('opened file: an unreadable or foreign file is said in words, not thrown as a stack', async () => {
  await assert.rejects(
    readOpenedFile('content://x/1', { capacitor: { convertFileSrc: (u) => `https://localhost/${u}` }, fetch: async () => ({ ok: false }) }),
    /could not be read/,
  );
  await assert.rejects(
    readOpenedFile('content://x/1', {
      capacitor: { convertFileSrc: (u) => `https://localhost/${u}` },
      fetch: async () => ({ ok: true, arrayBuffer: async () => bytes('hello').buffer }),
    }),
    /opens GPX, KML, KMZ and GeoJSON/,
  );
  assert.deepEqual([...bytesFromBase64('data:application/octet-stream;base64,UEsDBA==')], [0x50, 0x4b, 0x03, 0x04]);
});

/** Storage, an App plugin and a settle, as test/native-shell.test.mjs has them. */
function memoryStore() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}
function fakeApp({ launch = '' } = {}) {
  const listeners = {};
  return {
    listeners,
    addListener: (name, fn) => { listeners[name] = fn; },
    getLaunchUrl: async () => (launch ? { url: launch } : undefined),
  };
}
const android = (plugins) => appShell({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: plugins } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opened file: tapping a file in another app lands on the map with it waiting', async () => {
  assert.equal(isFileUrl('content://com.google.android.gm/attachment/1'), true);
  assert.equal(isFileUrl('file:///storage/emulated/0/Download/a.gpx'), true);
  assert.equal(isFileUrl('com.halfstop.app://account#x'), false);

  const App = fakeApp();
  const store = memoryStore();
  const gone = [];
  watchAppLinks({ shell: android({ App }), store, go: (to) => gone.push(to) });
  App.listeners.appUrlOpen({ url: 'content://com.google.android.gm/attachment/1' });
  await settle();
  assert.deepEqual(gone, ['map.html']);
  assert.equal(takeOpenedFile(store), 'content://com.google.android.gm/attachment/1');
  assert.equal(takeOpenedFile(store), '', 'taken once');
});

test('opened file: a file that started the app is opened once, not on every load', async () => {
  const store = memoryStore();
  const gone = [];
  for (let load = 0; load < 3; load += 1) {
    watchAppLinks({ shell: android({ App: fakeApp({ launch: 'content://x/trip.gpx' }) }), store, go: (to) => gone.push(to) });
    await settle();
  }
  assert.deepEqual(gone, ['map.html']);
  // Something that is not a file address never comes back out as one.
  store.setItem(OPEN_FILE_KEY, 'javascript:alert(1)');
  assert.equal(takeOpenedFile(store), '');
});
