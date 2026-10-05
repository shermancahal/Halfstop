/**
 * Signed in with no signal.
 *
 * Reported as the website saying "signed out" wherever there was no service.
 * Nothing had signed anybody out: supabase-js keeps the session on the device
 * and renews its access token, which lasts an hour, from the server. With no
 * signal that renewal fails, getSession() answers with no session at all, and
 * the account took that answer as the truth - while the session itself sat
 * untouched in localStorage, ready for the moment the bars came back.
 *
 * These hold the other reading: a session still on the device, with a
 * refresh token in it, is somebody signed in and offline. It stays that way,
 * with Premium as last read, until the server can be asked, and only an
 * answer from the server - or the person signing out - ends it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Account,
  SESSION_KEY,
  PLAN_CACHE_KEY,
  OFFLINE_NOTE,
  storedSessionUser,
  cachePlan,
  cachedPlan,
  networkFailure,
} from '../assets/js/lib/account.js';

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

/** The shape supabase-js stores a session in, an hour past its access token. */
function storedSession(user = { id: 'u1', email: 'a@example.com' }) {
  return JSON.stringify({
    access_token: 'expired',
    refresh_token: 'still-good',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    user,
  });
}

const PREMIUM = { tier: 'premium', source: 'stripe', expires_at: null };

/** Put a store, and a signal or none, where account.js looks for them. */
function device({ store = fakeStore(), onLine = true } = {}) {
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
  globalThis.window = { location: { href: 'https://app.halfstop.app/map.html', hash: '', search: '' } };
  return store;
}

const folders = {
  list: () => [],
  snapshot: () => [],
  replaceAll() {},
  toGeoJSON: () => ({ features: [] }),
};

/**
 * A client whose server cannot be reached: getSession() answers with no
 * session, the way supabase-js does when a renewal fails for want of a signal.
 */
function offlineClient({ session = null } = {}) {
  const calls = [];
  const fired = { handler: null };
  return {
    calls,
    fired,
    rpc: async (name) => { calls.push(['rpc', name]); throw new TypeError('Failed to fetch'); },
    from() {
      calls.push(['from']);
      return {
        select() { return { async eq() { throw new TypeError('Failed to fetch'); } }; },
        async upsert() { throw new TypeError('Failed to fetch'); },
      };
    },
    functions: { async invoke() { return { data: [], error: null }; } },
    auth: {
      async getSession() { return { data: { session }, error: session ? null : { message: 'Failed to fetch' } }; },
      onAuthStateChange(handler) {
        fired.handler = handler;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signOut() {
        calls.push(['signOut']);
        // What supabase-js does with no signal: says so, and keeps its session.
        return { error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' } };
      },
    },
  };
}

test('offline: a kept session with a refresh token is somebody signed in', () => {
  const store = fakeStore({ [SESSION_KEY]: storedSession() });
  assert.equal(storedSessionUser(store)?.id, 'u1');

  // Nothing kept, or nothing to renew it with, is nobody.
  assert.equal(storedSessionUser(fakeStore()), null);
  assert.equal(storedSessionUser(fakeStore({ [SESSION_KEY]: JSON.stringify({ access_token: 'a', user: { id: 'u1' } }) })), null);
  assert.equal(storedSessionUser(fakeStore({ [SESSION_KEY]: '{not json' })), null);
  // The older wrapped shape is still read.
  const wrapped = JSON.stringify({ currentSession: JSON.parse(storedSession()) });
  assert.equal(storedSessionUser(fakeStore({ [SESSION_KEY]: wrapped }))?.id, 'u1');
});

test('offline: the plan is kept for its own person, and not past its end', () => {
  const store = fakeStore();
  cachePlan('u1', PREMIUM, store);
  assert.deepEqual(cachedPlan('u1', { store }), PREMIUM);
  assert.equal(cachedPlan('u2', { store }), null, 'somebody else on the same device was handed this plan');

  const now = Date.parse('2026-10-05T12:00:00Z');
  cachePlan('u1', { ...PREMIUM, expires_at: '2026-10-01T00:00:00Z' }, store);
  assert.equal(cachedPlan('u1', { store, now }), null, 'a trial that has ended was honoured because there was no signal');
  cachePlan('u1', { ...PREMIUM, expires_at: '2026-11-01T00:00:00Z' }, store);
  assert.equal(cachedPlan('u1', { store, now })?.tier, 'premium');

  cachePlan('u1', null, store);
  assert.equal(store.getItem(PLAN_CACHE_KEY), null);
});

test('offline: opening the site with no signal leaves the person signed in', async () => {
  const store = device({ store: fakeStore({ [SESSION_KEY]: storedSession() }) });
  cachePlan('u1', PREMIUM, store);
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });

  await account.init();
  assert.equal(account.user?.id, 'u1');
  assert.equal(account.status, 'signed-in');
  assert.equal(account.offline, true);
  assert.equal(account.message, OFFLINE_NOTE);
  assert.equal(account.plan?.tier, 'premium', 'Premium went missing for want of a signal');
  assert.ok(store.getItem(SESSION_KEY), 'the session was dropped from the device');
});

