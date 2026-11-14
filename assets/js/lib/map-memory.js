/**
 * The map you were last on: which basemap, and which layers.
 *
 * They lived only in the address bar, so opening the site from a bookmark,
 * or the iPhone app - which starts from a bare address every time - put the
 * default basemap back. Reported as "if I am using Byways Topo (Mapbox), it
 * should open on that every time, or whatever the last map was for my
 * account".
 *
 * So the choice is kept twice. On the device, where it is read before the
 * map is built - the basemap decides which map library loads, so it cannot
 * wait for the network. And on the account (Account.mapPrefs), so a phone
 * signed in to the same account follows a choice made on the laptop. Each
 * copy carries when it was made, and the newer one wins.
 *
 * A link that names a basemap or layers still wins for that visit: somebody
 * who sends a view sends the map it was on.
 *
 * Pure: the viewer does the reading, writing and switching.
 */

/** Where the device's copy lives, under the viewer's own `ab-maps-` prefix. */
export const MAP_MEMORY_KEY = 'map';

/** A saved map from storage text, or null when there is none worth trusting. */
export function parseMapMemory(text) {
  try {
    const saved = JSON.parse(text || 'null');
    if (!saved || typeof saved.basemap !== 'string' || !saved.basemap) return null;
    return {
      basemap: saved.basemap,
      overlays: Array.isArray(saved.overlays) ? saved.overlays.filter((id) => typeof id === 'string') : [],
      at: typeof saved.at === 'string' ? saved.at : '',
    };
  } catch {
    return null;
  }
}

/** The same basemap and the same layers, in any order. */
export function sameMap(a, b) {
  if (!a || !b) return false;
  const layers = (map) => [...new Set(map.overlays || [])].sort().join('\n');
  return a.basemap === b.basemap && layers(a) === layers(b);
}

const when = (map) => Date.parse(map?.at || '') || 0;

/**
 * The basemap to build the map with.
 *
 * The link's, then the remembered one, then the default - each only if this
 * deployment has it (`usable`): a remembered Mapbox basemap on a build with
 * no Mapbox token would be a blank map.
 */
export function startingBasemap({ link = '', memory = null, usable = () => true, fallback }) {
  if (link) return link;
  if (memory?.basemap && usable(memory.basemap)) return memory.basemap;
  return fallback;
}

/**
 * What to do with the account's copy once the account is known.
 *
 *   'adopt'  the account's is newer: switch to it, and keep it here
 *   'push'   this device's is newer, or the account has none: send it up
 *   'none'   they agree, or there is nothing to say
 *
 * A map opened from a link is never replaced by the account's: the link is
 * what the reader asked to see.
 */
export function mapSync({ mine = null, theirs = null, fromLink = false } = {}) {
  if (sameMap(mine, theirs)) return 'none';
  if (theirs && when(theirs) > when(mine)) return fromLink ? 'none' : 'adopt';
  // Strictly newer, or nothing there: two copies of one choice that differ -
  // a basemap this build cannot draw, kept at the account's time - stay as
  // they are rather than overwriting each other.
  if (mine && (!theirs || when(mine) > when(theirs))) return 'push';
  return 'none';
}

/**
 * Whether the map on screen is a choice worth keeping.
 *
 * Not the map a device opened on with nothing remembered, nor one a link
 * opened: neither was chosen here, and keeping it would stamp it newer than
 * the account's - so a phone's first visit would overwrite the map picked on
 * the laptop. Anything changed from the start is a choice, and so is any
 * change on a device that already remembers one.
 */
export function worthKeeping({ now, saved = null, atStart = null, fromLink = false }) {
  if (sameMap(now, saved)) return false;
  if (sameMap(now, atStart) && (!saved || fromLink)) return false;
  return true;
}
