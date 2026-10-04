/**
 * A map file another app handed to this one: what it is, and its bytes.
 *
 * On Android, somebody taps a GPX in Gmail or Messages, chooses Halfstop, and
 * the app is given a `content://` address the other app has lent it. Two
 * things about that address shape this file.
 *
 * It usually says nothing about what the file is. The name, when there is one,
 * is the sending app's business, and a GPX from a messaging app tends to
 * arrive as `application/octet-stream` with a number for a name. So the kind
 * is read from the bytes - a GPX says <gpx near the top, a KML says <kml, a
 * KMZ is a zip, GeoJSON is an object with a type - and the name is only used
 * when it agrees.
 *
 * And it cannot be fetched as it is: the web view has no idea what content://
 * means. Capacitor's own local server does, under a path that
 * `Capacitor.convertFileSrc` builds - the same mechanism the app uses for any
 * file of its own - so no plugin is needed to read one.
 */

export const OPENABLE_KINDS = ['gpx', 'kml', 'kmz', 'geojson'];

/**
 * What a file is, from its first bytes, or '' when it is not a map file this
 * app opens.
 *
 * @param {Uint8Array} bytes
 */
export function sniffMapFile(bytes) {
  if (!bytes?.length) return '';
  // A zip: KMZ is a zipped KML, and nothing else this opens is a zip.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'kmz';

  // Enough of the start to find the root element past an XML declaration, a
  // stylesheet line and a comment or two, without decoding a 40 MB track.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 4096))
    .replace(/^\uFEFF/, '')
    .trimStart();

  if (head.startsWith('{')) {
    return /"type"\s*:\s*"(FeatureCollection|Feature|Point|LineString|Polygon|MultiPoint|MultiLineString|MultiPolygon|GeometryCollection)"/.test(head)
      ? 'geojson' : '';
  }
  if (head.startsWith('<')) {
    // The root element, not any mention: a KML can quote "<gpx" in a
    // description, and the first real element is the one that decides.
    const root = head.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
    const name = /^<(?:[\w-]+:)?([\w-]+)/.exec(root)?.[1]?.toLowerCase() || '';
    if (name === 'gpx') return 'gpx';
    if (name === 'kml') return 'kml';
  }
  return '';
}

/**
 * A name for the file, for the folder it lands in and the messages about it.
 *
 * The last part of the address when it reads as a filename of the same kind;
 * otherwise "Shared file" with the right extension, because the import tells
 * files apart by extension and a GPX called 1234 would be refused.
 */
export function openedFileName(url, kind) {
  let last = '';
  try {
    last = decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || '');
  } catch {
    last = '';
  }
  const extension = kind === 'geojson' ? '(geojson|json)' : kind;
  if (last && new RegExp(`\\.${extension}$`, 'i').test(last) && last.length <= 120) return last;
  return `Shared file.${kind}`;
}

/** Base64 to bytes, for a plugin that answers that way. */
export function bytesFromBase64(base64) {
  const binary = atob(String(base64 || '').replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Read an opened file and make it a File the import already knows.
 *
 * @param {string} url  the content:// or file:// address
 * @param {object} [options]
 * @param {object} [options.capacitor]  globalThis.Capacitor
 * @param {Function} [options.fetch]
 * @returns {Promise<File>}
 * @throws {Error} with a sentence for the person, when it cannot be read or is
 *   not a map file
 */
export async function readOpenedFile(url, { capacitor = globalThis.Capacitor, fetch = globalThis.fetch } = {}) {
  let bytes = null;
  const local = capacitor?.convertFileSrc?.(url);
  if (local && local !== url) {
    try {
      const response = await fetch(local);
      if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      bytes = null;
    }
  }
  // The Filesystem plugin, when a build happens to have it, as a second way
  // in for an address the local server would not serve.
  if (!bytes) {
    const filesystem = capacitor?.Plugins?.Filesystem;
    if (filesystem?.readFile) {
      try {
        const { data } = await filesystem.readFile({ path: url });
        bytes = typeof data === 'string' ? bytesFromBase64(data) : new Uint8Array(await data.arrayBuffer());
      } catch {
        bytes = null;
      }
    }
  }
  if (!bytes) throw new Error('That file could not be read. Try saving it to your phone first, then open it from Files.');

  const kind = sniffMapFile(bytes);
  if (!kind) {
    throw new Error('That is not a map file Halfstop can open. It opens GPX, KML, KMZ and GeoJSON.');
  }
  const types = {
    gpx: 'application/gpx+xml',
    kml: 'application/vnd.google-earth.kml+xml',
    kmz: 'application/vnd.google-earth.kmz',
    geojson: 'application/geo+json',
  };
  return new File([bytes], openedFileName(url, kind), { type: types[kind] });
}
