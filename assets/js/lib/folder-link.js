/**
 * A folder sent as a link: what goes into one, and how one is read back.
 *
 * The link opens map.html?f=<id> in any browser, where the places are loaded
 * and offered a folder exactly as an imported file is. What it holds is a
 * copy made on the server by create_folder_link() (supabase/schema.sql), for
 * thirty days - not the folder itself, so editing or deleting the folder
 * afterwards changes nothing for whoever has the link.
 */

/** The query parameter a folder link arrives in. */
export const LINK_PARAM = 'f';

/** How long a link opens for, said where people choose one. */
export const LINK_DAYS = 30;

/** At most this many places in one link; create_folder_link() holds the same. */
export const LINK_MAX_PLACES = 2000;

/**
 * The link id in a page's query, or '' when there is none or it is not one.
 *
 * The id is 32 hex characters, and anything else is dropped here rather than
 * sent: the server refuses it either way, and a malformed id is more often a
 * link mangled by a messaging app than anything worth a round trip.
 */
export function readLinkId(params) {
  const value = String(params?.get?.(LINK_PARAM) || '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) ? value : '';
}

/**
 * A folder's places as they go into a link.
 *
 * Photographs are left behind: a pin carries only the ids of pictures kept on
 * the sender's own device, which are nothing on anybody else's. Everything
 * else on a pin - its name, note, colour, symbol - goes, because that is what
 * sending somebody a folder means.
 */
export function linkCollection(geojson) {
  const features = (geojson?.features || []).map((feature) => {
    const { photos, ...properties } = feature?.properties || {};
    return { ...feature, properties };
  });
  return { type: 'FeatureCollection', features };
}

/** The path and query of a folder link, for shareableURL to put a host on. */
export function folderLinkParts(id) {
  return { path: 'map.html', search: `?${LINK_PARAM}=${encodeURIComponent(id)}` };
}

/** "until 3 November", for the line that says how long a link lasts. */
export function linkLastsUntil(expiresAt, locale = undefined) {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return `for ${LINK_DAYS} days`;
  return `until ${date.toLocaleDateString(locale, { day: 'numeric', month: 'long' })}`;
}
