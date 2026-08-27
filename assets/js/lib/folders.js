/**
 * Folders — the user's own organisation of saved waypoints and tracks.
 *
 * A folder OWNS copies of the features put into it rather than referencing the
 * file they came from. That is the important design decision here: a folder
 * built from an import survives the source file being unloaded, the catalogue
 * changing, or the page being closed. It is the user's collection, not a view
 * over someone else's data.
 *
 * State persists to localStorage. That is per-browser and per-device — it is a
 * working set, not a synced account — and the UI says so.
 */

import { DEFAULT_PIN_ICON } from './pin-icons.js';

const STORAGE_KEY = 'ab-maps-folders-v1';
const NAME_LIMIT = 80;

export const FOLDER_COLORS = [
  '#b4441f', '#1d4ed8', '#15803d', '#a21caf', '#0f766e',
  '#b45309', '#4338ca', '#be123c', '#3f6212', '#0369a1',
];

/** Monotonic id generator; the counter keeps ids unique within a millisecond. */
let idCounter = 0;
function makeId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function clampName(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, NAME_LIMIT) : fallback;
}

/**
 * Strip a feature down to what a folder needs to keep.
 *
 * Imported tracks can carry tens of thousands of timestamps; localStorage has a
 * few megabytes in total. Dropping coordTimes on save keeps a folder of saved
 * points small enough to never be the reason a save fails.
 */
function packFeature(feature, { keepTimes = false } = {}) {
  const props = feature.properties || {};
  const packed = {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      kind: props.kind || 'waypoint',
      name: props.name || 'Untitled',
      description: props.description || '',
      symbol: props.symbol || '',
      type: props.type || '',
      color: props.color || null,
      // Resolved from the source file's <sym>/IconStyle at import time, so a
      // GaiaGPS export arrives already styled rather than as identical dots.
      icon: props.icon || null,
      link: props.link || null,
      // Photo ids only — the images themselves live in IndexedDB (lib/photos.js),
      // because a single phone photo would exhaust the localStorage budget.
      photos: Array.isArray(props.photos) ? props.photos.slice(0, 24) : [],
      // Append-only field notes. What makes a waypoint worth more in year three
      // than year one is the record of what it was like each time you were here.
      log: Array.isArray(props.log) ? props.log.slice(-200) : [],
      time: Number.isFinite(props.time) ? props.time : null,
      sourceName: props.sourceName || props.source || '',
      distance_m: Number.isFinite(props.distance_m) ? props.distance_m : null,
      ascent_m: Number.isFinite(props.ascent_m) ? props.ascent_m : null,
      elevation_max_m: Number.isFinite(props.elevation_max_m) ? props.elevation_max_m : null,
    },
  };
  if (keepTimes && props.coordTimes) packed.properties.coordTimes = props.coordTimes;
  return packed;
}

/** Identity for de-duplication: same name at the same place is the same point. */
function fingerprint(feature) {
  const name = (feature.properties?.name || '').trim().toLowerCase();
  const geometry = feature.geometry;
  let where = '';
  if (geometry?.type === 'Point') {
    where = geometry.coordinates.slice(0, 2).map((n) => Number(n).toFixed(5)).join(',');
  } else {
    const flat = JSON.stringify(geometry?.coordinates ?? '').slice(0, 160);
    where = `${geometry?.type}:${flat.length}:${flat.slice(0, 60)}`;
  }
  return `${name}|${where}`;
}

/* ---------------- trips ---------------- */

/**
 * A trip window, or null.
 *
 * Stored as two ISO dates rather than timestamps: a trip runs from a day to a
 * day, not from an instant to an instant, and a timestamp would shift the
 * dates by a day for anyone who planned a trip in one time zone and drove it
 * in another. Bad input becomes null rather than a folder that renders as
 * "Invalid Date – Invalid Date" and cannot be repaired from the UI.
 */
export function readTrip(trip) {
  if (!trip || typeof trip !== 'object') return null;
  const from = readDay(trip.from);
  const to = readDay(trip.to) || from;
  if (!from) return null;
  // Backwards is a typo, not an intention.
  const window = to < from ? { from: to, to: from } : { from, to };
  // Whether the app has already stood this trip down after its last day. Kept
  // so it happens once: a trip you deliberately switched back on must not be
  // switched off again on the next render.
  window.retired = trip.retired === true;
  return window;
}

const readDay = (value) => {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? text : '';
};

/**
 * Where a trip stands relative to a day: ahead, on, or over.
 *
 * Compared as calendar days, not as instants. "Ends today" has to stay "on"
 * until the day is out — a trip that reads as finished while you are still on
 * it is worse than useless, because the folder it names is the one holding the
 * pins you are driving to.
 */
