/**
 * Links that leave the device.
 *
 * Both halves of this are pure, and both are here rather than in viewer.js for
 * the same reason: one decides whether a link works at all for the person it
 * is sent to, and the other reads a coordinate written by somebody else's
 * device. Neither is a thing to find out about in the field.
 */

/**
 * A link somebody else can open, whatever this is running inside.
 *
 * In a browser that is the address bar. In the app it is not: the shell runs
 * at capacitor://localhost, and a link to that opens nothing on anybody's
 * phone - no error, no clue, just a tap that does nothing. So anything not
 * served over http(s) is rebuilt against the site's published URL, keeping the
 * query and the hash, which is where the view actually lives.
 *
 * The running origin is preferred when there is one, so a link copied from a
 * preview build still points at the preview rather than at production.
 */
export function shareableURL({ href, protocol, site, path = 'map.html', search = '', hash = '' }) {
  const live = protocol === 'https:' || protocol === 'http:';
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
