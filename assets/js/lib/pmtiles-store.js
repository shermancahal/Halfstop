/**
 * Where downloaded archive tiles are kept.
 *
 * The Cache API holds every other offline tile in this app, and it cannot hold
 * these. A raster tile is a URL and a response, which is exactly what a cache
 * stores; an archive tile is a few hundred bytes at an offset inside one large
 * file, fetched with a `Range` header — and the Cache API refuses to store a
 * 206 response at all. Caching the whole archive instead is not an option
 * either: it is measured in gigabytes and the point of the format is that you
 * never fetch all of it.
 *
 * So the decompressed tile bodies go into IndexedDB, keyed by archive and
 * z/x/y. That is the same unit the region planner already counts, so the
 * numbers a person sees before a download — how many tiles, how much space —
 * mean the same thing either way.
 *
 * The interface is four methods, and there are two implementations of it: this
 * one over IndexedDB, and an in-memory one used by the tests. Nothing above
 * knows which it has.
 */

const DB_NAME = 'abmap-archive';
const DB_VERSION = 1;
const STORE = 'tiles';

/** The key one tile is stored under. Archive first, so one archive can be dropped without touching another. */
export function tileKey(archive, z, x, y) {
  return `${archive}|${z}/${x}/${y}`;
}

/**
 * An in-memory store, for tests and for a browser with no IndexedDB.
 *
 * Not a fallback that pretends: it is thrown away with the page, so an offline
 * download into one is lost on reload. Callers that care check `durable`.
 */
export function memoryTileStore() {
  const map = new Map();
  return {
    durable: false,
    async get(key) { return map.get(key) || null; },
    async has(key) { return map.has(key); },
    async put(key, bytes) { map.set(key, bytes); },
    async clear() { map.clear(); },
    async count() { return map.size; },
    async bytes() {
      let total = 0;
      for (const value of map.values()) total += value.byteLength;
      return total;
    },
  };
}

function request(source) {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Open the tile database.
 *
 * Returns the memory store rather than throwing where IndexedDB is missing or
 * blocked — Safari in private browsing refuses it outright — because a map that
 * works and forgets is better than a map that will not open. The `durable`
 * flag is how a caller tells the difference before promising anything.
 *
 * @param {{indexedDB?: IDBFactory, name?: string}} [options]
 */
export async function openTileStore({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) return memoryTileStore();

  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error || new Error('IndexedDB could not be opened'));
      open.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    });
  } catch {
    return memoryTileStore();
  }

  const run = (mode, work) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    work(store).then((value) => { result = value; }, reject);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });

  return {
    durable: true,
    async get(key) {
      const value = await run('readonly', (store) => request(store.get(key)));
      return value ? new Uint8Array(value) : null;
    },
    async has(key) {
      // getKey rather than get: a hit must not deserialise a tile body just to
      // answer whether it is there, and a download checks this thousands of times.
      const found = await run('readonly', (store) => request(store.getKey(key)));
      return found !== undefined;
    },
    async put(key, bytes) {
      // Stored as a plain ArrayBuffer. A Uint8Array view over a larger buffer
      // structured-clones the whole buffer, which for a tile sliced out of a
      // 16kB read is a hundredfold overshoot.
      const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
      await run('readwrite', (store) => request(store.put(copy, key)));
    },
    async clear() {
      await run('readwrite', (store) => request(store.clear()));
    },
    async count() {
      return run('readonly', (store) => request(store.count()));
    },
    async bytes() {
      /*
       * Summed rather than estimated. navigator.storage.estimate() answers for
       * the whole origin — every cached page, every raster tile — and the
       * question here is what the archive is costing.
       */
      return run('readonly', (store) => new Promise((resolve, reject) => {
        let total = 0;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) { resolve(total); return; }
          total += cursor.result.value.byteLength || 0;
          cursor.result.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      }));
    },
  };
}
