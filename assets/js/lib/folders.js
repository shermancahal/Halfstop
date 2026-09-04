/**
 * Folders — the user's own organisation of saved waypoints and tracks.
 *
 * A folder OWNS copies of the features put into it rather than referencing the
 * file they came from. That is the important design decision here: a folder
 * built from an import survives the source file being unloaded, the catalogue
 * changing, or the page being closed. It is the user's collection, not a view
 * over someone else's data.
 *
 * State persists to IndexedDB, with localStorage as the fallback for a browser
 * that has no IndexedDB and as the place older versions left their data. Either
 * way it is per-browser and per-device — a working set, not a synced account —
 * and the UI says so.
 *
 * It began in localStorage alone, and that is a few megabytes of *string* for
 * the whole collection: fifty saved tracks is enough to fill it, and once it is
 * full every later change is refused, including opening a folder. IndexedDB has
 * orders of magnitude more room and stores structured values without a JSON
 * round trip, so the ceiling stops being one a person can reach by using the
 * app as intended.
 */

import { DEFAULT_PIN_ICON, pinColorFor, iconForPin } from './pin-icons.js';
import { simplify } from './geo.js';

const STORAGE_KEY = 'ab-maps-folders-v1';
const VAULT_DB = 'ab-maps-folders';
const VAULT_STORE = 'state';
const NAME_LIMIT = 80;

/**
 * The colours a folder or a pin can wear.
 *
 * Eighteen, bold, and spread around the wheel, because the whole point of
 * colouring a pin is to tell it apart from the one beside it at a glance on a
 * busy map. Muted variations of one hue would be a palette that looks
 * considered and works badly.
 *
 * Six of them are GaiaGPS's own, to the exact hex: its red, yellow, green,
 * sky, blue and brown. That is not deference to another app - it is so that a
 * pin imported from Gaia lands on a swatch rather than beside one, and opening
 * it shows the colour it has rather than nothing selected.
 */
export const FOLDER_COLORS = [
  '#f42410', '#b4441f', '#e8590c', '#f59f00', '#ffef00', '#94c11f',
  '#4abd32', '#15803d', '#0f766e', '#0479ff', '#0369a1', '#2d3fc7',
  '#06b6d4', '#7e22ce', '#a21caf', '#9f1239', '#ec4899', '#784d3e',
];

/**
 * What to call each of them.
 *
 * A table needs a word for a colour: a row of eighteen identical circles is
 * not a menu anybody can use, and "#9f1239" is not a word. These are the
 * ordinary names, not paint-chart names - somebody looking for the red one
 * should find "Red".
 */
export const COLOR_NAMES = {
  '#f42410': 'Red',
  '#b4441f': 'Rust',
  '#e8590c': 'Orange',
  '#f59f00': 'Amber',
  '#ffef00': 'Yellow',
  '#94c11f': 'Lime',
  '#4abd32': 'Green',
  '#15803d': 'Forest',
  '#0f766e': 'Teal',
  '#0479ff': 'Sky',
  '#0369a1': 'Deep blue',
  '#2d3fc7': 'Blue',
  '#06b6d4': 'Cyan',
  '#7e22ce': 'Purple',
  '#a21caf': 'Magenta',
  '#9f1239': 'Deep rose',
  '#ec4899': 'Pink',
  '#784d3e': 'Brown',
};

/** How far apart two colours are, as a plain squared distance in RGB. */
const colorGap = (a, b) => ((a >> 16) - (b >> 16)) ** 2
  + (((a >> 8) & 255) - ((b >> 8) & 255)) ** 2
  + ((a & 255) - (b & 255)) ** 2;

/** "#abc" and "#aabbcc" alike, as a number, or null if it is neither. */
export function readColor(value) {
  const hex = String(value ?? '').trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  return /^[0-9a-f]{6}$/i.test(full) ? parseInt(full, 16) : null;
}

/**
 * The palette colour closest to the one given, or null for a colour this
 * cannot read.
 *
 * Squared RGB distance, which is not how eyes work - but the palette is
 * eighteen colours far apart from each other, and for "which of these
 * eighteen is that Gaia brown" it lands on the answer a person would pick.
 * Somewhere it would matter, this would need to be Lab.
 */