test('offline: no service, though the phone thinks it is online, is the same', async () => {
  // navigator.onLine is true on a phone with bars and no data. The renewal
  // failing is what says there is no signal.
  device({ store: fakeStore({ [SESSION_KEY]: storedSession() }), onLine: true });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });

  await account.init();
  assert.equal(account.user?.id, 'u1');
  assert.equal(account.status, 'signed-in');
  assert.equal(account.offline, true);
});

test('offline: signed in from the first moment, not after the library gives up', async () => {
  device({ store: fakeStore({ [SESSION_KEY]: storedSession() }), onLine: true });
  let answer;
  const client = offlineClient();
  client.auth.getSession = () => new Promise((resolve) => { answer = resolve; });
  const account = new Account(folders, { client: async () => client, configured: () => true });

  const starting = account.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // supabase-js spends the better part of a minute retrying before it answers.
  assert.equal(account.status, 'signed-in', 'the half minute of retries showed "signed out"');
  assert.equal(account.user?.id, 'u1');
  // And nothing is sent on the person's behalf until the server has answered.
  assert.equal(await account.sync(), null);
  assert.deepEqual(client.calls.filter(([name]) => name === 'from'), []);

  answer({ data: { session: null } });
  await starting;
  assert.equal(account.offline, true);
});

test('offline: nothing kept on the device is still signed out', async () => {
  device({ store: fakeStore(), onLine: false });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });

  await account.init();
  assert.equal(account.user, null);
  assert.equal(account.status, 'signed-out');
  assert.equal(account.offline, false);
});

test('offline: a session the server ended is signed out, not held', async () => {
  // A refused renewal - signed out on another device, password changed - has
  // supabase-js remove its session and send SIGNED_OUT. That is an answer.
  const store = device({ store: fakeStore({ [SESSION_KEY]: storedSession() }) });
  cachePlan('u1', PREMIUM, store);
  const client = offlineClient();
  client.auth.getSession = async () => {
    store.removeItem(SESSION_KEY);
    client.fired.handler?.('SIGNED_OUT', null);
    return { data: { session: null }, error: { message: 'Invalid Refresh Token' } };
  };
  const account = new Account(folders, { client: async () => client, configured: () => true });

  await account.init();
  assert.equal(account.user, null);
  assert.equal(account.status, 'signed-out');
  assert.equal(account.plan, null, 'the plan of an ended session stayed on the screen');
});

test('offline: a library event with no session does not sign anybody out', async () => {
  device({ store: fakeStore({ [SESSION_KEY]: storedSession() }) });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  await account.init();

  client.fired.handler('INITIAL_SESSION', null);
  assert.equal(account.user?.id, 'u1');
  assert.equal(account.status, 'signed-in');

  // Signing out is the one event that does.
  globalThis.localStorage.removeItem(SESSION_KEY);
  client.fired.handler('SIGNED_OUT', null);
  assert.equal(account.user, null);
  assert.equal(account.status, 'signed-out');
});

