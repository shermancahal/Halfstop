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
import { mergeFolders, rowToFolder, folderToRow } from './sync.js';

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
        const rows = result.toPush.map((folder) => folderToRow(folder, this.user.id));
        const { error: upsertError } = await client
          .from(TABLE)
          .upsert(rows, { onConflict: 'user_id,client_id' });
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

  /** Push one folder immediately, e.g. right after an edit. */
  async pushFolder(folder) {
    if (!this.user) return;
    try {
      const client = await this.getClient();
      await client.from(TABLE).upsert([folderToRow(folder, this.user.id)], { onConflict: 'user_id,client_id' });
    } catch {
      // Silent: the next full sync will carry it. Interrupting an edit with a
      // network error helps nobody.
    }
  }
}