export function nearestColor(value, palette = FOLDER_COLORS) {
  const target = readColor(value);
  if (target === null) return null;
  let best = null;
  for (const entry of palette) {
    const gap = colorGap(target, readColor(entry));
    if (!best || gap < best.gap) best = { entry, gap };
  }
  return best ? best.entry : null;
}

/** Whether a colour is one of the palette's, however it was spelled. */
export function inPalette(value, palette = FOLDER_COLORS) {
  const target = readColor(value);
  return target !== null && palette.some((entry) => readColor(entry) === target);
}

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
 * Imported tracks can carry tens of thousands of timestamps, and one per point
 * is the largest thing a track holds. Dropping coordTimes on save keeps a
 * folder of saved points small, which matters for what has to be read back,
 * written out and pushed to sync, not only for what it costs on disk.
 */
/**
 * The most points a stored track keeps.
 *
 * A folder travels as one row - to storage, to a GPX export, over sync - and a
 * day's GPS log is twenty thousand points. Two thousand draws the same line at
 * every zoom a phone shows; what is lost is the jitter. The elevation on each
 * kept point survives, because simplification chooses points rather than
 * inventing them.
 */
export const TRACK_POINT_CAP = 2000;

const countPositions = (geometry) => {
  if (geometry?.type === 'LineString') return geometry.coordinates.length;
  if (geometry?.type === 'MultiLineString') return geometry.coordinates.reduce((n, line) => n + line.length, 0);
  return 0;
};

/**
 * A line with at most TRACK_POINT_CAP points, or the geometry untouched.
 *
 * Tolerance is doubled until the line is under the cap: a track along a
 * straight highway drops under it at the first pass, a switchbacked trail
 * takes a few, and either way the result is the coarsest line that still
 * needed no more than the budget.
 */
export function thinLine(geometry) {
  const total = countPositions(geometry);
  if (total <= TRACK_POINT_CAP) return geometry;
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  let tolerance = 0.00002;
  let thinned = lines;
  for (let pass = 0; pass < 20; pass += 1) {
    thinned = lines.map((line) => simplify(line, tolerance));
    if (thinned.reduce((n, line) => n + line.length, 0) <= TRACK_POINT_CAP) break;
    tolerance *= 2;
  }
  return geometry.type === 'LineString'
    ? { type: 'LineString', coordinates: thinned[0] }
    : { type: 'MultiLineString', coordinates: thinned };
}

/**
 * Six decimal places of longitude is eleven centimetres.
 *
 * A GPS fix arrives as a double and serialises as seventeen digits, which
 * claims a precision of nanometres for a reading good to a few metres. Rounding
 * halves what a track costs to store and changes nothing anybody can see. The
 * third number is elevation in metres, where a tenth is already generous.
 */
const roundPosition = (position) => (Array.isArray(position)
  ? position.map((n, axis) => (Number.isFinite(n)
    ? Math.round(n * (axis < 2 ? 1e6 : 10)) / (axis < 2 ? 1e6 : 10)
    : n))
  : position);

function roundCoordinates(value, depth) {
  if (depth === 0) return roundPosition(value);
  return Array.isArray(value) ? value.map((child) => roundCoordinates(child, depth - 1)) : value;
}

const COORD_DEPTH = {
  Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3,
};

/** The same geometry, with its positions rounded to what a GPS actually knows. */
export function roundGeometry(geometry) {
  const depth = COORD_DEPTH[geometry?.type];
  if (depth === undefined || !Array.isArray(geometry.coordinates)) return geometry;
  return { ...geometry, coordinates: roundCoordinates(geometry.coordinates, depth) };
}

