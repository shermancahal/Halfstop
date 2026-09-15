/**
 * The name a signed-in session is stored under.
 *
 * supabase-js derives it from the first label of the API URL, so the session
 * is filed under `sb-<project-ref>-auth-token` while the app talks to
 * <ref>.supabase.co and under `sb-auth-auth-token` the moment it talks to
 * auth.halfstop.app instead. Nothing warns about this: the new client simply
 * reads a slot nobody has written to, finds no session, and every signed-in
 * person on every device is quietly signed out by a one-line change to a
 * deployment secret.
 *
 * The fix is to stop deriving the name. These tests hold the two halves of
 * that: the pinned name really is independent of the hostname, and a session
 * already stored under the derived name is carried onto it, so pinning it
 * signs nobody out either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const PROJECT = 'https://gqemcvuushtfbbbxypvf.supabase.co';
const CUSTOM = 'https://auth.halfstop.app';

// Before the import: config.js reads these globals as the module evaluates,
// and account.js reads the URL from config.js.
globalThis.ABMAP_SUPABASE_URL = PROJECT;
globalThis.ABMAP_SUPABASE_KEY = 'sb_publishable_test';

const { Account, SESSION_KEY, adoptSession, derivedSessionKey } =
  await import('../assets/js/lib/account.js');

/** localStorage, as much of it as any of this touches. */
function fakeStore(seed = {}) {
  const held = new Map(Object.entries(seed));
  return {
    held,
    getItem: (key) => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => { held.set(key, String(value)); },
    removeItem: (key) => { held.delete(key); },
  };
}

const SESSION = JSON.stringify({ access_token: 'a', refresh_token: 'r' });

test('the derived name follows the hostname, which is the whole problem', () => {
  assert.equal(derivedSessionKey(PROJECT), 'sb-gqemcvuushtfbbbxypvf-auth-token');
  assert.equal(derivedSessionKey(CUSTOM), 'sb-auth-auth-token');
  assert.notEqual(derivedSessionKey(PROJECT), derivedSessionKey(CUSTOM),
    'moving onto the custom domain changes where a client looks for the session');
});

test('the pinned name does not', () => {
  assert.equal(SESSION_KEY, 'sb-halfstop-auth-token');
  assert.ok(!SESSION_KEY.includes('supabase'), 'nothing about it is tied to a host');
});

test('a session stored under the derived name is carried onto the pinned one', () => {
  const store = fakeStore({ [derivedSessionKey(PROJECT)]: SESSION });

  assert.equal(adoptSession(PROJECT, store), true);
  assert.equal(store.getItem(SESSION_KEY), SESSION);

  // And the point of it: the URL moves to the custom domain, the client now
  // reads the pinned name, and the session is still there. Read the derived
  // name instead - which is what the library did before this - and it is not.
  assert.equal(store.getItem(SESSION_KEY), SESSION, 'still signed in after the move');
  assert.equal(store.getItem(derivedSessionKey(CUSTOM)), null,
    'where an unpinned client would have looked, and found nobody signed in');
});

test('the old entry stays put, so rolling the deployment back signs nobody out', () => {
  const store = fakeStore({ [derivedSessionKey(PROJECT)]: SESSION });
  adoptSession(PROJECT, store);
  assert.equal(store.getItem(derivedSessionKey(PROJECT)), SESSION);
});

test('a session already under the pinned name is never overwritten', () => {
  const store = fakeStore({
    [SESSION_KEY]: 'current',
    [derivedSessionKey(PROJECT)]: 'stale',
  });

  assert.equal(adoptSession(PROJECT, store), false);
  assert.equal(store.getItem(SESSION_KEY), 'current');
});

test('nothing to carry, nothing happens', () => {
  const store = fakeStore();
  assert.equal(adoptSession(PROJECT, store), false);
  assert.equal(store.getItem(SESSION_KEY), null);
});

test('storage that throws is not allowed to break signing in', () => {
  const angry = {
    getItem() { throw new Error('The operation is insecure.'); },
    setItem() { throw new Error('The operation is insecure.'); },
    removeItem() { throw new Error('The operation is insecure.'); },
  };

  assert.equal(adoptSession(PROJECT, angry), false);
  assert.equal(adoptSession(PROJECT, null), false);
  assert.equal(adoptSession('not a url', fakeStore()), false);
});

test('signing out leaves nothing behind under either name', async () => {
  const store = fakeStore({
    [SESSION_KEY]: SESSION,
    [derivedSessionKey(PROJECT)]: SESSION,
  });
  globalThis.localStorage = store;

  const client = {
    auth: {
      async signOut() { store.removeItem(SESSION_KEY); },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
  const folders = { list: () => [], replaceAll() {}, toGeoJSON: () => ({ features: [] }) };
  const account = new Account(folders, { client: async () => client, configured: () => true });

  await account.signOut();

  assert.equal(store.getItem(SESSION_KEY), null, 'the library cleared its own');
  assert.equal(store.getItem(derivedSessionKey(PROJECT)), null, 'and we cleared the copy');
});

test('the client is built with the pinned name, not the derived one', async () => {
  /*
   * The line that matters is one property inside getClient(), which is not
   * exported and which loads the vendored library through a <script> tag. So:
   * a document just real enough for that tag, and a createClient that records
   * what the app asked for. Everything above this test is about the name being
   * right; this is about it actually being used.
   */
  const store = fakeStore({ [derivedSessionKey(PROJECT)]: SESSION });
  globalThis.localStorage = store;

  let asked = null;
  globalThis.supabase = {
    createClient(url, key, options) {
      asked = { url, key, options };
      return {
        auth: {
          async signOut() {},
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
        },
      };
    },
  };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => {
      const on = {};
      return {
        dataset: {},
        addEventListener(type, fn) { on[type] = fn; },
        fire: (type) => on[type]?.(),
      };
    },
    head: { append: (node) => { queueMicrotask(() => node.fire('load')); } },
  };

  try {
    const folders = { list: () => [], replaceAll() {}, toGeoJSON: () => ({ features: [] }) };
    await new Account(folders).signOut();
  } finally {
    delete globalThis.document;
    delete globalThis.supabase;
  }

  assert.ok(asked, 'the real getClient ran');
  assert.equal(asked.url, PROJECT);
  assert.equal(asked.options.auth.storageKey, SESSION_KEY,
    'without this the session is filed under the hostname again');
  assert.equal(store.getItem(SESSION_KEY), SESSION,
    'and the session was carried over before the client read it');
});
