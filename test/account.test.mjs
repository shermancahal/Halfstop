/**
 * The account paths that email somebody a link.
 *
 * None of this was covered, which is how a signUp with no emailRedirectTo
 * shipped: Supabase falls back to the project's Site URL when a call does not
 * name a return address, so the confirmation email pointed at a host this
 * repository has never heard of and the link landed on a 404 carrying a
 * perfectly valid token.
 *
 * A fake client rather than a real project: what is under test is what this
 * code asks for, which is exactly the part that was wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Account, displayName } from '../assets/js/lib/account.js';

const folders = { list: () => [], replaceAll() {}, toGeoJSON: () => ({ features: [] }) };

function fakeClient({ session = null, signOutError = null, functionError = null } = {}) {
  const calls = [];
  const fired = { handler: null };
  return {
    calls,
    fired,
    // Signing in starts a folder sync, so the fake needs the data surface too
    // - otherwise "signed in cleanly" fails on a missing method rather than on
    // anything the test is about.
    from() {
      return {
        select() { return { async eq() { return { data: [], error: null }; } }; },
        async upsert() { return { error: null }; },
        delete() { return { async eq() { return { error: null }; } }; },
      };
    },
    functions: {
      async invoke(name, options) {
        calls.push(['invoke', name, options]);
        if (functionError) return { data: null, error: new Error(functionError) };
        return { data: { ok: true }, error: null };
      },
    },
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange(handler) {
        // Kept so a test can fire an event the way Supabase would. Harmless to
        // the tests that ignore it: nothing runs unless they reach for it.
        fired.handler = handler;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signUp(options) { calls.push(['signUp', options]); return { data: { session: null }, error: null }; },
      async signInWithOtp(options) { calls.push(['signInWithOtp', options]); return { error: null }; },
      async resetPasswordForEmail(email, options) {
        calls.push(['resetPasswordForEmail', email, options]);
        return { error: null };
      },
      async signInWithOAuth(options) { calls.push(['signInWithOAuth', options]); return { error: null }; },
      async updateUser(attributes, options) {
        calls.push(['updateUser', attributes, options]);
        return { data: { user: null }, error: null };
      },
      async signOut() {
        calls.push(['signOut']);
        if (signOutError) throw new Error(signOutError);
      },
    },
  };
}

const withHash = (hash) => {
  globalThis.window = { location: { href: `https://app.halfstop.app/?m=x${hash}`, hash } };
};

test('account: every emailed link is told where to come back to', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await account.signUp('a@example.com', 'secret');
  await account.signInWithLink('a@example.com');

  const back = 'https://app.halfstop.app/?m=x';
  for (const [name, options] of client.calls) {
    assert.equal(options?.options?.emailRedirectTo, back,
      `${name} did not say where the link should return to`);
  }
  assert.equal(client.calls.length, 2);
});

test('account: the return address drops the fragment it arrived in', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  // Sending the old token back would be asking to be handed a stale session.
  withHash('#access_token=stale');

  await account.signUp('a@example.com', 'secret');
  assert.equal(client.calls[0][1].options.emailRedirectTo, 'https://app.halfstop.app/?m=x');
});

test('account: a link that came back refused says why', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('#error=access_denied&error_description=Email+link+is+invalid+or+has+expired');

  await account.init();
  assert.equal(account.status, 'signed-out');
  assert.match(account.message, /Email link is invalid or has expired/);
});

test('account: a token that arrived and did nothing is not silence', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('#access_token=abc&type=signup');

  /*
   * Without this the page loads signed out, which looks exactly like never
   * having clicked the link - and that silence is most of why a broken
   * confirmation reads as a broken app.
   */
  await account.init();
  assert.equal(account.status, 'signed-out');
  assert.match(account.message, /could not be used/);
});

test('account: a good link leaves no complaint behind', async () => {
  const client = fakeClient({ session: { user: { id: 'u1', email: 'a@example.com' } } });
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('#access_token=abc&type=signup');

  await account.init();
  /*
   * Not asserted on status: signing in starts a folder sync, so by the time
   * init resolves the status is legitimately 'syncing'. What this test is
   * about is that neither of the two branches above fired on a link that
   * worked - a token in the URL is normal on the way in, and must not be
   * reported as a problem just because it is there.
   */
  assert.equal(account.user?.email, 'a@example.com');
  assert.doesNotMatch(account.message, /could not be used|did not work/);
});

test('account: signing out clears the device even when the server refuses', async () => {
  const client = fakeClient({ signOutError: 'network down' });
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  account.user = { id: 'u1' };

  /*
   * Between "the server was not told" and "this phone still thinks you are
   * signed in", the second is the one the person holding it cares about.
   * It used to throw before clearing, leaving a signed-in UI and a rejection
   * in the console.
   */
  await account.signOut();
  assert.equal(account.user, null);
  assert.equal(account.status, 'signed-out');
});


