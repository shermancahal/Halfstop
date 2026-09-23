/**
 * Links that leave the device.
 *
 * Both halves of this are pure, and both are here rather than in viewer.js for
 * the same reason: one decides whether a link works at all for the person it
 * is sent to, and the other reads a coordinate written by somebody else's
 * device. Neither is a thing to find out about in the field.
 */

/**
 * Where a link is useless to whoever receives it.
 *
 * Both shells serve the app from the device itself, and they do not agree on
 * how. iOS uses `capacitor://localhost`, which a scheme check catches. Android
 * uses `https://localhost` - Capacitor's own default, and the value in
 * capacitor.config.json - which a scheme check waves straight through, because
 * it is a perfectly good https URL. It is just a https URL naming the phone it
 * was copied from.
 *
 * So the host is checked as well as the scheme. This was found by asking what
 * Share would do in an Android build before there was one: it produced
 * `https://localhost/map.html?...`, which is the exact failure the paragraph
 * below describes and the exact one the scheme check was written to prevent.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

function reachable(href) {
  try {
    return !LOOPBACK.test(new URL(href).hostname);
  } catch {
    // Not a URL this can read is not a URL to build a share link on.
    return false;
  }
}

/**
 * A link somebody else can open, whatever this is running inside.
 *
 * In a browser that is the address bar. In the app it is not: the shell runs
 * on the phone, and a link to that opens nothing on anybody else's - no error,
 * no clue, just a tap that does nothing. So anything not served from an origin
 * somebody else can reach is rebuilt against the site's published URL, keeping
 * the query and the hash, which is where the view actually lives.
 *
 * The running origin is preferred when there is one, so a link copied from a
 * preview build still points at the preview rather than at production.
 */
export function shareableURL({ href, protocol, site, path = 'map.html', search = '', hash = '' }) {
  const live = (protocol === 'https:' || protocol === 'http:') && reachable(href);
  const url = new URL(path, live ? href : site);
  url.search = search || '';
  url.hash = hash || '';
  return url.href;
}

/**
 * A pin out of a link: `p=lat,lon`, with an optional `pn=name`.
 *
 * Checked rather than trusted. This is the one value the app reads that was
 * written on another person's device, and a coordinate off the globe would
 * move the map somewhere it cannot draw and leave it there.
 */
export function readSharedPin(params) {
  const raw = String(params.get('p') || '').split(',');
  if (raw.length !== 2) return null;
  const lat = Number(raw[0]);
  const lon = Number(raw[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = String(params.get('pn') || '').trim().slice(0, 80);
  return { lon, lat, name };
}

/**
 * Does this link already say where to look?
 *
 * The map keeps the camera in the hash, so a link that carries one is either
 * somebody's shared view or your own reload of a map you had already moved.
 * Either way the view was chosen, and anything that would move the camera on
 * arrival has to stand down for it - which is the whole reason this is a
 * function rather than a truthiness check on location.hash, where a `#photos`
 * or an empty `#` would read as a view and silently disable the thing that
 * checks it.
 */
export function linkCarriesView(hash) {
  const text = String(hash || '').replace(/^#/, '');
  if (!text) return false;
  return new URLSearchParams(text).has('view');
}

/** The query and hash that carry one place, for the link that opens on it. */
export function pinLinkParts({ lon, lat, name = '' }) {
  const params = new URLSearchParams();
  params.set('p', `${lat.toFixed(6)},${lon.toFixed(6)}`);
  const trimmed = String(name).trim();
  if (trimmed) params.set('pn', trimmed.slice(0, 80));
  return {
    search: `?${params}`,
    hash: `#view=14/${lat.toFixed(5)}/${lon.toFixed(5)}`,
  };
}