export function tripStanding(trip, today = new Date()) {
  if (!trip) return null;
  const day = typeof today === 'string' ? today.slice(0, 10) : localDay(today);
  if (day < trip.from) {
    return { state: 'ahead', days: dayGap(day, trip.from) };
  }
  if (day > trip.to) {
    return { state: 'over', days: dayGap(trip.to, day) };
  }
  return { state: 'on', days: dayGap(day, trip.to) };
}

/** Today where the user is, as YYYY-MM-DD — not the UTC day, which can differ. */
export function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayGap = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);


export class FolderStore {
  constructor({ storage = safeStorage(), key = STORAGE_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.folders = [];
    this.listeners = new Set();
    this.lastError = null;
    this.load();
  }

  /* ---------------- persistence ---------------- */

  load() {
    let raw = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) { this.folders = []; return; }

    try {
      const parsed = JSON.parse(raw);
      const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
      this.folders = folders
        .filter((folder) => folder && typeof folder === 'object')
        .map((folder, index) => ({
          id: folder.id || makeId('f'),
          name: clampName(folder.name, `Folder ${index + 1}`),
          color: folder.color || FOLDER_COLORS[index % FOLDER_COLORS.length],
          visible: folder.visible !== false,
          collapsed: folder.collapsed === true,
          created: folder.created || null,
          updatedAt: folder.updatedAt || 0,
          deleted: folder.deleted === true,
          trip: readTrip(folder.trip),
          items: (Array.isArray(folder.items) ? folder.items : [])
            .filter((item) => item?.feature?.geometry)
            .map((item) => ({ id: item.id || makeId('i'), feature: item.feature })),
        }));
    } catch {
      // Corrupt payload: start clean rather than trapping the user in an error.
      this.folders = [];
    }
  }