test('account: signing out takes the folders off the screen, once they are safe', async () => {
  /*
   * The report was "it is almost as if I'm still signed in": the pins, the
   * folders and the waypoint list all survived a sign-out, which is the state
   * somebody signs out to leave behind.
   */
  const held = [{ id: 'f1', name: 'Gorge', items: [], updatedAt: 1 }];
  const store = {
    list: () => held,
    snapshot: () => held,
    replaceAll(next) { held.length = 0; held.push(...next); },
    toGeoJSON: () => ({ features: [] }),
  };
  const client = fakeClient();
  const account = new Account(store, { client: async () => client, configured: () => true });
  withHash('');
  account.user = { id: 'u1' };

  await account.signOut();
  assert.equal(account.status, 'signed-out');
  assert.deepEqual(held, [], 'the folders were left on the screen after signing out');
});

test('account: a sign-out that could not sync keeps the folders rather than losing them', async () => {
  /*
   * The other half, and the one that decides whether clearing is safe at all.
   * A folder that never reached the server exists in one place, so a sign-out
   * that cannot push must leave it there and say so.
   */
  const held = [{ id: 'f1', name: 'Gorge', items: [], updatedAt: 1 }];
  const store = {
    list: () => held,
    snapshot: () => held,
    replaceAll(next) { held.length = 0; held.push(...next); },
    toGeoJSON: () => ({ features: [] }),
  };
  const client = fakeClient();
  // The read the sync starts with fails, so nothing was pushed.
  client.from = () => ({
    select() { return { async eq() { return { data: null, error: { message: 'offline' } }; } }; },
    async upsert() { return { error: null }; },
  });
  const account = new Account(store, { client: async () => client, configured: () => true });
  withHash('');
  account.user = { id: 'u1' };

  await account.signOut();
  assert.equal(account.status, 'signed-out');
  assert.equal(held.length, 1, 'an unsynced folder was cleared off the device');
  assert.match(account.message, /still on this device/);
});

test('account: deleting an account closes it, and never says whose', async () => {
  /*
   * The browser can delete its own rows and cannot delete the auth record -
   * that needs the service key, which must never be in a page. So the record
   * goes through an Edge Function, and the thing worth pinning is what the
   * client sends it: nothing. The function reads whose account to close from
   * the token on the request. A client that could name a user id would be an
   * unauthenticated delete of anybody's account wearing a signed-in one's
   * clothes, and privacy.html has been promising this deletion for a while.
   */
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  account.user = { id: 'u1' };

  const result = await account.deleteAccount();
  assert.equal(result.ok, true);
  assert.equal(result.closed, true);

  const invoked = client.calls.filter(([name]) => name === 'invoke');
  assert.equal(invoked.length, 1, 'the account-closing function was not called');
  assert.equal(invoked[0][1], 'delete-account');
  assert.equal(JSON.stringify(invoked[0][2] ?? null).includes('u1'), false,
    'the client sent a user id, which the server must never take from it');
});

test('account: an account that could not be closed says so rather than claiming it was', async () => {
  const client = fakeClient({ functionError: 'function not found' });
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  account.user = { id: 'u1' };

  const result = await account.deleteAccount();
  // The rows still went, so this is not a failure to report as one - but the
  // difference has to reach the person, because one of the two needs an email.
  assert.equal(result.ok, true);
  assert.equal(result.closed, false);
  assert.match(account.message, /support@halfstop\.app/);
});

test('account: a provider sign-in says where to come back to', async () => {
  /*
   * The reason these exist is that there is no emailed link to break. They
   * still depend on the redirect allow list, which is the same setting that
   * broke the email flow - so the address they send is worth pinning.
   */
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('#access_token=stale');

  await account.signInWithProvider('apple');
  await account.signInWithProvider('google');

  assert.deepEqual(client.calls.map(([name, options]) => [name, options.provider, options.options.redirectTo]), [
    ['signInWithOAuth', 'apple', 'https://app.halfstop.app/?m=x'],
    ['signInWithOAuth', 'google', 'https://app.halfstop.app/?m=x'],
  ]);
});

test('account: a provider refusal is reported rather than swallowed', async () => {
  /*
   * A successful call navigates away, so anything that returns is a refusal -
   * a provider not enabled in the dashboard being the likely one. Returning
   * quietly would leave a button that appears to do nothing, which is the
   * exact complaint that started this.
   */
  const client = fakeClient();
  client.auth.signInWithOAuth = async () => ({ error: { message: 'provider is not enabled' } });
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await assert.rejects(() => account.signInWithProvider('apple'), /provider is not enabled/);
});

