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

function fakeClient({ session = null, signOutError = null } = {}) {
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
      };
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
  globalThis.window = { location: { href: `https://shermancahal.github.io/Map/?m=x${hash}`, hash } };
};

test('account: every emailed link is told where to come back to', async () => {
  const client = fakeClient();
  const account = new Account(folders, { client: async () => client, configured: () => true });
  withHash('');

  await account.signUp('a@example.com', 'secret');
  await account.signInWithLink('a@example.com');

  const back = 'https://shermancahal.github.io/Map/?m=x';
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
  assert.equal(client.calls[0][1].options.emailRedirectTo, 'https://shermancahal.github.io/Map/?m=x');
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
    ['signInWithOAuth', 'apple', 'https://shermancahal.github.io/Map/?m=x'],
    ['signInWithOAuth', 'google', 'https://shermancahal.github.io/Map/?m=x'],
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
  assert.equal(options.emailRedirectTo, 'https://shermancahal.github.io/Map/?m=x',
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