test('offline: sync and folder saves wait for a signal, and say why', async () => {
  device({ store: fakeStore({ [SESSION_KEY]: storedSession() }), onLine: false });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  await account.init();
  client.calls.length = 0;

  assert.equal(await account.sync(), null);
  await account.pushFolder({ id: 'f1', name: 'Gorge', items: [], updatedAt: 1 });
  assert.deepEqual(client.calls, [], 'a request was sent with no signal to send it on');
  assert.equal(account.message, OFFLINE_NOTE);
});

test('offline: a sync that never reached the server says offline, not failed', async () => {
  assert.equal(networkFailure(new TypeError('Failed to fetch')), true);
  assert.equal(networkFailure({ message: 'NetworkError when attempting to fetch resource.' }), true);
  assert.equal(networkFailure({ message: 'Load failed' }), true);
  assert.equal(networkFailure({ message: 'permission denied for table folders' }), false);

  device({ store: fakeStore() });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  account.user = { id: 'u1' };
  account.plan = PREMIUM;
  await account.sync();
  assert.equal(account.status, 'signed-in');
  assert.equal(account.message, OFFLINE_NOTE);
});

test('offline: back in signal, the session is renewed and the folders sync', async () => {
  device({ store: fakeStore({ [SESSION_KEY]: storedSession() }), onLine: false });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  await account.init();
  assert.equal(account.offline, true);

  // The signal returns; asking for the session now renews it.
  globalThis.navigator.onLine = true;
  const renewed = { access_token: 'fresh', refresh_token: 'next', user: { id: 'u1', email: 'a@example.com' } };
  client.auth.getSession = async () => ({ data: { session: renewed } });
  client.rpc = async (name) => { client.calls.push(['rpc', name]); return { data: PREMIUM, error: null }; };
  let synced = 0;
  account.sync = async () => { synced += 1; return null; };

  await account.reconnect();
  assert.equal(account.offline, false);
  assert.equal(account.status, 'signed-in');
  assert.equal(account.message, '');
  assert.equal(synced, 1, 'what waited for a signal was not sent when it came back');
  assert.ok(client.calls.some(([kind, name]) => kind === 'rpc' && name === 'my_plan'), 'the plan was not read again');
});

test('offline: the library renewing on its own is the same as coming back', async () => {
  device({ store: fakeStore({ [SESSION_KEY]: storedSession() }), onLine: false });
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  await account.init();
  let synced = 0;
  account.sync = async () => { synced += 1; return null; };

  client.fired.handler('TOKEN_REFRESHED', { access_token: 'fresh', user: { id: 'u1' } });
  assert.equal(account.offline, false);
  assert.equal(account.message, '');
  assert.equal(synced, 1);
});

test('offline: signing out with no signal still signs out, and stays signed out', async () => {
  /*
   * supabase-js cannot tell the server, says so, and keeps its session - so
   * the next page load found it and signed the person straight back in.
   */
  const store = device({ store: fakeStore({ [SESSION_KEY]: storedSession() }), onLine: false });
  cachePlan('u1', PREMIUM, store);
  const client = offlineClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  await account.init();

  const started = Date.now();
  await account.signOut();
  assert.equal(account.user, null);
  assert.equal(account.status, 'signed-out');
  assert.equal(account.offline, false);
  // Not asked: with no signal the library waits out its retries first.
  assert.deepEqual(client.calls.filter(([name]) => name === 'signOut'), []);
  assert.ok(Date.now() - started < 1000);
  assert.match(account.message, /no signal to sync, so your folders are still on this device/);
  assert.equal(store.getItem(SESSION_KEY), null, 'the session was left for the next page load to find');
  assert.equal(store.getItem(PLAN_CACHE_KEY), null, 'the plan was left behind');

  const again = new Account(folders, { client: async () => offlineClient(), configured: () => true });
  await again.init();
  assert.equal(again.user, null);
  assert.equal(again.status, 'signed-out');
});