test('account: signing up an address that already exists says so', async () => {
  /*
   * Reported: a create-account request, and nothing came back.
   *
   * Supabase will not tell a stranger whether an address is registered, so a
   * repeat signup returns 200 with a user, no session, and an empty
   * `identities` array - and sends no email at all. Read only as "no session",
   * that is indistinguishable from a fresh signup awaiting confirmation, and
   * the app told people to watch an inbox nothing was going to arrive in.
   */
  const client = fakeClient();
  client.auth.signUp = async (options) => {
    client.calls.push(['signUp', options]);
    return { data: { session: null, user: { identities: [] } }, error: null };
  };
  const account = new Account(folders, { client: async () => client, configured: () => true });
  const result = await account.signUp('taken@example.com', 'hunter2');

  assert.equal(result.existing, true);
  assert.match(account.message, /already has an account/i);
  assert.doesNotMatch(account.message, /check your email/i,
    'the one message that is certainly wrong here is the one telling them to wait for mail');
});

test('account: a genuinely new signup still points at the inbox', async () => {
  // The other side of the same branch: a fresh address gets a user WITH an
  // identity, and must not be told it already exists.
  const client = fakeClient();
  client.auth.signUp = async (options) => {
    client.calls.push(['signUp', options]);
    return { data: { session: null, user: { identities: [{ provider: 'email' }] } }, error: null };
  };
  const account = new Account(folders, { client: async () => client, configured: () => true });
  const result = await account.signUp('new@example.com', 'hunter2');

  assert.equal(result.existing, undefined);
  assert.match(account.message, /check your email/i);
});

test('account: a response with no identities at all is not read as "already exists"', async () => {
  /*
   * The guard is `Array.isArray(identities) && length === 0`, and the obvious
   * shorter form `!identities?.length` is wrong in a way no other test here
   * catches: an absent field is not an empty one. A future response shape that
   * simply omits `identities` would then tell every new signup that their
   * address is already registered - and send them to a sign-in they cannot do.
   *
   * Found by mutation: replacing the guard with the short form passed both
   * tests above.
   */
  const client = fakeClient();
  client.auth.signUp = async (options) => {
    client.calls.push(['signUp', options]);
    return { data: { session: null, user: { id: 'abc' } }, error: null };
  };
  const account = new Account(folders, { client: async () => client, configured: () => true });
  const result = await account.signUp('new@example.com', 'hunter2');

  assert.equal(result.existing, undefined);
  assert.match(account.message, /check your email/i);
});

/* ------------------------------------------------------------ the profile */

const signedIn = () => ({ id: 'u1', email: 'a@example.com', user_metadata: { display_name: 'Sherman' } });

/*
 * Only what changed goes to the server. Supabase treats a new address as a
 * request - it emails both inboxes and changes nothing until the links are
 * opened - so sending the same address back would start that for nothing.
 */
test('account: editing the profile sends only what changed', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  account.user = signedIn();

  const same = await account.updateProfile({ name: ' Sherman ', email: 'A@example.com' });
  assert.deepEqual(same, { changed: false, emailPending: false });
  assert.equal(client.calls.length, 0, 'an unchanged profile asks the server for nothing');
  assert.match(account.message, /Nothing changed/);

  const renamed = await account.updateProfile({ name: 'S. Cahal', email: 'a@example.com' });
  assert.deepEqual(renamed, { changed: true, emailPending: false });
  const [name, attributes, options] = client.calls.at(-1);
  assert.equal(name, 'updateUser');
  assert.deepEqual(attributes, { data: { display_name: 'S. Cahal' } }, 'the address was not resent');
  assert.equal(options.emailRedirectTo, 'https://app.halfstop.app/?m=x',
    'the confirmation link is told where to come back to, like every other emailed link');
  assert.equal(account.message, 'Saved.');
});

test('account: a new address is a request, and the message says where the links went', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  account.user = signedIn();

  const result = await account.updateProfile({ name: 'Sherman', email: 'New@Example.com' });
  assert.equal(result.emailPending, true);
  const [, attributes] = client.calls.at(-1);
  assert.deepEqual(attributes, { email: 'new@example.com' });
  assert.match(account.message, /new@example\.com/);
  assert.match(account.message, /old/, 'the old inbox gets a link too, and the reader has to know');
});

test('account: an address that is not one is refused before the server sees it', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  account.user = signedIn();

  await assert.rejects(() => account.updateProfile({ name: 'Sherman', email: 'not-an-address' }), /email address/);
  assert.equal(client.calls.length, 0);
});

test('account: the profile cannot be edited signed out', async () => {
  const account = new Account(folders, { client: async () => fakeClient(), configured: () => true });
  await assert.rejects(() => account.updateProfile({ name: 'x' }), /Sign in first/);
});

/*
 * Apple and Google each put the name somewhere different, and the profile
 * form puts it somewhere else again. The typed one wins; nothing falls back to
 * the address, because the caller decides what an address looks like there.
 */
