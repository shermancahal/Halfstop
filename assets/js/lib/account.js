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
import { canEdit, markShared, normaliseEmail, readRole } from './shares.js';
import { can, gateReason } from './tiers.js';

const SUPABASE_VERSION = '2.45.4';

/*
 * From this repository, not from a CDN.
 *
 * It used to be imported from jsdelivr at runtime, which meant signing in
 * needed the network in an app that otherwise does not, the service worker
 * could not cache it because it is cross-origin, and jsdelivr could serve any
 * code it liked into a page holding somebody's session. Wrapped as a native
 * app it is also executable code downloaded at runtime that Apple never
 * reviewed. MapLibre was vendored for the first three reasons; this is the
 * same fix, run by tools/vendor-supabase.mjs.
 *
 * The UMD build rather than the ESM one, because it is the single
 * self-contained file: the package's ESM entry imports its dependencies by
 * bare specifier and would need a bundler, which this project deliberately
 * does not have.
 */
const VENDORED = `assets/vendor/supabase-js-${SUPABASE_VERSION}/supabase.js`;
const TABLE = 'folders';

/** The Edge Function that closes an account; see supabase/functions/. */
const DELETE_FUNCTION = 'delete-account';

/** The one that writes an invitation and sends it. */
const INVITE_FUNCTION = 'invite-to-folder';

/** Invitations, kept beside the folders they are about. */
const SHARES = 'folder_shares';

/**
 * Columns added to `folders` after it shipped.
 *
 * Named in one place because the handling is identical: a database that has
 * not run the current schema.sql rejects the whole row over any one of them,
 * and the push has to go out again without it rather than lose the edit.
 */
const LATER_COLUMNS = ['parent_id', 'trip', 'removed_items'];

/**
 * The "Continue with ..." buttons this app knows how to draw.
 *
 * Which of them to actually offer is not decided here and not decided in
 * config either: it is asked of the project, because the answer lives there.
 */
const PROVIDERS = ['apple', 'google'];

/** The support queue. Readable by one address, decided server-side. */
const TICKETS = 'support_tickets';

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

/**
 * Load the library, once, from a script tag.
 *
 * A UMD bundle rather than a module, so it arrives as a global instead of an
 * import. Its own loader lives here rather than being borrowed from engine.js,
 * which has the same twelve lines: importing that would pull the entire map
 * engine into admin.html, a page with no map on it.
 */
function loadVendored(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.append(script);
  });
}

