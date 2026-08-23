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
  constructor(folders) {
    super();
    this.folders = folders;
    this.user = null;
    this.status = isConfigured() ? 'signed-out' : 'unavailable';
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
    if (!isConfigured()) return;
    let client;
    try {
      client = await getClient();
    } catch (error) {
      this.setStatus('error', error.message);
      return;
    }

    const { data } = await client.auth.getSession();
    this.user = data?.session?.user || null;
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
    const client = await getClient();
    const { data, error } = await client.auth.signUp({ email, password });
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
    const client = await getClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return true;
  }

  /** Passwordless: Supabase emails a one-time link back to this page. */
  async signInWithLink(email) {
    const client = await getClient();
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split('#')[0] },
    });
    if (error) throw new Error(error.message);
    this.setStatus('signed-out', `Sent a sign-in link to ${email}. Open it on this device.`);
    return true;
  }

  async signOut() {
    const client = await getClient();
    await client.auth.signOut();
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
      const client = await getClient();
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
      const client = await getClient();
      await client.from(TABLE).upsert([folderToRow(folder, this.user.id)], { onConflict: 'user_id,client_id' });
    } catch {
      // Silent: the next full sync will carry it. Interrupting an edit with a
      // network error helps nobody.
    }
  }
}