test('account: a name is read from wherever the sign-in put it', () => {
  assert.equal(displayName({ user_metadata: { display_name: 'Typed', full_name: 'From a provider' } }), 'Typed');
  assert.equal(displayName({ user_metadata: { full_name: 'Apple Name' } }), 'Apple Name');
  assert.equal(displayName({ user_metadata: { name: 'Google Name' } }), 'Google Name');
  assert.equal(displayName({ user_metadata: { display_name: '   ' }, email: 'a@b.c' }), '');
  assert.equal(displayName(null), '');
});

/*
 * A server that has never heard of parent_id.
 *
 * Postgres does not return a key for a column that does not exist, and
 * reading that absence as "this folder sits at the top" let an un-migrated
 * database flatten the tree on every sync - quietly, and only on whichever
 * device happened to be older.
 */
function dataClient(rows, { onUpsert = () => ({ error: null }) } = {}) {
  const sent = [];
  return {
    sent,
    from() {
      return {
        select() { return { async eq() { return { data: rows, error: null }; } }; },
        async upsert(payload) { sent.push(payload); return onUpsert(payload); },
      };
    },
    auth: {
      async getSession() { return { data: { session: null } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
}

const storeOf = (list) => {
  let held = list;
  return {
    list: () => held,
    snapshot: () => held.map((folder) => ({ ...folder })),
    replaceAll(next) { held = next; },
    toGeoJSON: () => ({ features: [] }),
  };
};

const row = (id, extra = {}) => ({
  client_id: id, name: id, color: '#b4441f', visible: true, collapsed: false,
  deleted: false, items: [], updated_at: new Date(5000).toISOString(), ...extra,
});

test('account: a server with no parent_id column does not unfile anything', async () => {
  // The row is newer than the local copy, so without the guard the pull wins
  // and the nesting is gone.
  const rows = [{ ...row('rail'), updated_at: new Date(9000).toISOString() }];
  const store = storeOf([{ id: 'rail', name: 'rail', parentId: 'transport', updatedAt: 5000, items: [], deleted: false }]);
  const client = dataClient(rows);
  const account = new Account(store, { client: async () => client, configured: () => true });
  account.user = { id: 'u1' };

  await account.sync();
  assert.equal(store.list()[0].parentId, 'transport', 'the tree this device knows is left alone');
  assert.equal(account.missingColumns.has('parent_id'), true,
    'and the push knows not to send a column that is not there');
});

test('account: the column appearing is noticed on the next sync, with no reload', async () => {
  const store = storeOf([{ id: 'rail', name: 'rail', parentId: 'transport', updatedAt: 5000, items: [], deleted: false }]);
  const account = new Account(store, {
    // A migrated table returns the key, holding null, for a folder at the top.
    client: async () => dataClient([row('rail', { parent_id: null })]),
    configured: () => true,
  });
  account.user = { id: 'u1' };
  account.missingColumns.add('parent_id');

  await account.sync();
  assert.equal(account.missingColumns.has('parent_id'), false,
    'a row carrying the key says the migration has been run');
});

test('account: an empty table is not evidence the column is missing', async () => {
  const store = storeOf([]);
  const account = new Account(store, { client: async () => dataClient([]), configured: () => true });
  account.user = { id: 'u1' };

  await account.sync();
  assert.equal(account.missingColumns.has('parent_id'), false);
});

test('account: a server with no trip column does not clear the dates', async () => {
  // The same silence, about a different column. Read as an answer, an
  // un-migrated database retires every trip on the device that syncs against
  // it - and the dates are not recoverable from anything else.
  const rows = [{ ...row('rail'), updated_at: new Date(9000).toISOString() }];
  const store = storeOf([{
    id: 'rail', name: 'rail', updatedAt: 5000, items: [], deleted: false,
    trip: { from: '2026-05-01', to: '2026-05-04' },
  }]);
  const account = new Account(store, { client: async () => dataClient(rows), configured: () => true });
  account.user = { id: 'u1' };

  await account.sync();
  assert.deepEqual(
    store.list()[0].trip,
    { from: '2026-05-01', to: '2026-05-04' },
    'the trip this device knows is left alone',
  );
  assert.equal(account.missingColumns.has('trip'), true);
});

/* ------------------------------------------------- which providers exist */

/*
 * A hand-kept list had to match a setting in a dashboard, and drift failed
 * both ways: registered and unlisted is a button nobody sees; listed and
 * unregistered sends somebody to an error page wearing Apple's branding.
 */

const withFetch = async (impl, run) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { await run(); } finally { globalThis.fetch = real; }
};

const answering = (body, ok = true) => async () => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});

test('account: only the providers the project says it has are offered', async () => {
  const account = new Account(storeOf([]), { client: async () => ({}), configured: () => true });
  await withFetch(answering({ external: { apple: true, google: false, github: true } }), async () => {
    await account.refreshProviders();
  });
  // github is registered and this app has no button for it, so it is not one.
  assert.deepEqual(account.providers, ['apple']);
});

test('account: both, when both are registered', async () => {
  const account = new Account(storeOf([]), { client: async () => ({}), configured: () => true });
  await withFetch(answering({ external: { apple: true, google: true } }), async () => {
    await account.refreshProviders();
  });
  assert.deepEqual(account.providers, ['apple', 'google']);
});

test('account: a project that answers with nothing registered offers nothing', async () => {
  const account = new Account(storeOf([]), { client: async () => ({}), configured: () => true });
  await withFetch(answering({ external: { apple: false, google: false } }), async () => {
    await account.refreshProviders();
  });
  assert.deepEqual(account.providers, [], 'an answer of none is still an answer');
});

test('account: a question that could not be asked is not an answer of none', async () => {
  // Null rather than empty, so the panel keeps its own fallback rather than
  // concluding from a failed request that neither provider exists.
  const refused = new Account(storeOf([]), { client: async () => ({}), configured: () => true });
  await withFetch(answering({}, false), async () => { await refused.refreshProviders(); });
  assert.equal(refused.providers, null);

  const offline = new Account(storeOf([]), { client: async () => ({}), configured: () => true });
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    await offline.refreshProviders();
  });
  assert.equal(offline.providers, null);
});

