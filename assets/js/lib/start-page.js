/**
 * Opening straight onto the map, where it was left.
 *
 * The app starts on the home page every time - Capacitor loads index.html -
 * and the map opens from a bare address, so it centres on the reader rather
 * than on the place they were scouting. Asked for as "a checkbox in settings
 * so they can skip the splash screen and go straight to the map to where they
 * were last at".
 *
 * So one choice in the gear, kept on this device, does two things:
 *
 *   - a bare launch of the home page goes on to the map before it is drawn
 *     (the few lines in index.html that do this cannot import a module, so
 *     they repeat OPENS_ON_MAP_KEY and LAUNCH_KEY by hand - a test holds the
 *     two together);
 *   - and the map opens where it was last looking, kept as it moves.
 *
 * Off, nothing is kept and the map centres on the reader as it always has.
 * On this device only: where the phone was looking is not where the laptop
 * should open, and the home page has to decide before any account is known.
 *
 * A link still wins. A shared view, a pin, a folder or a file decides where
 * the map goes; this is only for opening it with nothing asked.
 */

/** '1' when this device opens on the map. Under the viewer's `ab-maps-` prefix. */
export const OPENS_ON_MAP_KEY = 'ab-maps-open-on-map';

/** Where the map was last looking, kept only while the choice above is on. */
export const CAMERA_KEY = 'ab-maps-camera';

/**
 * Set in sessionStorage by the first page of a visit, so the home page knows
 * it is being reached rather than launched: the brand link, Back, a reload.
 */
export const LAUNCH_KEY = 'halfstop-opened';

/**
 * This device's localStorage, or null. Reaching for it can throw - Safari with
 * site data blocked - and a throw at module scope would take the map with it.
 */
export function deviceStorage(g = globalThis) {
  try { return g?.localStorage || null; } catch { return null; }
}

const read = (storage, key) => {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
};
const write = (storage, key, value) => {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Storage refused: the choice lasts as long as this page does.
  }
};

/** Whether this device opens straight onto the map. */
export function opensOnMap(storage) {
  return read(storage, OPENS_ON_MAP_KEY) === '1';
}

const round = (value, places) => Number(value.toFixed(places));

/**
 * A camera as kept: five decimal places is about a metre, which is closer
 * than anybody needs to be put back.
 */
export function cameraText({ center, zoom, bearing = 0, pitch = 0 } = {}) {
  const lon = Array.isArray(center) ? center[0] : center?.lng;
  const lat = Array.isArray(center) ? center[1] : center?.lat;
  const camera = parseCamera(JSON.stringify({ center: [lon, lat], zoom, bearing, pitch }));
  if (!camera) return null;
  return JSON.stringify({
    center: [round(camera.center[0], 5), round(camera.center[1], 5)],
    zoom: round(camera.zoom, 2),
    bearing: round(camera.bearing, 1),
    pitch: round(camera.pitch, 1),
  });
}

/** A kept camera, or null for anything that would put the map nowhere. */
export function parseCamera(text) {
  try {
    const saved = JSON.parse(text || 'null');
    const [lon, lat] = Array.isArray(saved?.center) ? saved.center : [];
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    if (![lon, lat, saved.zoom].every(finite)) return null;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90 || saved.zoom < 0 || saved.zoom > 24) return null;
    return {
      center: [lon, lat],
      zoom: saved.zoom,
      bearing: finite(saved.bearing) ? saved.bearing : 0,
      pitch: finite(saved.pitch) ? Math.min(Math.max(saved.pitch, 0), 85) : 0,
    };
  } catch {
    return null;
  }
}

/** Where to open the map, when this device opens on it and has somewhere kept. */
export function resumeCamera(storage) {
  return opensOnMap(storage) ? parseCamera(read(storage, CAMERA_KEY)) : null;
}

/** Keep where the map is looking - only while this device opens on the map. */
export function keepCamera(storage, camera) {
  if (!opensOnMap(storage)) return false;
  const text = cameraText(camera);
  if (text) write(storage, CAMERA_KEY, text);
  return Boolean(text);
}

/**
 * Turn the choice on or off. On, with the map open, keeps where it is looking
 * now, so the next launch goes back there rather than waiting for a move. Off
 * forgets the place as well as the choice.
 */
export function setOpensOnMap(storage, on, camera = null) {
  write(storage, OPENS_ON_MAP_KEY, on ? '1' : null);
  if (!on) write(storage, CAMERA_KEY, null);
  else if (camera) keepCamera(storage, camera);
}

/**
 * Whether the home page should go on to the map. The same rule as the script
 * at the top of index.html, which is what runs: this copy is what is tested.
 *
 * Only a launch: the first page of a visit, with nothing in the address and
 * not reached from another page of this site. Otherwise the brand link on the
 * map - the one way back to the home page - would bounce straight back.
 */
export function skipsHome({ on, search = '', hash = '', referrer = '', origin = '', launched = false }) {
  if (!on || launched || search || hash) return false;
  try {
    if (referrer && new URL(referrer).origin === origin) return false;
  } catch {
    // A referrer that is not a URL came from nowhere this site knows.
  }
  return true;
}

/**
 * The gear's row: two words rather than a checkbox, the shape of every other
 * row in that menu. `camera` is the map's position now, on the map page only.
 */
export function startRow({ storage = null, camera = () => null } = {}) {
  const store = () => storage || deviceStorage();
  return {
    label: 'Opens on',
    options: [
      { value: 'home', label: 'Home', title: 'Open on the home page' },
      { value: 'map', label: 'Map', title: 'Open straight to the map, where you left off' },
    ],
    read: () => (opensOnMap(store()) ? 'map' : 'home'),
    write: (value) => setOpensOnMap(store(), value === 'map', value === 'map' ? camera() : null),
  };
}