async function getClient() {
  if (!isConfigured()) return null;
  if (!clientPromise) {
    clientPromise = loadVendored(VENDORED)
      .then(() => {
        const createClient = globalThis.supabase?.createClient;
        if (!createClient) throw new Error('the library loaded without createClient on it');
        return createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
      })
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
    /*
     * What this account is entitled to, as the server last answered.
     *
     * Held rather than computed. The browser cannot know when an account was
     * created or whether anybody granted it anything, and a version of this
     * that guessed would be a plan field in localStorage being treated as
     * true. Null means not asked yet, which is not the same as free.
     */
    this.plan = null;
    /*
     * Which sign-in providers the project has registered, as it last answered.
     *
     * Null means not asked yet, and the panel falls back to SITE.authProviders
     * for as long as that is true - which is empty, so it offers nothing.
     * Offering nothing is the honest state: a button that starts an OAuth
     * round trip to a provider nobody registered sends somebody to an error
     * page wearing Apple's or Google's branding, which reads as this site
     * being broken rather than unfinished.
     */
    this.providers = null;
    this.status = configured() ? 'signed-out' : 'unavailable';
    this.message = '';
    this.syncing = false;
    this.lastSyncAt = null;
    /*
     * Columns this server turns out not to have.
     *
     * A set rather than a flag each, because the failure is the same every
     * time and the handling should be too: Postgres rejects the whole row over
     * one unknown column, so adding a column to this file once broke every
     * push for anybody who had not run schema.sql again - a rename, a new pin
     * and a colour change all stopped travelling, not only the new thing.
     */
    this.missingColumns = new Set();
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

    // Asked before anything else needs it, and regardless of whether anybody
    // is signed in: the buttons it decides are the ones shown to somebody who
    // is not.
    this.refreshProviders();

    const { data } = await client.auth.getSession();
    this.user = data?.session?.user || null;
    if (this.user) this.refreshPlan();

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
        this.refreshPlan();
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

  async signOut({ sync = true } = {}) {
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
    /*
     * Everything goes to the server before the screen is cleared, and the
     * screen is not cleared unless that worked.
     *
     * Folders used to stay put, on the reasoning that removing them would look
     * like data loss. In practice it looked like the sign-out had not
     * happened: the pins, the folders and the waypoint list were all still
     * there, which is the state somebody signs out to leave behind - on a
     * shared machine especially.
     *
     * So they go, but only once they are somewhere else. A sync that fails
     * leaves them exactly where they are and says so, because "signed out" is
     * worth less than the only copy of a folder.
     *
     * Photographs are not touched either way. They are never uploaded, so this
     * device holds the only copy; the pins that point at them come back with
     * the folders on the next sign-in, ids and all.
     */
    const saved = sync && this.user ? await this.sync() : null;

    try {
      const client = await this.getClient();
      await client.auth.signOut();
    } catch (error) {
      console.warn('[account] the sign-out call failed:', error?.message || error);
    }
    this.user = null;
    this.plan = null;

    if (saved) {
      this.folders.replaceAll([]);
      this.setStatus('signed-out',
        'Signed out. Your folders are on your account and come back when you sign in.');
      return;
    }
    this.setStatus('signed-out',
      'Signed out. The last sync did not go through, so your folders are still on this '
      + 'device rather than lost.');
  }

  /**
   * Delete the account, and everything on the server with it.
   *
   * Apple requires an app that offers sign-in to offer this from inside the
   * app, and the privacy policy promises it. Both are satisfied by the rows
   * going: what identifies a person here is their email on the auth record and
   * the pins filed under their user id.
   *
   * The rows first, then the sign-out, in that order and never the reverse.
   * Row-level security checks the signed-in user, so signing out first would
   * leave a request with no authority to delete anything - it would succeed at
   * deleting nothing and report success.
   *
   * The auth record itself cannot be removed from the browser: deleting a user
   * needs the service key, and a service key in a page is a service key in
   * everybody's devtools. So it is removed by the `delete-account` Edge
   * Function, which holds that key server-side and reads whose account to
   * close from the caller's own verified token - never from anything the
   * request body says.
   *
   * The rows are still deleted from here first. If the function is unreachable
   * - not deployed yet, or a network that dropped - the data is gone either
   * way and the message says which of the two happened, rather than reporting
   * a deletion that did not finish.
   *
   * What is on the device is deliberately left alone. Somebody deleting an
   * account is asking us to forget them, not asking their phone to throw away
   * the folders they spent a season building - and if they did want that, the
   * app cannot tell the two apart, so it does the reversible one.
   */
  async deleteAccount() {
    if (!this.user) return { ok: false, reason: 'Not signed in.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { error } = await client.from(TABLE).delete().eq('user_id', this.user.id);
    if (error) {
      this.setStatus('signed-in', `Could not delete your data: ${error.message}`);
      return { ok: false, reason: error.message };
    }

    /*
     * Closing the account itself, while the session is still good for it.
     *
     * Invoked before the sign-out, for the same reason the rows are deleted
     * before it: the function identifies the caller from the token this
     * request carries, and there is no token after signing out.
     */
    let closed = false;
    let closeReason = '';
    try {
      const { data, error: fnError } = await client.functions.invoke(DELETE_FUNCTION);
      if (fnError) closeReason = fnError.message;
      else closed = Boolean(data?.ok);
    } catch (error) {
      closeReason = error?.message || String(error);
    }
    if (!closed && closeReason) console.warn('[account] the account was not closed:', closeReason);

    // Nothing to sync to any more, and a failed sync would report itself as
    // the reason the folders stayed - which would be the wrong story entirely.
    await this.signOut({ sync: false });

    this.setStatus('signed-out', closed
      ? 'Your account is closed and everything on the server is deleted. What is saved on '
        + 'this device is untouched.'
      : 'Your folders were deleted from the server, but closing the account itself did not '
        + 'go through. Write to support@halfstop.app and it will be finished by hand.');
    return { ok: true, closed };
  }

  /**
   * The folders other people have shared with this account.
   *
   * Two reads rather than a join: the folder rows come back through the
   * row-level policy that matches the invitation to this session's address,
   * and the invitation itself carries the owner's name, which the folders
   * table has no column for.
   *
   * Returns null rather than [] when the read fails, because the two mean
   * opposite things to the caller - "nobody has shared anything" would quietly
   * remove folders that a dropped connection simply could not fetch.
   */
  async pullShared(client) {
    if (!this.user) return null;
    try {
      const [{ data: rows, error: rowsError }, { data: invites, error: invitesError }] = await Promise.all([
        client.from(TABLE).select('*').neq('user_id', this.user.id),
        client.from(SHARES).select('owner_id, client_id, invited_by, role').neq('owner_id', this.user.id),
      ]);
      if (rowsError) throw new Error(rowsError.message);
      if (invitesError) throw new Error(invitesError.message);

      const byFolder = new Map((invites || []).map((row) => [`${row.owner_id}:${row.client_id}`, row]));
      return (rows || [])
        .filter((row) => !row.deleted)
        .map((row) => {
          const invite = byFolder.get(`${row.user_id}:${row.client_id}`);
          return markShared(rowToFolder(row), {
            ownerId: row.user_id,
            ownerName: invite?.invited_by || 'somebody',
            // Read every sync, never remembered. Withdrawing the right to edit
            // has to take effect on the next sync, not whenever the device
            // that had it happens to be reinstalled.
            role: invite?.role,
          });
        });
    } catch (error) {
      console.warn('[account] could not read shared folders:', error?.message || error);
      return null;
    }
  }

  /**
   * Invite somebody to view one folder.
   *
   * The row is written by the Edge Function rather than from here: it checks
   * the folder is actually the caller's before an invitation goes out naming
   * it, and it holds the key that sends the email. `emailed` is reported
   * separately from `ok` because an invitation recorded and not delivered is a
   * different thing to tell somebody about than one that failed outright.
   */
  async invite(clientId, email, folderName = '', role = 'viewer') {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { data, error } = await client.functions.invoke(INVITE_FUNCTION, {
      // Narrowed here as well as in the function. Not because the browser can
      // be trusted about it - it cannot, which is why the function narrows it
      // too - but so that a typo asks for less rather than for more.
      body: { clientId, email: normaliseEmail(email), folderName, role: readRole(role) },
    });
    if (error) return { ok: false, reason: error.message };
    if (!data?.ok) return { ok: false, reason: data?.error || 'The invitation was not accepted.' };
    return { ok: true, emailed: Boolean(data.emailed), reason: data.reason || '' };
  }

  /** Who a folder has been shared with, withdrawn invitations included. */
  async sharesFor(clientId) {
    if (!this.user) return [];
    const client = await this.getClient();
    if (!client) return [];
    const { data, error } = await client.from(SHARES).select('*')
      .eq('owner_id', this.user.id).eq('client_id', clientId);
    if (error) {
      console.warn('[account] could not read the invitations:', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Withdraw one invitation.
   *
   * Marked rather than deleted, so the row still says this was shared once -
   * and so the same address can be invited again without tripping the unique
   * key.
   */
  async revokeShare(clientId, email) {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };
    const { error } = await client.from(SHARES).update({ revoked: true })
      .eq('owner_id', this.user.id)
      .eq('client_id', clientId)
      .eq('invited_email', normaliseEmail(email));
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  }

  /**
   * The support queue, for whoever the policy lets read it.
   *
   * No check here that the reader is an administrator. There is one in the
   * markup, to decide whether to draw the page, and it is presentation: the
   * policy on the table is what refuses, server-side, where a browser cannot
   * reach it. Asking twice in the client would only make the weaker check look
   * like the real one.
   */
  async supportTickets({ limit = 200 } = {}) {
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.', tickets: [] };
    const { data, error } = await client.from(TICKETS).select('*')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) return { ok: false, reason: error.message, tickets: [] };
    return { ok: true, reason: '', tickets: data || [] };
  }

  /** Move one ticket along, or write a note on it. */
  async updateTicket(id, patch = {}) {
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };
    const { error } = await client.from(TICKETS)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
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

      /*
       * Carrying your own folders between devices is the metered part.
       *
       * A folder somebody shared with you is not: sharing is not on the
       * Premium list, and a folder you were invited to read should not vanish
       * because your own collection has stopped travelling. So the shared ones
       * are still fetched, and only the account's own folders wait.
       *
       * Said out loud rather than done quietly. Folders that stop syncing
       * without a word look exactly like folders that were lost.
       *
       * This is presentation, like everything else in tiers.js. What actually
       * costs money is the row policy and the bandwidth behind it, and neither
       * of those reads a plan yet.
       */
      if (!can('folderSync')) {
        const onlyShared = await this.pullShared(client);
        if (onlyShared !== null) {
          const held = this.folders.snapshot().filter((folder) => !folder.sharedFrom);
          this.folders.replaceAll([...held, ...onlyShared]);
        }
        this.lastSyncAt = Date.now();
        this.syncing = false;
        this.setStatus('signed-in', gateReason('folderSync'));
        return null;
      }

      const { data, error } = await client.from(TABLE).select('*').eq('user_id', this.user.id);
      if (error) throw new Error(error.message);

      /*
       * A database that predates parent_id returns rows without the key at
       * all, which is not the same thing as a folder that sits at the top -
       * and reading it as such let an un-migrated server flatten the tree on
       * every sync, silently, for whichever side happened to be newer.
       *
       * When the server cannot hold the answer its silence is not an
       * instruction. Each remote row is given back whatever this device
       * already believes about where that folder goes, so nesting neither
       * travels nor is destroyed until the column exists.
       *
       * This is also what re-arms the push after the migration: the read says
       * whether the column is there, so the first sync after running
       * schema.sql picks it up without anybody reloading anything.
       */
      const rows = data || [];
      const knowsParents = !rows.length || rows.some((row) => 'parent_id' in row);
        this.noteMissingColumns(rows);

      const local = this.folders.snapshot();
      const held = new Map(local.map((folder) => [folder.id, folder]));
      const remote = rows.map((row) => {
        const folder = rowToFolder(row);
        const ours = held.get(folder.id);
        /*
         * A column the server does not have comes back as silence, and silence
         * is not an instruction. Read as an answer, an un-migrated database
         * flattens the tree, clears the trip dates and forgets every deletion
         * on every sync - silently, for whichever side happened to be newer.
         * So each remote row is given back whatever this device already
         * believes, and nothing travels or is destroyed until the column
         * exists.
         */
        if (!knowsParents) folder.parentId = ours?.parentId || null;
        if (this.missingColumns.has('trip')) folder.trip = ours?.trip || null;
        if (this.missingColumns.has('removed_items')) folder.removedItems = ours?.removedItems || [];
        return folder;
      });

      /*
       * The server is the authority on what is shared, every sync.
       *
       * Read before the merge rather than after it, because a folder shared
       * for editing is now merged against its remote copy rather than simply
       * replaced - and a withdrawn invitation has to disappear rather than
       * linger as a copy nobody else can see. A read that failed returns null,
       * which the merge reads as "keep what is in hand" rather than as news
       * that every invitation was withdrawn.
       */
      const shared = await this.pullShared(client);
      const result = mergeFolders(local, remote, shared);

      this.folders.replaceAll(result.merged);

      if (result.toPush.length) {
        const { error: upsertError } = await this.upsertFolders(client, result.toPush);
        if (upsertError) throw new Error(upsertError.message);
      }

      if (result.toPushShared?.length) {
        const { error: sharedError } = await this.updateShared(client, result.toPushShared);
        if (sharedError) throw new Error(sharedError.message);
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
  /**
   * Ask the project which sign-in providers it actually has.
   *
   * A hand-kept list in config had to be edited to match a setting in a
   * dashboard, and the two drifting apart fails in both directions: a provider
   * registered and not listed is a button nobody sees, and a provider listed
   * and not registered is the error page above. The project already publishes
   * the answer at /auth/v1/settings, so ask it and let turning one on in
   * Supabase be the whole of turning one on.
   *
   * Unauthenticated on purpose: this is the question somebody asks before they
   * have a session, which is the only time the answer matters.
   */
  async refreshProviders() {
    if (!this.isConfigured()) return null;
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: SUPABASE_KEY },
      });
      if (!response.ok) throw new Error(`the project answered ${response.status}`);
      const settings = await response.json();
      const external = settings?.external || {};
      this.providers = PROVIDERS.filter((id) => external[id] === true);
      this.emit();
      return this.providers;
    } catch (error) {
      // Left null rather than empty: "could not ask" is not "there are none",
      // and the panel's fallback is already to offer nothing.
      console.warn('[account] could not read the sign-in providers:', error?.message || error);
      return null;
    }
  }

  /**
   * Ask the server what this account is entitled to.
   *
   * Quiet on failure, and deliberately: this decides what to draw, not what to
   * allow, so an unanswered question should leave the interface as it was
   * rather than announce a billing problem to somebody trying to look at a
   * map. Whatever is actually metered is refused server-side or it is not
   * refused at all.
   */
  async refreshPlan() {
    if (!this.user) { this.plan = null; return null; }
    try {
      const client = await this.getClient();
      const { data, error } = await client.rpc('my_plan');
      if (error) throw new Error(error.message);
      this.plan = data || null;
      this.emit();
      return this.plan;
    } catch (error) {
      console.warn('[account] could not read the plan:', error?.message || error);
      return this.plan;
    }
  }

  /** Which of the newer columns this server answered with, so a push can re-arm. */
  noteMissingColumns(rows) {
    if (!rows.length) return;
    for (const column of LATER_COLUMNS) {
      if (rows.some((row) => column in row)) this.missingColumns.delete(column);
      else this.missingColumns.add(column);
    }
  }

  /** What to send, given what this server has turned out not to have. */
  columnOptions() {
    return {
      withParent: !this.missingColumns.has('parent_id'),
      withTrip: !this.missingColumns.has('trip'),
      withRemovals: !this.missingColumns.has('removed_items'),
    };
  }

  /**
   * Send rows, dropping any column the server turns out not to have.
   *
   * Retried rather than guessed at, and only for the one rejection that means
   * "this database has not been migrated". Anything else the server refuses is
   * returned as it came, because a push that quietly strips columns until
   * something is accepted is a push that loses an edit without saying so.
   */
  async sendTolerantly(send) {
    for (let attempt = 0; attempt <= LATER_COLUMNS.length; attempt += 1) {
      const result = await send(this.columnOptions());
      if (!result?.error) return result;

      const named = LATER_COLUMNS.find((column) => !this.missingColumns.has(column)
        && missingColumn(result.error.message, column));
      if (!named) return result;

      // Said once per column. Worth knowing that something is not travelling,
      // not worth saying again on every edit for the rest of the session.
      this.missingColumns.add(named);
      console.warn(`[account] folders.${named} is missing; run supabase/schema.sql again so it can sync.`);
    }
    return send(this.columnOptions());
  }

  async upsertFolders(client, folders) {
    return this.sendTolerantly((options) => client
      .from(TABLE)
      .upsert(folders.map((folder) => folderToRow(folder, this.user.id, options)),
        { onConflict: 'user_id,client_id' }));
  }

  /**
   * Write back a folder somebody else owns and shared for editing.
   *
   * An update rather than an upsert, deliberately. Insert on this table is
   * owner-only, and an upsert is an insert that may turn into an update - so
   * it asks the policy for a permission a collaborator must not have, and gets
   * a rejection that reads like a bug rather than like the rule it is. There
   * is nothing to create here in any case: a collaborator can only change a
   * folder that already exists.
   *
   * One at a time because each row is keyed by a different owner. The first
   * refusal stops the rest, so a revoked invitation does not spend a request
   * per folder finding that out.
   */
  async updateShared(client, folders) {
    for (const folder of folders) {
      const ownerId = folder?.sharedFrom?.ownerId;
      if (!ownerId || !canEdit(folder)) continue;

      const result = await this.sendTolerantly((options) => {
        // The key identifies the row; sending it back as a value would be
        // asking to change it. The trigger would refuse anyway.
        const { user_id: _owner, client_id: _id, ...row } = folderToRow(folder, ownerId, options);
        return client.from(TABLE).update(row)
          .eq('user_id', ownerId)
          .eq('client_id', folder.id);
      });
      if (result?.error) return result;
    }
    return { error: null };
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
    // Looking at somebody's folder is not editing it, and a push that the
    // policy is certain to refuse is worth not making.
    if (folder?.sharedFrom && !canEdit(folder)) return;
    // Your own folders travel on the plan that carries them. A folder somebody
    // shared for editing is not yours and is not that.
    if (!folder?.sharedFrom && !can('folderSync')) return;
    try {
      const client = await this.getClient();
      const { error } = folder?.sharedFrom
        ? await this.updateShared(client, [folder])
        : await this.upsertFolders(client, [folder]);
      // A network error is left quiet - the next full sync carries it, and
      // interrupting an edit to say the wifi dropped helps nobody. Anything
      // the server actively refused is a different thing and has to be said.
      if (error) this.setStatus('signed-in', `Not saved to your account: ${error.message}`);
    } catch {
      // Offline, or the client could not be built. The next sync carries it.
    }
  }
}