test('account: a deployment with no project does not ask at all', async () => {
  const account = new Account(storeOf([]), { client: async () => ({}), configured: () => false });
  let asked = false;
  await withFetch(async () => { asked = true; return answering({})(); }, async () => {
    assert.equal(await account.refreshProviders(), null);
  });
  assert.equal(asked, false);
});

/* ----------------------------------------------------------- the checkout */

/*
 * Nothing about who is paying travels in the request.
 *
 * The function reads the user from the token on the session, because a body
 * saying which account to subscribe is a body somebody else can write. What
 * these check is the part on this side: that a failure is reported rather than
 * swallowed, and that a browser is never sent somewhere on a maybe.
 */

const checkoutClient = (answer) => ({
  functions: { invoke: async (name, options) => { checkoutClient.saw = { name, options }; return answer; } },
});

test('account: a checkout that opens hands back somewhere to go', async () => {
  const account = new Account(storeOf([]), {
    client: async () => checkoutClient({ data: { ok: true, url: 'https://checkout.stripe.com/c/pay/abc' }, error: null }),
    configured: () => true,
  });
  account.user = { id: 'u1', email: 'a@b.com' };

  const result = await account.startCheckout({ returnTo: 'https://app.halfstop.app/map.html' });
  assert.deepEqual(result, { ok: true, url: 'https://checkout.stripe.com/c/pay/abc' });
  assert.equal(checkoutClient.saw.name, 'stripe-checkout');
  /*
   * A plan name and a return address, and nothing else.
   *
   * No user id, because the function reads that from the token. And no price
   * id: a checkout that took one from the browser would let anybody make a one
   * cent price in any Stripe account and buy a year of Premium with it.
   */
  assert.deepEqual(Object.keys(checkoutClient.saw.options.body).sort(), ['plan', 'returnTo']);
  assert.equal(checkoutClient.saw.options.body.plan, 'month', 'the month unless asked otherwise');
});

test('account: the year is asked for by name', async () => {
  const account = new Account(storeOf([]), {
    client: async () => checkoutClient({ data: { ok: true, url: 'https://checkout.stripe.com/c/pay/y' }, error: null }),
    configured: () => true,
  });
  account.user = { id: 'u1' };
  await account.startCheckout({ plan: 'year' });
  assert.equal(checkoutClient.saw.options.body.plan, 'year');
});

test('account: a refused checkout says why and sends nobody anywhere', async () => {
  const account = new Account(storeOf([]), {
    client: async () => checkoutClient({ data: null, error: { message: 'Payments are not configured on this project.' } }),
    configured: () => true,
  });
  account.user = { id: 'u1' };

  const result = await account.startCheckout();
  assert.equal(result.ok, false);
  assert.match(result.reason, /not configured/);
  assert.equal(result.url, undefined, 'no url on a failure, so nothing can redirect on one');
});

test('account: an answer with no url is a failure, not a redirect to nothing', async () => {
  // The shape that would otherwise send a browser to "undefined".
  const account = new Account(storeOf([]), {
    client: async () => checkoutClient({ data: { ok: true }, error: null }),
    configured: () => true,
  });
  account.user = { id: 'u1' };
  assert.equal((await account.startCheckout()).ok, false);
});

test('account: signed out, no checkout is even attempted', async () => {
  let asked = false;
  const account = new Account(storeOf([]), {
    client: async () => { asked = true; return checkoutClient({ data: null, error: null }); },
    configured: () => true,
  });
  const result = await account.startCheckout();
  assert.equal(result.ok, false);
  assert.equal(asked, false, 'nothing is asked of the server without a session to ask with');
});

/* ------------------------------------------------------ cancelling, and not
   being sold a second subscription */

