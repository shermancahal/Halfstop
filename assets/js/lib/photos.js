/**
 * Photo storage for saved pins.
 *
 * Photos live in IndexedDB, not localStorage. localStorage holds a few
 * megabytes of *strings* — one phone photo base64-encoded would eat most of the
 * budget and take the folders down with it when the quota blew. IndexedDB
 * stores Blobs natively, has orders of magnitude more room, and keeps the
 * folder JSON small: a pin records only photo ids.
 *
 * Like folders, this is per-browser and per-device until sync exists.
 *
 * NOTHING IS STORED AT THE SIZE IT ARRIVED
 *
 * Every photograph goes through lib/photo-encode.js on the way in: fitted
 * inside 1024 on the long edge and squeezed under 100 KB. A phone picture is
 * three to six megabytes, and twenty of those on one trip is a hundred
 * megabytes sitting in a browser to be drawn at 80 pixels a side. The shrink
 * is in here rather than at the call sites so that it cannot be skipped by a
 * new one that forgets - which is exactly how the map snapshot and the linked
 * photo importer came to store full frames.
 */

import { shrinkToBudget } from './photo-encode.js';

const DB_NAME = 'ab-maps-photos';
const DB_VERSION = 1;
const STORE = 'photos';

/**
 * Image types every browser this runs in can show as they are.
 *
 * Anything else that is an image - HEIC from an iPhone or a Samsung, TIFF,
 * BMP - is still welcome, but only if this browser can read it, because it is
 * converted on the way in (see putPhoto) and never stored as it came.
 */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** HEIC and HEIF: what iPhones shoot, and Samsungs on "high efficiency". */
const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

/** Whether a file is HEIC or HEIF, by its type or, where that is blank, its name. */
export function isHeic(type = '', name = '') {
  return HEIC_TYPES.includes(String(type).toLowerCase()) || /\.(heic|heif)$/i.test(String(name));
}

/**
 * Whether a file is worth trying to read as a photo at all.
 *
 * The shown-as-is types, anything else that says it is an image, and a HEIC
 * whose type the system left blank - which Chrome on Windows does.
 */
export function mayBePhoto(type = '', name = '') {
  return PHOTO_TYPES.includes(type) || /^image\//i.test(String(type)) || isHeic(type, name);
}

/**
 * What the photo picker asks the system for.
 *
 * On an iPhone or iPad, exactly the shown-as-is types and nothing else. That
 * is not a restriction: asked for those, iOS converts a HEIC to JPEG as it is
 * picked, which works on every iOS version - and listing HEIC, or `image/*`,
 * would turn that conversion off and hand over the HEIC instead.
 *
 * Everywhere else, any image, and HEIC by name for the desktop pickers that do
 * not count it as one. Whether it can be read is found out by trying.
 */
export function photoAccept({ userAgent = '', touchMac = false } = {}) {
  if (touchMac || /\b(iPhone|iPad|iPod)\b/i.test(userAgent)) return PHOTO_TYPES.join(',');
  return 'image/*,.heic,.heif';
}

/**
 * The sentence for a photo this browser could not read, by what it was.
 */
export function unreadablePhoto(name = '', type = '') {
  const what = name ? `\u201c${name}\u201d` : 'That photo';
  if (isHeic(type, name)) {
    return `${what} is a HEIC photo, which this browser cannot read. Safari can, and an iPhone converts it `
      + 'to JPEG by itself when you add it from there. Otherwise, save it as a JPEG first - on a Mac, '
      + 'Photos then File, Export - or, on a Samsung, turn off High efficiency pictures in the camera\u2019s '
      + 'settings for the photos you take next.';
  }
  if (/raw|dng|x-canon|x-nikon|x-sony|x-fuji|x-panasonic|x-olympus/i.test(type) || /\.(dng|cr2|cr3|nef|arw|raf|rw2|orf)$/i.test(name)) {
    return `${what} is a RAW file, which no browser can read. Export it as a JPEG and add that.`;
  }
  return `${what} could not be read as a photo. JPEG, PNG, WebP, GIF and AVIF always work.`;
}
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so photos cannot be stored.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the photo store.'));
  });
  return dbPromise;
}

function transact(mode, run) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The photo store transaction was aborted.'));
  }));
}

