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
  return {
    calls,
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
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async signUp(options) { calls.push(['signUp', options]); return { data: { session: null }, error: null }; },
      async signInWithOtp(options) { calls.push(['signInWithOtp', options]); return { error: null }; },
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