const failing = (status, body) => ({
  functions: {
    invoke: async () => ({
      data: null,
      // The shape supabase-js actually produces: a wrapper whose message says
      // nothing, with the real response hanging off `context`.
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { status, json: async () => body },
      }),
    }),
  },
});

test('account: being told to cancel first survives the wrapper', async () => {
  /*
   * The failure this prevents. supabase-js turns any non-2xx into "Edge
   * Function returned a non-2xx status code", which is true and tells nobody
   * anything. Somebody who already subscribes needs to read why they cannot
   * buy again, not a sentence about status codes.
   */
  const account = new Account(storeOf([]), {
    client: async () => failing(409, {
      error: 'You already subscribe. Cancel the current subscription first, from Manage subscription in the account menu, and you can start a new one straight after.',
      already: 'stripe',
    }),
    configured: () => true,
  });
  account.user = { id: 'u1' };

  const result = await account.startCheckout();
  assert.equal(result.ok, false);
  assert.match(result.reason, /Cancel the current subscription first/);
  assert.doesNotMatch(result.reason, /non-2xx/);
});

test('account: an App Store subscriber is sent to Apple, not to Stripe', async () => {
  const account = new Account(storeOf([]), {
    client: async () => failing(409, {
      error: 'This subscription is through the App Store, so it is cancelled there: Settings, your name, Subscriptions on an iPhone or iPad.',
      where: 'appstore',
    }),
    configured: () => true,
  });
  account.user = { id: 'u1' };

  const result = await account.openBilling();
  assert.equal(result.ok, false);
  assert.match(result.reason, /App Store/);
});

test('account: the billing page opens where Stripe says', async () => {
  const account = new Account(storeOf([]), {
    client: async () => checkoutClient({ data: { ok: true, url: 'https://billing.stripe.com/p/session/xyz' }, error: null }),
    configured: () => true,
  });
  account.user = { id: 'u1' };
  assert.deepEqual(await account.openBilling(),
    { ok: true, url: 'https://billing.stripe.com/p/session/xyz' });
});

test('account: signed out, no billing page is asked for', async () => {
  let asked = false;
  const account = new Account(storeOf([]), {
    client: async () => { asked = true; return checkoutClient({ data: null, error: null }); },
    configured: () => true,
  });
  assert.equal((await account.openBilling()).ok, false);
  assert.equal(asked, false);
});

test('account: an error with nothing readable falls back to the wrapper', async () => {
  // A network failure has no JSON body. It must not end up as an empty toast.
  const account = new Account(storeOf([]), {
    client: async () => ({
      functions: { invoke: async () => ({ data: null, error: new Error('Failed to fetch') }) },
    }),
    configured: () => true,
  });
  account.user = { id: 'u1' };
  assert.equal((await account.openBilling()).reason, 'Failed to fetch');
});

test('a checkout that has not landed yet is waited for, not reported as free', async () => {
  /*
   * The gap this exists to cover: Stripe returns the browser the moment the
   * card clears and tells this project separately, over a webhook. Between the
   * two, `my_plan()` honestly answers "free" — to somebody who has just paid.
   *
   * So the reads are counted rather than the outcome only. One read would have
   * passed a test written against a fast webhook and failed every real person
   * whose webhook took two seconds.
   */
  const account = new Account(folders);
  // A plan that could not be read at all, then one that is honestly free,
  // then the webhook landing. `??` is wrong here: it would treat the
  // unreadable answer as the last one and end the wait on the first try.
  const answers = [null, { tier: 'free' }, { tier: 'premium', source: 'stripe' }];
  let asked = 0;
  account.refreshPlan = async () => answers[Math.min(asked++, answers.length - 1)];

  const waits = [];
  const settled = await account.waitForPlan({ wait: 1500, sleep: async (ms) => { waits.push(ms); } });

  assert.equal(settled.ok, true);
  assert.equal(settled.attempts, 3, 'it should have asked three times, not given up on the first');
  assert.equal(settled.plan.source, 'stripe');
  // Waited between the tries and not after the last one, which would be a
  // second and a half of nothing after the answer had already arrived.
  assert.deepEqual(waits, [1500, 1500]);
});

test('a webhook that never comes ends, and says so', async () => {
  /*
   * Bounded on purpose. A webhook that does not arrive is a real outcome — a
   * misconfigured endpoint, a signing secret rotated and not updated — and the
   * person waiting has been charged. A page that waits forever tells them
   * nothing; this returns so the caller can say what happened and where to
   * write.
   */
  const account = new Account(folders);
  let asked = 0;
  account.refreshPlan = async () => { asked += 1; return { tier: 'free' }; };

  const settled = await account.waitForPlan({ tries: 4, wait: 10, sleep: async () => {} });
  assert.equal(settled.ok, false);
  assert.equal(settled.attempts, 4);
  assert.equal(asked, 4, 'every try is a real read, not one read counted four times');
  // The last thing seen is handed back rather than nulled, so a caller can
  // tell "still free" from "could not ask at all".
  assert.deepEqual(settled.plan, { tier: 'free' });
});