function packFeature(feature, { keepTimes = false } = {}) {
  const props = feature.properties || {};
  const simplified = thinLine(feature.geometry);
  const geometry = roundGeometry(simplified);
  // Timestamps are one per point; a thinned line no longer has those points.
  const thinned = simplified !== feature.geometry;
  const packed = {
    type: 'Feature',
    geometry,
    properties: {
      kind: props.kind || 'waypoint',
      name: props.name || 'Untitled',
      description: props.description || '',
      symbol: props.symbol || '',
      type: props.type || '',
      /*
       * Snapped to the nearest swatch on the way in.
       *
       * An import arrives with whatever hex the other app used. Six of those
       * are in the palette exactly, and the rest are near-misses that would
       * show as "no swatch selected" in the editor and as a colour nobody can
       * name in the table. Landing on the nearest one costs a shade nobody can
       * see and makes the colour a thing the app can talk about.
       */
      color: nearestColor(props.color) || props.color || null,
      // Resolved from the source file's <sym>/IconStyle at import time, so a
      // GaiaGPS export arrives already styled rather than as identical dots.
      icon: props.icon || null,
      link: props.link || null,
      // What to call the link. Blank means the app's own wording, so a pin
      // that never had a label follows the app if the app's wording changes.
      linkLabel: props.linkLabel || '',
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
  if (keepTimes && props.coordTimes && !thinned) packed.properties.coordTimes = props.coordTimes;
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
  constructor({ storage = safeStorage(), key = STORAGE_KEY, vault = indexedVault() } = {}) {
    this.storage = storage;
    this.key = key;
    this.vault = vault;
    this.folders = [];
    this.listeners = new Set();
    this.errorListeners = new Set();
    this.lastError = null;
    this.writing = null;
    this.pending = false;
    // Whatever localStorage holds, so the first paint has something even
    // before the vault answers, and so an install from before the vault has
    // its collection to migrate.
    this.load();
  }

  /* ---------------- persistence ---------------- */

  /**
   * Take up whatever the vault holds, and hand it what it does not have yet.
   *
   * Called once at startup, before anything renders. Three cases: the vault
   * answers with a collection, which wins because it is where saves have been
   * going; the vault is empty and localStorage had folders, which is the first
   * run after the upgrade, so they move across and the old row is released;
   * or there is no vault at all, and localStorage stays the store it was.
   *
   * @returns {Promise<boolean>} whether the vault supplied the collection
   */
  async hydrate() {
    if (!this.vault) return false;
    let stored = null;
    try {
      stored = await this.vault.get(this.key);
    } catch {
      // A browser that refuses IndexedDB (private mode in some builds) keeps
      // the localStorage behaviour it had rather than losing the collection.
      this.vault = null;
      return false;
    }

    if (stored) {
      this.adopt(stored);
      this.emitQuietly();
      return true;
    }

    // Only once the copy is safely in the vault: an interrupted migration must
    // leave the collection somewhere, and two copies is the survivable failure.
    // A vault that refused the write has already sent the collection back to
    // localStorage, so releasing that row here would throw it away.
    const moved = this.folders.length ? await this.flush() : true;
    if (moved && this.vault) {
      try { this.storage?.removeItem(this.key); } catch { /* nothing to release */ }
    }
    return false;
  }

  /** Notify renderers without stamping any folder as changed. */
  emitQuietly() {
    for (const listener of this.listeners) listener(this, null);
  }

  /** Called with a message when a save fails after the fact. */
  onError(listener) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  reportError(message) {
    this.lastError = message;
    for (const listener of this.errorListeners) listener(message);
  }

  /** The value that gets stored: plain data, no class instances, no functions. */
  serialize() {
    return { version: 1, folders: this.folders };
  }

  load() {
    let raw = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) { this.folders = []; return; }

    try {
      this.adopt(JSON.parse(raw));
    } catch {
      // Corrupt payload: start clean rather than trapping the user in an error.
      this.folders = [];
    }
  }

  /**
   * Read a stored payload into folders, from wherever it came.
   *
   * Every field is defaulted here rather than trusted, because the payload may
   * have been written by an older version of the app, edited by hand, or come
   * back from a device that crashed mid-write.
   */
  adopt(parsed) {
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
  }

  /**
   * Write the collection out.
   *
   * With a vault the write is asynchronous and coalesced: a burst of changes -
   * an import dropping forty pins in - becomes one write of the final state
   * rather than forty of intermediate ones, and the caller is not made to wait
   * on the disk to redraw a list. Without one it is the old synchronous
   * localStorage write, which is why this still returns a boolean.
   */
  save() {
    this.lastError = null;
    if (this.vault) { this.queueWrite(); return true; }
    return this.saveLocal();
  }

  queueWrite() {
    if (this.writing) { this.pending = true; return; }
    this.writing = this.flush()
      .finally(() => {
        this.writing = null;
        if (this.pending) { this.pending = false; this.queueWrite(); }
      });
  }

  /**
   * One write, awaited. Used by hydrate's migration and by queueWrite.
   *
   * A vault that refuses the write is not retried into a loop: the collection
   * falls back to localStorage for the rest of the session, which is smaller
   * but is at least somewhere, and the failure is reported rather than
   * swallowed.
   */
  async flush() {
    if (!this.vault) return this.saveLocal();
    try {
      await this.vault.set(this.key, this.serialize());
      return true;
    } catch (error) {
      this.vault = null;
      if (this.saveLocal()) return true;
      this.reportError(this.lastError
        || `Could not save folders: ${error?.message || 'the browser refused to store them'}`);
      return false;
    }
  }

  saveLocal() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.serialize()));
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
    for (const id of [].concat(folderId || [])) {
      const folder = this.get(id);
      // Sync compares these, so a change that does not move the clock is a
      // change that will not travel.
      if (folder) folder.updatedAt = Date.now();
    }

    // Inside a batch, remember what changed and say nothing until it ends.
    if (this.held) {
      this.held.any = true;
      for (const id of [].concat(folderId || [])) this.held.folders.add(id);
      return;
    }

    this.save();
    for (const listener of this.listeners) listener(this, folderId);
  }

  /**
   * Run a set of changes as one.
   *
   * Every edit method announces itself, which redraws the panel, writes the
   * collection out and pushes the folder to sync. That is right for one edit
   * and wrong for four hundred: re-colouring a folder from a table would
   * redraw the map once per pin. Inside a batch the announcements are held,
   * the folders that changed are remembered, and one announcement naming all
   * of them goes out at the end.
   *
   * Nested batches are the inner one doing nothing, so a bulk action may call
   * a method that batches on its own account.
   *
   * @param {() => T} run
   * @returns {T} whatever run returned
   * @template T
   */
  batch(run) {
    if (this.held) return run();
    this.held = { folders: new Set(), any: false };
    try {
      return run();
    } finally {
      const { folders, any } = this.held;
      this.held = null;
      // Nothing announced itself: no write, no redraw, nothing pushed. A
      // change that named no folder - a deletion, say - still has to be
      // written out, so "any" is tracked apart from which folders moved.
      if (folders.size) this.emit([...folders]);
      else if (any) this.emit();
    }
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

  /**
   * Change a folder's settings.
   *
   * Whether it is open in the list is view state, not the collection: it is
   * about this screen on this device, and the same folder can reasonably be
   * open here and shut on the phone. So a patch that touches only that saves
   * without stamping the folder as modified, which keeps a disclosure triangle
   * from moving the sync clock and pushing the whole folder over the network.
   */
  update(id, patch) {
    const folder = this.get(id);
    if (!folder) return null;
    if (patch.color) folder.color = patch.color;
    if (typeof patch.visible === 'boolean') folder.visible = patch.visible;
    if (typeof patch.collapsed === 'boolean') folder.collapsed = patch.collapsed;
    const shared = Boolean(patch.color) || typeof patch.visible === 'boolean';
    this.emit(shared ? id : null);
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
      /*
       * The folder gets a say in the symbol, but only over silence.
       *
       * Which folder something was filed into is evidence about what it is -
       * everything in "Abandoned Kentucky" is abandoned - and this is the only
       * moment the app knows both the pin and its destination. It never
       * overrides a symbol the file carried or the pin's own name earned;
       * those were decided upstream and are better evidence.
       */
      if (!packed.properties.icon) {
        packed.properties.icon = iconForPin({
          name: packed.properties.name,
          symbol: packed.properties.symbol,
          folderName: folder.name,
        }) || null;
      }
      const print = fingerprint(packed);
      if (seen.has(print)) { skipped++; continue; }
      seen.add(print);
      folder.items.push({ id: makeId('i'), feature: packed });
      added++;
    }

    if (added) this.emit(folderId);
    return { added, skipped };
  }

  /**
   * Give every pin the symbol its imported name resolves to today.
   *
   * A pin keeps the symbol word it came in with - "fire-lookout", "chapel" -
   * and the picture was chosen once, at import, from the table as it stood
   * then. When the table grows, this lets an old folder catch up without
   * re-importing. Pins whose word resolves to nothing, or to what they
   * already show, are left alone; pins with no word never had one to match.
   *
   * @param {(pin: object) => string|null} resolve  iconForPin, passed in so this module stays free of the icon set
   * @returns {number} how many pins changed
   */
  /** @returns {boolean} whether there was an item there to remove */
  removeItem(folderId, itemId) {
    const folder = this.get(folderId);
    if (!folder) return false;
    const before = folder.items.length;
    folder.items = folder.items.filter((item) => item.id !== itemId);
    if (folder.items.length === before) return false;
    this.emit(folderId);
    return true;
  }

  /**
   * Put a folder's items in a given order.
   *
   * A trip is driven in an order, so the queue's order is data rather than
   * presentation. Ids that are not in the folder are ignored and ids the
   * caller left out keep their place at the end, so a stale list — one built
   * before a pin was added on another device — reorders what it knows about
   * and loses nothing.
   */
  reorder(folderId, itemIds) {
    const folder = this.get(folderId);
    if (!folder) return null;

    const byId = new Map(folder.items.map((item) => [item.id, item]));
    const ordered = [];
    for (const id of itemIds) {
      const item = byId.get(id);
      if (item && !ordered.includes(item)) ordered.push(item);
    }
    for (const item of folder.items) if (!ordered.includes(item)) ordered.push(item);

    folder.items = ordered;
    this.emit(folderId);
    return folder;
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

  /**
   * Apply a style to items spread across folders, as one change.
   *
   * @param {Array<{folderId: string, itemId: string}>} entries
   * @param {object} style  { color?: string|null, icon?: string|null }
   * @returns {number} how many items changed
   */
  styleMany(entries, style) {
    return this.batch(() => {
      const byFolder = new Map();
      for (const entry of entries) {
        if (!byFolder.has(entry.folderId)) byFolder.set(entry.folderId, []);
        byFolder.get(entry.folderId).push(entry.itemId);
      }
      let changed = 0;
      for (const [folderId, itemIds] of byFolder) changed += this.styleItems(folderId, style, itemIds);
      return changed;
    });
  }

  /**
   * Move items into one folder, as one change.
   *
   * @param {Array<{folderId: string, itemId: string}>} entries
   * @param {string} toFolderId
   * @returns {number} how many moved
   */
  moveItems(entries, toFolderId) {
    return this.batch(() => entries.reduce(
      (moved, entry) => moved + (this.moveItem(entry.itemId, entry.folderId, toFolderId) ? 1 : 0), 0));
  }

  /**
   * Delete items spread across folders, as one change.
   *
   * @param {Array<{folderId: string, itemId: string}>} entries
   * @returns {number} how many went
   */
  removeItems(entries) {
    return this.batch(() => entries.reduce(
      (gone, entry) => gone + (this.removeItem(entry.folderId, entry.itemId) ? 1 : 0), 0));
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
   * Set or clear the web address a pin points at, and what to call it.
   *
   * A blank address clears the label too: a name for a link that no longer
   * exists is a name for nothing, and would come back if an address were set
   * later, wearing wording meant for a different page.
   */
  linkItem(folderId, itemId, { url, label } = {}) {
    const folder = this.get(folderId);
    const item = folder?.items.find((entry) => entry.id === itemId);
    if (!item) return false;
    const props = item.feature.properties;
    const href = String(url ?? '').trim().slice(0, 2000);
    const named = href ? String(label ?? '').trim().slice(0, NAME_LIMIT) : '';
    if (props.link === (href || null) && (props.linkLabel || '') === named) return false;
    props.link = href || null;
    props.linkLabel = named;
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
            pinColor: pinColorFor(item.feature.properties),
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

/**
 * A one-store IndexedDB keyed on strings, or null where there is no IndexedDB.
 *
 * Deliberately tiny: get, set, remove. The folder collection is written whole
 * on every change, so there is nothing here to index or query - what IndexedDB
 * is being used for is its size, not its shape. Node has no indexedDB, so the
 * tests get null here and exercise the localStorage path they always did.
 */
export function indexedVault({ name = VAULT_DB, store = VAULT_STORE } = {}) {
  if (typeof indexedDB === 'undefined') return null;

  let dbPromise = null;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the folder store.'));
      // Firefox in private mode neither resolves nor errors; without this the
      // app would wait on it for ever instead of falling back to localStorage.
      request.onblocked = () => reject(new Error('The folder store is blocked by another tab.'));
    }).catch((error) => { dbPromise = null; throw error; });
    return dbPromise;
  };

  const transact = (mode, run) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let request;
    try {
      request = run(tx.objectStore(store));
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The folder store transaction was aborted.'));
  }));

  return {
    get: (key) => transact('readonly', (objects) => objects.get(key)),
    set: (key, value) => transact('readwrite', (objects) => objects.put(value, key)),
    remove: (key) => transact('readwrite', (objects) => objects.delete(key)),
  };
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
