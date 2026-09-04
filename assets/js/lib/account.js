/**
 * Supabase account: sign in, sign out, and folder sync.
 *
 * Loads supabase-js only when the app is actually configured for it, so a
 * deployment with no Supabase project pays nothing for the feature and behaves
 * exactly as it did before — folders in the browser, no sign-in button.
 *
 * Only the publishable key is ever used here. The secret key bypasses row-level
 * security and must never reach a browser.
 */

import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { mergeFolders, rowToFolder, folderToRow, missingColumn } from './sync.js';

const SUPABASE_VERSION = '2.45.4';
const CDN = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_VERSION}/+esm`;
const TABLE = 'folders';

export function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Where an emailed link should come back to.
 *
 * Every auth call has to say this, and signUp did not. Without it Supabase
 * falls back to the project's Site URL, which is a setting in a dashboard
 * rather than anything this repository can see - so a confirmation email
 * pointed at whatever host happened to be configured there, and the link
 * landed on a 404 carrying a valid token that nothing was listening for.
 *
 * The current page rather than a constant, so a link opened from a shared map
 * comes back to that map. The fragment is dropped because that is where the
 * token arrives, and sending the old one back would be asking to be handed a
 * stale session.
 *
 * This is necessary and not sufficient: Supabase only honours a redirect that
 * matches its allow list, and silently falls back to the Site URL otherwise.
 * The deployment's URL has to be in Authentication -> URL Configuration for
 * this to have any effect at all.
 */
function returnTo() {
  return window.location.href.split('#')[0];
}

/**
 * What to call somebody.
 *
 * The name they typed into the profile first; failing that, whatever Apple or
 * Google sent along with the sign-in, which each call something different.
 * Empty rather than the email when there is nothing, so the caller decides
 * what an address should look like in that spot.
 */
export function displayName(user) {
  const meta = user?.user_metadata || {};
  for (const key of ['display_name', 'full_name', 'name']) {
    const value = String(meta[key] || '').trim();
    if (value) return value;
  }
  return '';
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let clientPromise = null;

async function getClient() {
  if (!isConfigured()) return null;
  if (!clientPromise) {
    clientPromise = import(/* @vite-ignore */ CDN)
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      }))
      .catch((error) => {
        clientPromise = null;
        throw new Error(`Could not load the accounts library: ${error.message}`);
      });
  }
  return clientPromise;
}

/**
 * Account state and folder sync.
 *
 * Emits 'change' whenever the signed-in user or the sync status moves, so the
 * UI can be a pure function of `account.state`.
 */
export class Account extends EventTarget {
  /*
   * The client arrives through the constructor so this class can be tested.
   *
   * It used to reach for a module-level singleton that imports supabase-js
   * from a CDN, which meant none of the sign-in, sign-out or returning-link
   * paths could be exercised without a network and a real project - so none
   * of them were, and a missing emailRedirectTo shipped and sent a
   * confirmation email to somebody else's host.
   *
   * Both options default to today's behaviour, so nothing but the tests
   * passes anything.
   */
  constructor(folders, { client = getClient, configured = isConfigured } = {}) {
    super();
    this.folders = folders;
    this.getClient = client;
    this.isConfigured = configured;
    this.user = null;
    this.status = configured() ? 'signed-out' : 'unavailable';
    this.message = '';
    this.syncing = false;
    this.lastSyncAt = null;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  setStatus(status, message = '') {
    this.status = status;
    this.message = message;
    this.emit();
  }

  /** Restore an existing session and start watching for auth changes. */
  async init() {
    if (!this.isConfigured()) return;

    /*
     * Read before Supabase eats it.
     *
     * `detectSessionInUrl` consumes the fragment and clears it, which is the
     * behaviour you want and also means that by the time anything here could
     * check, the evidence is gone. So the hash is captured first - only to
     * report on, never to parse into a session.
     */
    const arriving = String(window.location.hash || '');
    let client;
    try {
      client = await this.getClient();
    } catch (error) {
      this.setStatus('error', error.message);
      return;
    }

    const { data } = await client.auth.getSession();
    this.user = data?.session?.user || null;

    /*
     * A link that came back and did not work has to say so.
     *
     * Supabase reports a refused link in the fragment - an expired token, a
     * redirect the project does not allow - and without this the page simply
     * loads signed out, which is indistinguishable from never having clicked
     * the link at all. That silence is most of why a broken confirmation
     * looks like a broken app.
     */
    if (!this.user && /[#&]error=/.test(arriving)) {
      const params = new URLSearchParams(arriving.replace(/^#/, ''));
      const detail = params.get('error_description') || params.get('error') || '';
      this.setStatus('signed-out', `That link did not work: ${detail.replace(/\+/g, ' ')}`);
      return;
    }
    if (!this.user && /[#&]access_token=/.test(arriving)) {
      this.setStatus('signed-out',
        'That sign-in link arrived but could not be used. It may have already been opened, '
        + 'or this address may not be allowed by the account service.');
      return;
    }
    this.setStatus(this.user ? 'signed-in' : 'signed-out');

    client.auth.onAuthStateChange((event, session) => {
      this.user = session?.user || null;
      if (event === 'SIGNED_IN') {
        this.setStatus('signed-in');
        this.sync();
      } else if (event === 'SIGNED_OUT') {
        this.setStatus('signed-out');
      }
    });

    if (this.user) this.sync();
  }

  async signUp(email, password) {
    const client = await this.getClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: returnTo() },
    });
    if (error) throw new Error(error.message);

    /*
     * An address that already has an account gets a success and no email.
     *
     * Supabase will not tell a stranger whether an address is registered, so
     * signing up again returns 200 with a user object, no session, and an
     * empty `identities` array - and sends nothing. Read as "no session", that
     * is indistinguishable from a fresh signup awaiting confirmation, so this
     * told people to check an inbox that was never going to receive anything.
     * Reported as exactly that: a create-account request with nothing back.
     *
     * `identities` empty is the documented signal. Guarded on the array being
     * present so a future response shape that omits it falls through to the
     * ordinary message rather than accusing everyone of already existing.
     */
    const identities = data?.user?.identities;
    if (Array.isArray(identities) && identities.length === 0) {
      this.setStatus('signed-out',
        'That address already has an account. Sign in below, or use "Email me a link" '
        + 'if you have forgotten the password.');
      return { confirmed: false, existing: true };
    }

    // With email confirmation on, there is no session yet — say so rather than
    // leaving the user staring at an unchanged screen.
    if (!data.session) {
      this.setStatus('signed-out', 'Check your email for a confirmation link, then sign in.');
      return { confirmed: false };
    }
    return { confirmed: true };
  }

  async signIn(email, password) {
    const client = await this.getClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return true;
  }

  /**
   * Sign in through Apple or Google instead of an emailed link.
   *
   * The reason this exists is that there is no link to break. Every problem
   * with the email flow so far has been about where a message lands - a
   * redirect the project does not allow, a host that is not this one, a link
   * opened on a different device - and none of those apply to a provider
   * round trip that comes straight back.
   *
   * Two things it does not solve, said here so they are not discovered later:
   * the redirect still has to be in the project's allow list, exactly as the
   * email one does; and inside the app the return address is the web view's
   * own origin rather than this site, which needs a deep link set up before it
   * will work there. On the web it works as soon as the provider is enabled.
   */
  async signInWithProvider(provider) {
    const client = await this.getClient();
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: returnTo() },
    });
    // Success navigates away, so anything that returns here is a refusal.
    if (error) throw new Error(error.message);
    return true;
  }

  /** Passwordless: Supabase emails a one-time link back to this page. */
  async signInWithLink(email) {
    const client = await this.getClient();
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: returnTo() },
    });
    if (error) throw new Error(error.message);
    this.setStatus('signed-out', `Sent a sign-in link to ${email}. Open it on this device.`);
    return true;
  }

  async signOut() {
    /*
     * Signing out locally even when the server call fails.
     *
     * It used to await signOut() with nothing around it, so a network error
     * threw before the local state was cleared and left the UI showing a
     * signed-in account - and the click handler had no catch, so the rejection
     * went to the console and the person saw a button that did nothing.
     *
     * Between "the server was not told" and "this device still thinks you are
     * signed in", the second is the one that matters to whoever is holding the
     * phone. Clear it either way; the token expires on its own.
     */
    try {
      const client = await this.getClient();
      await client.auth.signOut();
    } catch (error) {
      console.warn('[account] the sign-out call failed:', error?.message || error);
    }
    this.user = null;
    // Folders stay on the device after signing out. Clearing them would look
    // like data loss, and they are still this browser's own working set.
    this.setStatus('signed-out', 'Signed out. Your folders are still on this device.');
  }

  /**
   * Change the name or the address.
   *
   * Only what actually changed is sent. Supabase treats a new address as a
   * request rather than a fact - with its default settings it emails both the
   * old and the new inbox and changes nothing until the links are opened - so
   * sending an unchanged address back would trigger that dance for nothing.
   * The redirect is named for the same reason every other emailed link names
   * it: without one the link lands on whatever the project's Site URL is.
   *
   * @returns {{changed: boolean, emailPending: boolean}}
   */
  async updateProfile({ name = '', email = '' } = {}) {
    if (!this.user) throw new Error('Sign in first.');

    const nextName = String(name || '').trim();
    const nextEmail = String(email || '').trim().toLowerCase();
    const currentEmail = String(this.user.email || '').toLowerCase();
    if (nextEmail && !EMAIL_SHAPE.test(nextEmail)) throw new Error('That does not look like an email address.');

    const attributes = {};
    if (nextName !== displayName(this.user)) attributes.data = { display_name: nextName };
    const emailChanging = Boolean(nextEmail) && nextEmail !== currentEmail;
    if (emailChanging) attributes.email = nextEmail;

    if (!Object.keys(attributes).length) {
      this.setStatus('signed-in', 'Nothing changed.');
      return { changed: false, emailPending: false };
    }

    const client = await this.getClient();
    const { data, error } = await client.auth.updateUser(attributes, { emailRedirectTo: returnTo() });
    if (error) throw new Error(error.message);
    if (data?.user) this.user = data.user;

    this.setStatus('signed-in', emailChanging
      ? `Check the inbox at ${nextEmail} - and the old one - for links to confirm the change. `
        + 'Until both are opened, the old address is still the one that signs in.'
      : 'Saved.');
    return { changed: true, emailPending: emailChanging };
  }

  /**
   * Two-way sync of every folder.
   *
   * Pulls the server's rows, merges by last-write-wins per folder, applies the
   * result locally, then pushes anything the server is missing or behind on.
   */
  async sync() {
    if (!this.user || this.syncing) return null;
    this.syncing = true;
    this.setStatus('syncing');

    try {
      const client = await this.getClient();
      const { data, error } = await client.from(TABLE).select('*').eq('user_id', this.user.id);
      if (error) throw new Error(error.message);

      const remote = (data || []).map(rowToFolder);
      const result = mergeFolders(this.folders.snapshot(), remote);

      this.folders.replaceAll(result.merged);

      if (result.toPush.length) {
        const { error: upsertError } = await this.upsertFolders(client, result.toPush);
        if (upsertError) throw new Error(upsertError.message);
      }

      this.lastSyncAt = Date.now();
      this.syncing = false;
      this.setStatus('signed-in');
      return result;
    } catch (error) {
      this.syncing = false;
      // A failed sync is not a failed session: the local folders are untouched
      // and still authoritative for this device.
      this.setStatus('signed-in', `Sync failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Write folders up, surviving a database that predates a column.
   *
   * Adding parent_id to the row broke every push for anybody who had not run
   * schema.sql again: Postgres rejects the whole row over one unknown column,
   * so a rename, a new pin and a colour change all stopped travelling - not
   * just the nesting. When that is what came back, the rows go out again
   * without the column and the session remembers, so the next push is one
   * request rather than two.
   */
  async upsertFolders(client, folders) {
    const send = (withParent) => client
      .from(TABLE)
      .upsert(folders.map((folder) => folderToRow(folder, this.user.id, { withParent })),
        { onConflict: 'user_id,client_id' });

    if (this.noParentColumn) return send(false);

    const first = await send(true);
    if (!first.error || !missingColumn(first.error.message, 'parent_id')) return first;

    // Said once. It is worth knowing that nesting is not travelling, and not
    // worth saying again on every edit for the rest of the session.
    this.noParentColumn = true;
    console.warn('[account] folders.parent_id is missing; run supabase/schema.sql again for nesting to sync.');
    return send(false);
  }

  /**
   * Push one folder immediately, e.g. right after an edit.
   *
   * supabase-js resolves with an error rather than throwing, so the try/catch
   * that used to be here caught nothing at all: a rejected row looked exactly
   * like a successful one, and an edit that never reached the server was never
   * reported. The status line says so now.
   */
  async pushFolder(folder) {
    if (!this.user) return;
    try {
      const client = await this.getClient();
      const { error } = await this.upsertFolders(client, [folder]);
      // A network error is left quiet - the next full sync carries it, and
      // interrupting an edit to say the wifi dropped helps nobody. Anything
      // the server actively refused is a different thing and has to be said.
      if (error) this.setStatus('signed-in', `Not saved to your account: ${error.message}`);
    } catch {
      // Offline, or the client could not be built. The next sync carries it.
    }
  }
}