  save() {
    this.lastError = null;
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify({ version: 1, folders: this.folders }));
      return true;
    } catch (error) {
      // Almost always QuotaExceededError. Report it rather than silently losing
      // work — the in-memory state is still correct for this session.
      this.lastError = error?.name === 'QuotaExceededError'
        ? 'Local storage is full, so this change was not saved for next time. Export a folder and remove some items.'
        : `Could not save folders: ${error.message}`;
      return false;
    }
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @param {string|null} folderId  the folder that changed, stamped as modified
   */
  emit(folderId = null) {
    if (folderId) {
      const folder = this.get(folderId);
      // Sync compares these, so a change that does not move the clock is a
      // change that will not travel.
      if (folder) folder.updatedAt = Date.now();
    }
    this.save();
    for (const listener of this.listeners) listener(this, folderId);
  }

  /** Plain copy of every folder, for the sync merge. */
  snapshot() {
    return this.folders.map((folder) => ({ ...folder, items: folder.items.map((item) => ({ ...item })) }));
  }

  /** Replace the whole set, e.g. with the result of a sync merge. */
  replaceAll(folders) {
    this.folders = folders.map((folder, index) => ({
      id: folder.id || makeId('f'),
      name: clampName(folder.name, `Folder ${index + 1}`),
      color: folder.color || FOLDER_COLORS[index % FOLDER_COLORS.length],
      visible: folder.visible !== false,
      collapsed: folder.collapsed === true,
      created: folder.created || null,
      updatedAt: folder.updatedAt || 0,
      deleted: folder.deleted === true,
      trip: readTrip(folder.trip),
      items: (Array.isArray(folder.items) ? folder.items : [])
        .filter((item) => item?.feature?.geometry)
        .map((item) => ({ id: item.id || makeId('i'), feature: item.feature })),
    })).filter((folder) => !folder.deleted);
    this.save();
    for (const listener of this.listeners) listener(this, null);
  }

  /* ---------------- folders ---------------- */

  list() {
    return this.folders;
  }

  get(id) {
    return this.folders.find((folder) => folder.id === id) || null;
  }

  create(name = 'New folder', { color = null, visible = true, trip = null } = {}) {
    const folder = {
      id: makeId('f'),
      name: clampName(name, `Folder ${this.folders.length + 1}`),
      color: color || FOLDER_COLORS[this.folders.length % FOLDER_COLORS.length],
      visible,
      collapsed: false,
      created: Date.now(),
      updatedAt: Date.now(),
      deleted: false,
      trip: readTrip(trip),
      items: [],
    };
    this.folders.push(folder);
    this.emit();
    return folder;
  }

  /** Find a folder by name, or make one. Used when importing by KML folder path. */
  ensure(name) {
    const wanted = clampName(name, 'Unfiled');
    const existing = this.folders.find((folder) => folder.name.toLowerCase() === wanted.toLowerCase());
    return existing || this.create(wanted);
  }

  /**
   * Give a folder a trip window, or take it away.
   *
   * A trip is a folder with dates on it rather than a separate kind of thing,
   * because everything a trip needs — a name, a colour, pins, visibility,
   * export, sync — a folder already does. Anything else would be a second
   * implementation of all of it for the sake of two dates.
   */
  setTrip(id, trip) {
    const folder = this.get(id);
    if (!folder) return null;
    folder.trip = readTrip(trip);
    this.emit(id);
    return folder;
  }

  rename(id, name) {
    const folder = this.get(id);
    if (!folder) return null;
    folder.name = clampName(name, folder.name);
    this.emit(id);
    return folder;
  }

  update(id, patch) {
    const folder = this.get(id);
    if (!folder) return null;
    if (patch.color) folder.color = patch.color;
    if (typeof patch.visible === 'boolean') folder.visible = patch.visible;
    if (typeof patch.collapsed === 'boolean') folder.collapsed = patch.collapsed;
    this.emit(id);
    return folder;
  }

  /**
   * Delete a folder.
   *
   * Returns a tombstone rather than nothing: sync needs to tell "deleted here"
   * from "never seen on this device", and absence cannot express the
   * difference. Callers push the tombstone so other devices learn about it.
   */
  remove(id) {
    const folder = this.get(id);
    if (!folder) return null;
    this.folders = this.folders.filter((entry) => entry.id !== id);
    const tombstone = { ...folder, items: [], deleted: true, updatedAt: Date.now() };
    this.emit();
    return tombstone;
  }

  /* ---------------- items ---------------- */

  /**
   * Copy features into a folder, skipping ones already there.
   * @returns {{added: number, skipped: number}}
   */
  addFeatures(folderId, features, { keepTimes = false } = {}) {
    const folder = this.get(folderId);
    if (!folder) return { added: 0, skipped: 0 };

    const seen = new Set(folder.items.map((item) => fingerprint(item.feature)));
    let added = 0;
    let skipped = 0;

    for (const feature of features) {
      if (!feature?.geometry) { skipped++; continue; }
      const packed = packFeature(feature, { keepTimes });
      const print = fingerprint(packed);
      if (seen.has(print)) { skipped++; continue; }
      seen.add(print);
      folder.items.push({ id: makeId('i'), feature: packed });
      added++;
    }

    if (added) this.emit(folderId);
    return { added, skipped };
  }

  removeItem(folderId, itemId) {
    const folder = this.get(folderId);
    if (!folder) return;
    const before = folder.items.length;
    folder.items = folder.items.filter((item) => item.id !== itemId);
    if (folder.items.length !== before) this.emit(folderId);
  }

  moveItem(itemId, fromFolderId, toFolderId) {
    if (fromFolderId === toFolderId) return false;
    const from = this.get(fromFolderId);
    const to = this.get(toFolderId);
    if (!from || !to) return false;

    const index = from.items.findIndex((item) => item.id === itemId);
    if (index === -1) return false;
    const [item] = from.items.splice(index, 1);

    // Do not create a duplicate if the destination already holds the same point.
    const print = fingerprint(item.feature);
    if (!to.items.some((existing) => fingerprint(existing.feature) === print)) to.items.push(item);
    // A move changes both folders, so both need their clock moved or sync will
    // carry only half of it.
    this.emit(fromFolderId);
    this.emit(toFolderId);
    return true;
  }

  /**
   * Apply a style to specific items, or to every item in the folder.
   *
   * @param {string} folderId
   * @param {object} style        { color?: string|null, icon?: string|null }
   * @param {string[]|null} itemIds  null applies to the whole folder
   * @returns {number} how many items changed
   */
  styleItems(folderId, style, itemIds = null) {
    const folder = this.get(folderId);
    if (!folder) return 0;
    const wanted = itemIds ? new Set(itemIds) : null;
    let changed = 0;

    for (const item of folder.items) {
      if (wanted && !wanted.has(item.id)) continue;
      const props = item.feature.properties;
      let touched = false;
      if ('color' in style && props.color !== style.color) { props.color = style.color; touched = true; }
      if ('icon' in style && props.icon !== style.icon) { props.icon = style.icon; touched = true; }
      if (touched) changed++;
    }

    if (changed) this.emit(folderId);
    return changed;
  }

  /** Clear per-item overrides so items fall back to the folder's own colour. */
  clearItemStyles(folderId, itemIds = null) {
    return this.styleItems(folderId, { color: null, icon: null }, itemIds);
  }

  /** Edit a saved item's notes. */
  describeItem(folderId, itemId, description) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item) return false;
    const text = String(description ?? '').trim().slice(0, 4000);
    if (item.feature.properties.description === text) return false;
    item.feature.properties.description = text;
    this.emit(folderId);
    return true;
  }

  /**
   * Append a dated note to a pin.
   *
   * Append-only on purpose: "gate locked 3/24" and "gate open 9/25" are both
   * true, and overwriting the first loses the fact that it changed.
   */
  addNote(folderId, itemId, text, at = Date.now()) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    const body = String(text ?? '').trim().slice(0, 2000);
    if (!item || !body) return null;

    const note = { id: makeId('n'), at, text: body };
    item.feature.properties.log = [...(item.feature.properties.log || []), note].slice(-200);
    this.emit(folderId);
    return note;
  }

  removeNote(folderId, itemId, noteId) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item) return false;
    const before = (item.feature.properties.log || []).length;
    item.feature.properties.log = (item.feature.properties.log || []).filter((note) => note.id !== noteId);
    if (item.feature.properties.log.length === before) return false;
    this.emit(folderId);
    return true;
  }

  /** Attach stored photo ids to an item. */
  addPhotos(folderId, itemId, photos) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item || !photos.length) return 0;
    const existing = item.feature.properties.photos || [];
    const seen = new Set(existing.map((photo) => photo.id));
    const fresh = photos.filter((photo) => photo?.id && !seen.has(photo.id));
    if (!fresh.length) return 0;
    item.feature.properties.photos = [...existing, ...fresh].slice(0, 24);
    this.emit(folderId);
    return fresh.length;
  }

  removePhoto(folderId, itemId, photoId) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item) return false;
    const before = (item.feature.properties.photos || []).length;
    item.feature.properties.photos = (item.feature.properties.photos || []).filter((p) => p.id !== photoId);
    if (item.feature.properties.photos.length === before) return false;
    this.emit(folderId);
    return true;
  }

  /** Every photo id referenced anywhere, for pruning orphans from IndexedDB. */
  referencedPhotoIds() {
    const ids = [];
    for (const folder of this.folders) {
      for (const item of folder.items) {
        for (const photo of item.feature.properties.photos || []) if (photo?.id) ids.push(photo.id);
      }
    }
    return ids;
  }

  renameItem(folderId, itemId, name) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item) return false;
    item.feature.properties.name = clampName(name, item.feature.properties.name);
    this.emit(folderId);
    return true;
  }

  /**
   * Edit a pin's own text: what it is called and what you wrote about it.
   *
   * Separate from `styleItems`, which is about colour and icon. This is the
   * part you change standing at the spot — a name that was "Waypoint 214" when
   * it came out of the GPS, and a note about where the pull-off actually is.
   *
   * @returns {boolean} whether an item was found and changed.
   */
  editItem(folderId, itemId, { name, description } = {}) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item) return false;

    const props = item.feature.properties;
    if (name !== undefined) props.name = clampName(name, props.name);
    // An emptied description is a deletion, not a no-op — but undefined means
    // "not editing this field", which is a different thing entirely.
    if (description !== undefined) {
      const text = String(description).trim().slice(0, 4000);
      if (text) props.description = text;
      else delete props.description;
    }

    this.emit(folderId);
    return true;
  }

  /* ---------------- reads ---------------- */

  /** All items across every folder, each tagged with its folder for rendering. */
  toGeoJSON({ visibleOnly = true } = {}) {
    const features = [];
    for (const folder of this.folders) {
      if (visibleOnly && !folder.visible) continue;
      for (const item of folder.items) {
        features.push({
          ...item.feature,
          id: item.id,
          properties: {
            ...item.feature.properties,
            folderId: folder.id,
            folderName: folder.name,
            folderColor: folder.color,
            itemId: item.id,
            // Per-item overrides win; otherwise inherit the folder's styling.
            pinColor: item.feature.properties.color || folder.color,
            pinIcon: item.feature.properties.icon || DEFAULT_PIN_ICON,
          },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  folderGeoJSON(id) {
    const folder = this.get(id);
    if (!folder) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: folder.items.map((item) => ({ ...item.feature, id: item.id })),
    };
  }

  counts(folder) {
    let waypoints = 0;
    let tracks = 0;
    for (const item of folder.items) {
      if (item.feature.properties.kind === 'waypoint') waypoints++;
      else tracks++;
    }
    return { waypoints, tracks, total: folder.items.length };
  }

  totals() {
    return this.folders.reduce((sum, folder) => {
      const counts = this.counts(folder);
      return {
        folders: sum.folders + 1,
        waypoints: sum.waypoints + counts.waypoints,
        tracks: sum.tracks + counts.tracks,
      };
    }, { folders: 0, waypoints: 0, tracks: 0 });
  }
}

/** localStorage access that tolerates private mode and disabled site data. */
export function safeStorage() {
  try {
    const probe = '__ab_maps_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

export { packFeature, fingerprint };