test('waiting stops on whatever it was told to wait for', async () => {
  // The tier is a parameter rather than the string 'premium' baked in, so a
  // second paid tier later does not need this loop rewritten.
  const account = new Account(folders);
  account.refreshPlan = async () => ({ tier: 'pro' });
  const settled = await account.waitForPlan({ wanted: 'pro', tries: 3, sleep: async () => {} });
  assert.equal(settled.ok, true);
  assert.equal(settled.attempts, 1);
});

test('a trial does not count as the subscription somebody just paid for', async () => {
  /*
   * The near miss this exists for. `my_plan()` reports premium for anybody
   * inside their first thirty days, because a trial *is* premium — everything
   * works, which is the whole point. So a wait that ends on the tier ends on
   * the first read for every new account, and the app announces "Premium is
   * active on this account" to somebody whose payment never reached us.
   *
   * It would have looked right nearly every time, and been wrong in exactly
   * the case the waiting exists for.
   */
  const account = new Account(folders);
  const answers = [
    { tier: 'premium', source: 'trial' },
    { tier: 'premium', source: 'trial' },
    { tier: 'premium', source: 'stripe' },
  ];
  let asked = 0;
  account.refreshPlan = async () => answers[Math.min(asked++, answers.length - 1)];

  const settled = await account.waitForPlan({ source: 'stripe', sleep: async () => {} });
  assert.equal(settled.ok, true);
  assert.equal(settled.attempts, 3, 'the trial reads should not have ended the wait');
  assert.equal(settled.plan.source, 'stripe');
});

test('a trial that never becomes a purchase is reported as not arrived', async () => {
  // And the other half: the webhook does not come, the person is still on
  // their trial, and the app must say the payment has not been recorded rather
  // than point at the trial and call it done.
  const account = new Account(folders);
  account.refreshPlan = async () => ({ tier: 'premium', source: 'trial' });
  const settled = await account.waitForPlan({ source: 'stripe', tries: 3, sleep: async () => {} });
  assert.equal(settled.ok, false);
  assert.equal(settled.plan.source, 'trial');
});

test('account: the messages that promise an email say where it lands', async () => {
  /*
   * Reported from a real signup: "creating an account does not state
   * anything", and then, separately, "it did but it went to junk".
   *
   * Both halves are one failure. The confirmation is sent by Supabase's shared
   * sender unless the project is moved onto its own SMTP, which is exactly
   * what a mail filter distrusts - so the message lands in spam often enough
   * to be the expected case, not the unlucky one. Somebody who is not told to
   * look there concludes the signup silently failed and tries again, which
   * sends a second mail to the same folder.
   *
   * Asserted on both messages that promise mail, because the sign-in link has
   * the same sender and the same problem.
   */
  const client = fakeClient();
  client.auth.signUp = async (options) => {
    client.calls.push(['signUp', options]);
    return { data: { session: null, user: { identities: [{ provider: 'email' }] } }, error: null };
  };
  const account = new Account(folders, { client: async () => client, configured: () => true });

  await account.signUp('new@example.com', 'hunter2');
  assert.match(account.message, /spam|junk/i, 'the signup message does not say where to look');
  // And it confirms the account was made, because the screen is otherwise
  // unchanged: no session, so the same form redraws exactly as it was.
  assert.match(account.message, /account created/i);

  await account.signInWithLink('new@example.com');
  assert.match(account.message, /spam|junk/i, 'the link message does not say where to look');
});

test('account: being told an address already exists is not told to check the inbox', async () => {
  // The one case where naming spam would be a lie: nothing was sent. Guarded
  // separately because the spam clause was added to the neighbouring branch
  // and pasting it one line further up would be silent.
  const client = fakeClient();
  client.auth.signUp = async (options) => {
    client.calls.push(['signUp', options]);
    return { data: { session: null, user: { identities: [] } }, error: null };
  };
  const account = new Account(folders, { client: async () => client, configured: () => true });
  await account.signUp('taken@example.com', 'hunter2');
  assert.doesNotMatch(account.message, /spam|junk|check your email/i);
});

/* ------------------------------------------------- forgetting the password */

/*
 * There was no way back in at all.
 *
 * "Email me a link" signs you in without one, and was the only thing resembling
 * an answer - but it is labelled as a convenience, so the person who has
 * actually forgotten theirs has no reason to read it as being for them, and
 * taking it leaves them signed in with a password they still do not know and
 * nowhere to set one. Reported as the plain question: what if someone forgot
 * their password too?
 */
test('account: a reset link is sent, and told where to come back to', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await account.resetPassword('  A@Example.com  ');

  const [name, email, options] = client.calls.at(-1);
  assert.equal(name, 'resetPasswordForEmail');
  // Trimmed and lowercased, like every other address this file handles.
  assert.equal(email, 'a@example.com');
  assert.equal(options.redirectTo, 'https://app.halfstop.app/?m=x',
    'the reset link would land on the project Site URL rather than back here');
});