let counter = 0;
function makeId() {
  counter += 1;
  return `p_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Store an image, shrunk to something worth keeping on a phone.
 *
 * @param {Blob} blob
 * @param {object} meta  { name, source, caption }
 * @param {object} options
 * @param {boolean} options.shrink  false only for a caller that has already
 *        sized its own image; everything from a camera or a file picker wants
 *        the default.
 * @returns {Promise<object>} the stored record, without its blob
 */
export async function putPhoto(blob, meta = {}, { shrink = true } = {}) {
  if (!(blob instanceof Blob)) throw new Error('Not an image.');
  if (!mayBePhoto(blob.type, meta.name)) {
    throw new Error(unreadablePhoto(meta.name, blob.type));
  }
  /*
   * A type that cannot be shown as it is - HEIC, TIFF, BMP - has to come
   * through the converter or not at all. Kept as it came, it would be a
   * photo nobody could see on another browser, or on this one.
   */
  const mustConvert = !PHOTO_TYPES.includes(blob.type);
  /*
   * The ceiling is on what arrives, not on what is kept.
   *
   * It is a guard against decoding something absurd - a 200 MP panorama will
   * exhaust the tab before the canvas is even sized - rather than a storage
   * limit, because after the shrink below nothing reaches storage at more than
   * about a tenth of a megabyte.
   */
  if (blob.size > MAX_PHOTO_BYTES) {
    throw new Error(`${meta.name || 'That image'} is ${(blob.size / 1048576).toFixed(1)} MB; the limit is ${MAX_PHOTO_BYTES / 1048576} MB.`);
  }

  let kept = blob;
  let width = null;
  let height = null;

  if (shrink || mustConvert) {
    try {
      const shrunk = await shrinkToBudget(blob);
      kept = shrunk.blob;
      width = shrunk.width;
      height = shrunk.height;
    } catch (error) {
      if (mustConvert) throw new Error(unreadablePhoto(meta.name, blob.type));
      /*
       * Stored as it came rather than refused.
       *
       * A browser too old to encode WebP or JPEG from a canvas, or an image it
       * can read but not draw, should cost somebody a larger file - not their
       * photograph. The console says what happened; the person does not need
       * to hear about an encoder.
       */
      console.warn('[photos] could not shrink, storing as-is:', error?.message || error);
    }
  }

  const record = {
    id: makeId(),
    blob: kept,
    name: meta.name || '',
    caption: meta.caption || '',
    source: meta.source || 'device',
    type: kept.type,
    bytes: kept.size,
    // What it weighed before, so the interface can say what it saved and a
    // support question about disk use has an answer.
    original: blob.size,
    width,
    height,
    added: Date.now(),
  };
  await transact('readwrite', (store) => store.put(record));
  const { blob: _omit, ...summary } = record;
  return summary;
}

export async function getPhoto(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/** Object URL for a stored photo, or null. Callers must revoke when done. */
export async function photoURL(id) {
  const record = await getPhoto(id);
  return record?.blob ? URL.createObjectURL(record.blob) : null;
}

export async function deletePhoto(id) {
  await transact('readwrite', (store) => store.delete(id));
}

export async function deletePhotos(ids = []) {
  if (!ids.length) return;
  await transact('readwrite', (store) => { for (const id of ids) store.delete(id); });
}

/** Every stored id, for reconciling against what folders still reference. */
export async function allPhotoIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete photos no folder points at any more.
 *
 * Removing a pin cannot reliably clean up its photos at the moment it happens —
 * the same photo may be referenced elsewhere, and a failed write would orphan
 * it anyway. Sweeping is simpler and cannot lose a photo still in use.
 */
export async function pruneUnreferenced(referencedIds) {
  const keep = new Set(referencedIds);
  const stored = await allRecords();
  /*
   * A saved map picture belongs to nobody, and that is not the same as being
   * an orphan.
   *
   * Every other image in here hangs off a pin: remove the pin and the image
   * has no reason to exist, which is what this sweep is for. A picture of the
   * map was saved on its own, references nothing and is referenced by nothing,
   * so the rule "delete what no folder points at" describes it exactly — and
   * would take somebody's photograph of where they were standing.
   */
  const orphans = stored
    .filter((record) => record.source !== SNAPSHOT_SOURCE && !keep.has(record.id))
    .map((record) => record.id);
  await deletePhotos(orphans);
  return orphans.length;
}

/** How a picture of the map is marked, so the sweep above leaves it alone. */
export const SNAPSHOT_SOURCE = 'map-snapshot';

/** Every stored record without its blob, newest first. */
async function allRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result || []).map(({ blob: _omit, ...rest }) => rest));
    request.onerror = () => reject(request.error);
  });
}

/** The saved pictures of the map, newest first. */
export async function listSnapshots() {
  const records = await allRecords();
  return records
    .filter((record) => record.source === SNAPSHOT_SOURCE)
    .sort((a, b) => (b.added || 0) - (a.added || 0));
}

/** Rough usage, for showing how much room photos are taking. */
export async function photoUsage() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => {
      const records = request.result || [];
      resolve({ count: records.length, bytes: records.reduce((sum, r) => sum + (r.bytes || 0), 0) });
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Try to fetch a photo the source file linked to, and store it.
 *
 * This usually fails for GaiaGPS links, and the reason is worth stating plainly:
 * the browser will not let one site read another site's images unless that site
 * opts in with CORS headers, and Gaia does not. The request is still worth
 * attempting — some exporters link to permissive hosts — but the failure is
 * reported honestly rather than swallowed.
 *
 * @returns {Promise<{ok: boolean, photo?: object, reason?: string}>}
 */
export async function fetchLinkedPhoto(url, meta = {}) {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, reason: 'not a web link' };
  let response;
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    return { ok: false, reason: 'blocked by the other site (no CORS permission)' };
  }
  if (!response.ok) return { ok: false, reason: `the server answered HTTP ${response.status}` };

  const blob = await response.blob();
  if (!PHOTO_TYPES.includes(blob.type)) {
    return { ok: false, reason: `the link returned ${blob.type || 'no image type'}` };
  }
  try {
    const photo = await putPhoto(blob, { ...meta, source: 'link' });
    return { ok: true, photo };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