test('account: the reset says the same thing whether or not the address exists', async () => {
  /*
   * Deliberate. A different answer for a registered address turns this form
   * into a way to ask whether somebody has an account here, so the wording is
   * conditional and the test pins it that way - otherwise somebody later reads
   * the vagueness as sloppiness and "fixes" it into a disclosure.
   */
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await account.resetPassword('nobody@example.com');
  assert.match(account.message, /^If nobody@example\.com has an account/);
});

test('account: a reset needs an address before it needs anything else', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await assert.rejects(() => account.resetPassword('   '), /Enter your email address/);
  assert.equal(client.calls.length, 0, 'it asked the server about an empty address');
});

test('account: a new password has to be long enough to be one', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await assert.rejects(() => account.setPassword('short'), /at least 8/);
  assert.equal(client.calls.length, 0, 'it sent a password the server would only reject');

  await account.setPassword('long enough to count');
  // Found by name rather than taken from the end: setting a password also
  // fires the notice email, so the last call is no longer the update.
  const update = client.calls.find(([name]) => name === 'updateUser');
  assert.ok(update, 'the password was never sent to the server');
  assert.equal(update[1].password, 'long enough to count');
});

/* ------------------------------------- telling the address it changed */

/*
 * Supabase sends the reset link and then nothing.
 *
 * The change itself is silent, so the one person who most needs to know it
 * happened - the account holder who did not do it - finds out when they can no
 * longer sign in. Whoever is holding the session already knows; they are not
 * who this is for.
 */
test('account: changing the password tells the address it changed', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await account.setPassword('long enough to count');
  // The notice is fired without being awaited, so that a slow mail provider
  // cannot hold up the panel. One turn is enough for it to have been asked for.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const notice = client.calls.find(([name, fn]) => name === 'invoke' && fn === 'password-changed');
  assert.ok(notice, 'nothing told the account holder their password changed');

  /*
   * And it carries no address.
   *
   * The function reads the address off the verified token. A body naming one
   * is a body somebody else can write, and a function holding a mail key that
   * sends wherever the request says is an open relay wearing this domain. This
   * is the client half of keeping that true.
   */
  const body = notice[2]?.body || {};
  assert.deepEqual(Object.keys(body), [], 'the notice named an address it should not have');
});

test('account: a notice that cannot be sent does not undo the password', async () => {
  /*
   * The password has already changed by the time the notice is attempted. An
   * error surfaced here would report failure for something that succeeded -
   * and the obvious response to that error is to try again with a password
   * that is now the old one.
   */
  const client = fakeClient({ functionError: 'Resend is having a bad minute' });
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await assert.doesNotReject(() => account.setPassword('long enough to count'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(account.status, 'signed-in');
  assert.match(account.message, /Password changed/);
});

test('account: setting the password ends the recovery, and says so', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  account.recovering = true;
  await account.setPassword('long enough to count');

  assert.equal(account.recovering, false, 'the panel would keep asking for a new password');
  assert.equal(account.status, 'signed-in');
  assert.match(account.message, /Password changed/);
});

test('account: arriving on a reset link asks for a password, not a welcome', async () => {
  /*
   * Supabase exchanges a recovery link for an ordinary session and fires
   * PASSWORD_RECOVERY. Without the flag the panel would simply show somebody
   * signed in and never ask for the new password - which leaves them exactly
   * where they started the next time the session lapses, having used the one
   * link they were sent.
   */
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  await account.init();

  client.fired.handler('PASSWORD_RECOVERY', { user: { id: 'u1', email: 'a@example.com' } });

  assert.equal(account.recovering, true);
  assert.equal(account.status, 'signed-in');
  assert.match(account.message, /Choose a new password/);
});

test('account: the sign-in that comes with a reset link does not cancel it', async () => {
  /*
   * The recovery exchange emits SIGNED_IN as well, and the order is not
   * promised. If SIGNED_IN is allowed to overwrite the state, the new-password
   * form disappears before it is seen and the panel says nothing at all about
   * why this person is here.
   */
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  await account.init();

  client.fired.handler('PASSWORD_RECOVERY', { user: { id: 'u1' } });
  client.fired.handler('SIGNED_IN', { user: { id: 'u1' } });

  assert.equal(account.recovering, true, 'the new-password form vanished before it could be used');
  assert.match(account.message, /Choose a new password/);
});

test('account: signing out clears a half-finished reset', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');
  await account.init();

  client.fired.handler('PASSWORD_RECOVERY', { user: { id: 'u1' } });
  client.fired.handler('SIGNED_OUT', null);

  assert.equal(account.recovering, false, 'an abandoned reset would follow the account around');
  assert.equal(account.status, 'signed-out');
});
