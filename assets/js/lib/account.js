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
import { safeStorage } from './folders.js';
import { can, gateReason, tierFor } from './tiers.js';
import {
  appShell, APP_RETURN, rememberReturn, sessionStore as tabStore, watchAppLinks,
} from './native-shell.js';

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

/** The one that opens a Stripe Checkout for whoever is signed in. */
const CHECKOUT_FUNCTION = 'stripe-checkout';

/** And the one that opens Stripe's billing portal, where a subscription ends. */
const PORTAL_FUNCTION = 'stripe-portal';

/** The one that asks Google what a Play purchase token bought, and records it. */
const PLAY_FUNCTION = 'play-billing';

/**
 * The one that manages other people's accounts.
 *
 * Every call here is refused by the function unless the address on the token
 * is in its own ADMIN_EMAILS. Nothing in this file is the check: a method that
 * exists in a page anybody can open is not a permission, and the refusal comes
 * back as an ordinary error the caller shows.
 */
const ADMIN_FUNCTION = 'admin-accounts';

/** Invitations, kept beside the folders they are about. */
const SHARES = 'folder_shares';

/**
 * Which account the folders on this device were last synced with.
 *
 * The folder store is one working set per browser, deliberately - it is what
 * somebody uses before they ever sign in - and it carried no record of whose
 * it was. Sync pushes whatever is local to whoever is signed in, so signing in
 * as a second account adopted the first account's collection wholesale and
 * wrote it to the server under the new user id.
 *
 * That is not hypothetical: it happened here on 2026-09-13, 27 folders and
 * 8,765 items, same client ids under both accounts. On a shared browser it is
 * worse than untidy - it is one person's places becoming rows on another
 * person's account.
 *
 * Sign-out already clears the folders once they are safely on the server, so
 * the intended state when switching accounts is an empty store. This is the
 * guard for every way that does not happen: a sign-out whose sync failed, a
 * session that simply expired, a second account signed into beside the first.
 *
 * Its own key rather than a field in the collection: the collection lives in
 * IndexedDB with a localStorage fallback and migrates between them, and this
 * has to be readable before any of that resolves.
 */
const OWNER_KEY = 'ab-maps-folder-owner-v1';

/** The stamp, as a pair of functions so a test needs no browser storage. */
export function folderOwnerStore(storage = safeStorage()) {
  return {
    read() {
      try {
        return storage?.getItem(OWNER_KEY) || null;
      } catch {
        return null;
      }
    },
    write(userId) {
      try {
        if (userId) storage?.setItem(OWNER_KEY, userId);
        else storage?.removeItem(OWNER_KEY);
      } catch {
        // Private mode, or site data switched off. A stamp that cannot be
        // kept is the state this guard already treats as unknown.
      }
      return userId || null;
    },
  };
}

/**
 * What to do with the folders on this device for the account signing in.
 *
 * `merge` is the ordinary two-way sync. `adopt` is the same merge for a set
 * with no stamp on it - the person who made folders before signing up, and
 * every device that predates this guard. `replace` is the one that matters:
 * the set belongs to a different account, so nothing local goes up and the
 * account's own folders are what this device shows.
 *
 * Replace is safe precisely because the stamp is only written after a sync
 * succeeded. A set stamped to another account is a set that account already
 * holds on the server, so dropping it here loses nothing - it is the same
 * position as signing out cleanly, which is what should have happened.
 *
 * An unstamped set is not treated that way, and that is deliberate. Nothing
 * says it was ever uploaded, and discarding folders somebody made offline to
 * fix a bug about folders would be the same mistake in the other direction.
 * It is adopted and stamped, so a device can cross accounts at most once more
 * and never again.
 */
export function folderDisposition(owner, userId) {
  if (!userId) return 'merge';
  if (!owner) return 'adopt';
  return owner === userId ? 'merge' : 'replace';
}

/** Injectable so a test of the waiting does not have to wait. */
const nap = (ms) => new Promise((resume) => { setTimeout(resume, ms); });

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
 * Where a link sent by email should come back to.
 *
 * Not returnTo(). A round trip through Google finishes seconds later in the
 * same tab, so coming back to the page somebody left is right. A link sent to
 * an inbox is a different thing entirely: it is opened minutes or days later,
 * often on another device and always in whatever browser the mail app decides,
 * and "the page you were on when you pressed the button" is then a destination
 * nobody chose and nothing prepared.
 *
 * It cost a day to learn that. A reset asked for on the homepage came back to
 * the homepage, which forwards auth fragments on to the map, which is a page
 * with a map on it and no reason to show a password form - so a link that had
 * worked perfectly looked broken. The account page exists to be the end of
 * that journey: one address, built for it.
 *
 * Same caveat as above and it bites harder here: this address must be in
 * Authentication -> URL Configuration, or Supabase silently substitutes the
 * Site URL and every one of these links goes somewhere else.
 */
function emailReturn() {
  /*
   * Inside the app the page's own address is `https://localhost/...`, which
   * is the phone's own web view and nowhere a mail client can reach. The app
   * answers to its scheme instead; ./native-shell.js turns the arrival back
   * into an ordinary visit to the account page, so everything below this
   * line about what happens there still holds.
   */
  if (appShell().native) return APP_RETURN;
  return new URL('account.html', window.location.href).href;
}

/**
 * The sentence a function actually sent, out from under the wrapper.
 *
 * supabase-js turns any non-2xx into a FunctionsHttpError reading "Edge
 * Function returned a non-2xx status code", and hangs the real response off
 * `context`. Left as it is, somebody told to cancel their existing
 * subscription first would instead read a sentence about status codes.
 */
async function readFunctionError(error) {
  try {
    const body = await error?.context?.json?.();
    return String(body?.error || '');
  } catch {
    return '';
  }
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

/**
 * Where a signed-in session is kept, named by us rather than by the hostname.
 *
 * supabase-js derives the localStorage entry from the first label of the API
 * URL: `sb-<project-ref>-auth-token` today, `sb-auth-auth-token` the moment
 * SUPABASE_URL becomes a custom domain like auth.halfstop.app. A session is
 * only ever found under the name in force, so moving the project onto its own
 * domain would sign out every signed-in person on every device at once, with
 * no error and nothing in any log to explain it.
 *
 * Pin the name and the hostname is free to move. adoptSession() below carries
 * a session already stored under the derived name onto this one, so landing
 * this signs nobody out either.
 */
export const SESSION_KEY = 'sb-halfstop-auth-token';

/** The name supabase-js would derive for a URL, by its own rule. */
export function derivedSessionKey(url) {
  try {
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  } catch {
    return '';
  }
}

/** localStorage, or null where reading it throws - private modes do that. */
function sessionStore() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Carry an existing session onto the pinned name, before any client reads it.
 *
 * The old entry is left in place deliberately. It costs one stale copy of a
 * refresh token, which signOut() clears and the server revokes anyway, and it
 * buys the one thing worth having here: rolling this deployment back puts
 * everybody exactly where they were instead of signing them all out, which is
 * the failure the pinned name exists to prevent.
 */
export function adoptSession(url = SUPABASE_URL, store = sessionStore()) {
  const from = derivedSessionKey(url);
  if (!store || !from || from === SESSION_KEY) return false;
  try {
    if (store.getItem(SESSION_KEY)) return false;
    const held = store.getItem(from);
    if (!held) return false;
    store.setItem(SESSION_KEY, held);
    return true;
  } catch {
    // Storage full or blocked. supabase-js will sign them in again; it is not
    // worth failing the whole client over.
    return false;
  }
}

/** Drop the entry adoptSession() copied from, once the session is over. */
function forgetAdoptedSession(url = SUPABASE_URL, store = sessionStore()) {
  const from = derivedSessionKey(url);
  if (!store || !from || from === SESSION_KEY) return;
  try {
    store.removeItem(from);
  } catch {
    /* Nothing to do about it, and nothing depends on it. */
  }
}

async function getClient() {
  if (!isConfigured()) return null;
  if (!clientPromise) {
    clientPromise = loadVendored(VENDORED)
      .then(() => {
        const createClient = globalThis.supabase?.createClient;
        if (!createClient) throw new Error('the library loaded without createClient on it');
        adoptSession();
        return createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storageKey: SESSION_KEY,
          },
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
  constructor(folders, { client = getClient, configured = isConfigured, syncs = true,
    owner = folderOwnerStore(), shell = appShell } = {}) {
    super();
    /*
     * Whether this page is inside the app. A function rather than the answer,
     * so a test can say "the app" without defining a global the rest of the
     * suite would then also see.
     */
    this.shell = shell;
    this.folders = folders;
    // Which account this device's folders belong to; see OWNER_KEY.
    this.owner = owner;
    /*
     * Whether this account has folders worth syncing.
     *
     * The landing page, the help page and the admin queue hold a stub store
     * with nothing in it - they have no IndexedDB, no photo vault and no
     * reason to pull one onto a page showing a help article. Before this they
     * still ran a full folder sync on load, which fetched every row to merge
     * into nothing and, when the network refused, wrote "Sync failed:
     * TypeError: Failed to fetch" into a panel on a page that has never
     * synced anything.
     *
     * Not a data hazard, which is worth stating because it looks like one: an
     * empty local set pulls the remote folders rather than deleting them -
     * deletions travel as tombstones, not as absences, and a merge from empty
     * pushes nothing. It is waste and a false alarm, not loss.
     */
    this.syncs = syncs;
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
    /*
     * Whether this session came from a password reset link.
     *
     * A recovery link produces an ordinary signed-in session, so without this
     * the panel cannot tell somebody who arrived to choose a new password from
     * somebody who simply signed in. Cleared by setPassword and by signing
     * out, so a half-finished reset does not follow the account around.
     */
    this.recovering = false;
    /*
     * Whether this page was opened by an email link that did not work.
     *
     * Read once by the page that mounts the panel, to put the reason in front
     * of somebody rather than leaving it inside a closed menu.
     */
    this.linkFailed = false;
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
     * In the app, an emailed link or a finished Google sign-in arrives as an
     * event rather than as this page's URL. Listening turns it into a visit to
     * the page the website would have landed on, fragment and all - so it
     * comes through the lines below exactly as a link does on the website.
     * Nothing, in a browser.
     */
    watchAppLinks({ shell: this.shell() });

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

    /*
     * Listening before asking, which is not a style choice.
     *
     * supabase-js reads the fragment while the client is being built, and
     * announces the result on a timer: it saves the session, then schedules
     * PASSWORD_RECOVERY for the next tick. getSession() waits for all of that
     * to finish - so a subscriber registered after it is registered after the
     * announcement has already gone out to nobody, and the event is simply
     * gone. Nothing errors. The person is signed in, holding a reset link,
     * and no page in this app ever hears that they came to set a password.
     *
     * Registering here instead puts the subscriber in place while the library
     * is still fetching the user, which is a network round trip and therefore
     * ahead of any timer. Confirmed in a browser against the real library:
     * before this, a recovery link delivered INITIAL_SESSION and nothing else.
     */
    client.auth.onAuthStateChange((event, session) => {
      this.user = session?.user || null;
      /*
       * A recovery link signs somebody in, which is not what they came for.
       *
       * Supabase exchanges the link for an ordinary session and fires this
       * event, so without the flag the panel would simply show them signed in
       * and never ask for the new password - leaving them right back here the
       * next time the session lapses. The flag is what makes the panel put the
       * form up, and setPassword() is what clears it.
       *
       * Checked before SIGNED_IN because the recovery exchange emits both, and
       * whichever arrives second must not undo the first.
       */
      if (event === 'PASSWORD_RECOVERY') {
        this.recovering = true;
        this.setStatus('signed-in', 'Choose a new password.');
        return;
      }
      if (event === 'SIGNED_IN') {
        if (this.recovering) return;
        this.setStatus('signed-in');
        this.refreshPlan();
        this.sync();
      } else if (event === 'SIGNED_OUT') {
        this.recovering = false;
        this.setStatus('signed-out');
      }
    });

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
    /*
     * A link that came back and did not work has to say so where it is seen.
     *
     * The message alone was not enough: it renders inside the account panel,
     * and the panel is shut when the page loads. Somebody followed a reset
     * link, got a page that looked exactly like an ordinary visit, and only
     * found the explanation by opening the gear for unrelated reasons.
     *
     * The flag is what the page acts on - it opens the menu and says it out
     * loud. Same shape as `recovering`, for the same reason.
     */
    if (!this.user && /[#&]error=/.test(arriving)) {
      const params = new URLSearchParams(arriving.replace(/^#/, ''));
      const detail = params.get('error_description') || params.get('error') || '';
      this.linkFailed = true;
      this.setStatus('signed-out', `That link did not work: ${detail.replace(/\+/g, ' ')}`);
      return;
    }
    if (!this.user && /[#&]access_token=/.test(arriving)) {
      this.linkFailed = true;
      this.setStatus('signed-out',
        'That sign-in link arrived but could not be used. Email links work once, so '
        + 'this one may already have been opened - by another browser, or by a tap that '
        + 'opened it twice. Ask for a fresh one.');
      return;
    }
    // Not over the top of a recovery, which has already said the one thing
    // that matters and would otherwise be replaced by a plain "signed in".
    if (!this.recovering) this.setStatus(this.user ? 'signed-in' : 'signed-out');

    if (this.user) this.sync();
  }

  async signUp(email, password) {
    const client = await this.getClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: emailReturn() },
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

    /*
     * With email confirmation on there is no session yet, so say so rather
     * than leaving somebody staring at an unchanged screen.
     *
     * Spam is named because that is where it went, reported from a real
     * signup: the confirmation comes from Supabase's shared sender unless the
     * project is put on its own SMTP, and a shared sender on somebody else's
     * domain is exactly what a mail filter is built to distrust. Telling
     * people where to look costs a clause; not telling them costs the account.
     */
    if (!data.session) {
      this.setStatus('signed-out',
        'Account created. Check your email for a confirmation link, then sign in. '
        + 'It often lands in spam or junk, so look there before trying again.');
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
   * The way back in for somebody who does not know their password.
   *
   * There was no way back in at all. "Email me a link" is one - it signs you
   * in without a password - but it is labelled as a convenience and reads as
   * one, so the person who has actually forgotten theirs has no reason to
   * think it is for them. And even taking it, they arrive signed in with a
   * password they still do not know and no screen anywhere that sets one.
   *
   * So this sends Supabase's recovery mail, and `setPassword` below finishes
   * the job when they come back.
   */
  async resetPassword(email) {
    const address = String(email || '').trim().toLowerCase();
    if (!address) throw new Error('Enter your email address first.');
    const client = await this.getClient();
    const { error } = await client.auth.resetPasswordForEmail(address, { redirectTo: emailReturn() });
    if (error) throw new Error(error.message);
    /*
     * Said the same way whether or not the address has an account.
     *
     * Supabase answers this call identically either way, on purpose: a
     * different answer for a registered address turns the form into a way to
     * ask whether somebody has an account here. Worth saying out loud so the
     * vagueness is not mistaken for carelessness and 'fixed' later.
     */
    this.setStatus('signed-out',
      `If ${address} has an account, a reset link is on its way. Open it on this device, `
      + 'and check spam if it is not there.');
    return true;
  }

  /**
   * Set the password, both for a reset and for somebody already signed in.
   *
   * One method rather than two because Supabase makes no distinction: a
   * recovery link produces an ordinary session with a flag on it, and the call
   * that sets the password is the same call either way.
   */
  async setPassword(password) {
    const next = String(password || '');
    if (next.length < 8) throw new Error('Use at least 8 characters.');
    const client = await this.getClient();
    const { data, error } = await client.auth.updateUser({ password: next });
    if (error) throw new Error(error.message);
    if (data?.user) this.user = data.user;
    this.recovering = false;
    this.setStatus('signed-in', 'Password changed. You are signed in.');

    /*
     * Tell the address that the password changed - and never let that failing
     * look like the change failing.
     *
     * The change has already happened by this line. Whoever is holding this
     * session knows; the person who needs telling is the account holder who
     * did not do it, and they are not at this screen. Supabase sends the reset
     * link and then nothing, so the notice is ours to send.
     *
     * Deliberately not awaited into the result and deliberately swallowed: a
     * mail provider having a bad minute must not put an error in front of
     * somebody whose password is already changed, because the obvious response
     * to that error is to try again with a password that is now the old one.
     */
    client.functions.invoke('password-changed', { body: {} })
      .then(({ data: sent, error: sendError }) => {
        const reason = sendError?.message || (sent && sent.sent === false ? sent.reason : '');
        if (reason) console.warn('[account] password changed, notice not sent:', reason);
      })
      .catch((sendError) => {
        console.warn('[account] password changed, notice not sent:', sendError?.message || sendError);
      });

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
   * The redirect still has to be in the project's allow list, exactly as the
   * email one does. On the web it works as soon as the provider is enabled.
   *
   * IN THE APP
   *
   * Google refuses to sign anybody in inside an embedded web view - it answers
   * `disallowed_useragent` - and the app is one. So the round trip goes out
   * through the system browser (a Custom Tab on Android), and comes back to
   * the app's own scheme, where ./native-shell.js picks it up.
   * `skipBrowserRedirect` is what hands the URL back here instead of
   * navigating this web view to it.
   */
  async signInWithProvider(provider) {
    const client = await this.getClient();
    const shell = this.shell();
    if (shell.native) {
      const browser = shell.plugin('Browser');
      if (!browser?.open) {
        throw new Error('This version of the app cannot open that sign-in. Update it, '
          + 'or sign in with your email address instead.');
      }
      const { data, error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: APP_RETURN, skipBrowserRedirect: true },
      });
      if (error) throw new Error(error.message);
      if (!data?.url) throw new Error('The sign-in page did not open. Try again.');
      rememberReturn(tabStore());
      await browser.open({ url: data.url });
      return true;
    }
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
      options: { emailRedirectTo: emailReturn() },
    });
    if (error) throw new Error(error.message);
    this.setStatus('signed-out',
      `Sent a sign-in link to ${email}. Open it on this device, and check spam if it is not there.`);
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
    // The library clears its own entry; this clears the one adoptSession()
    // copied from, so signing out leaves nothing behind under either name.
    forgetAdoptedSession();
    this.user = null;
    this.plan = null;

    if (saved) {
      this.folders.replaceAll([]);
      // The stamp goes with them. An empty store belongs to nobody, and the
      // next person to sign in on this browser starts from their own folders.
      this.owner.write(null);
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

  /**
   * Ask for a Stripe Checkout, and get back somewhere to send the browser.
   *
   * Nothing about who is paying travels in the request. The function reads the
   * user from the token on this session, because a body saying which account
   * to subscribe is a body somebody else can write.
   */
  async startCheckout({ plan = 'month', returnTo = '' } = {}) {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { data, error } = await client.functions.invoke(CHECKOUT_FUNCTION, {
      // A plan name, never a price. The function holds the ids, so a browser
      // cannot name what it pays.
      body: { plan, returnTo: returnTo || window.location.href.split('#')[0] },
    });
    /*
     * A refusal carries its own sentence, and it has to survive.
     *
     * supabase-js wraps a non-2xx in a FunctionsHttpError whose message is
     * "Edge Function returned a non-2xx status code" - which is true and tells
     * nobody anything. The useful part, "you already subscribe, cancel it
     * first", is in the body, so the body is read back rather than thrown away
     * in favour of the wrapper's message.
     */
    if (error) {
      const said = await readFunctionError(error);
      return { ok: false, reason: said || error.message };
    }
    if (!data?.ok || !data.url) return { ok: false, reason: data?.error || 'The checkout did not open.' };
    return { ok: true, url: data.url };
  }

  /**
   * Take the free month, once.
   *
   * WHY THIS IS A DATABASE FUNCTION AND NOT A WRITE
   *
   * The obvious shape is an insert: the browser writes itself a row saying
   * premium until thirty days from now. It is also the shape where anybody
   * with devtools gives themselves Premium until 2075, because a row the
   * client can write is a row the client can write anything into. So the
   * entitlements table has no insert policy for anybody, and the only way in
   * is public.start_trial(), which decides the dates itself and refuses a
   * second trial. Nothing in this method is trusted with any of that - it
   * sends no argument at all, not even who is asking.
   *
   * The refusals come back as sentences rather than as failures, because they
   * are things a person should be told: "this account has already had its free
   * month" is an answer, not an error.
   */
  async startTrial() {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { data, error } = await client.rpc('start_trial');
    if (error) return { ok: false, reason: error.message };
    if (!data?.ok) return { ok: false, reason: data?.error || 'The trial did not start.' };

    /*
     * The function hands back the new plan, so this does not have to ask for
     * it again. Worth doing rather than calling refreshPlan(): the row was
     * written a moment ago by the same statement that returned this, so it
     * cannot be the stale read that a second round trip occasionally is.
     */
    this.plan = data.plan || this.plan;
    this.emit();
    return { ok: true, plan: this.plan };
  }

  /**
   * Wait for a checkout to show up as an entitlement.
   *
   * Paying and being entitled are not the same instant. Stripe sends the
   * browser back the moment the card clears and tells this project separately,
   * over a webhook, which arrives when it arrives - usually within a second,
   * occasionally several, and on a bad day after a retry. A single read on
   * landing therefore reports Free to somebody who has just paid, which is the
   * worst sentence this app could show them.
   *
   * So it asks again for a while. Bounded, because a webhook that never comes
   * is a real outcome and must not become a page that spins forever: after the
   * last try the caller is told plainly that the payment went through and the
   * account has not caught up, which is true and is something support can act
   * on.
   *
   * WAIT ON THE SOURCE, NOT THE TIER
   *
   * `my_plan()` reports premium for somebody on a trial, because a trial is
   * premium - everything works, which is the point of it. So a wait that ends
   * on `tier === 'premium'` ends on the very first read for anybody who
   * subscribes during their free month, and the app says "Premium is active"
   * to somebody whose payment never reached us. It would be right nearly every
   * time and wrong in exactly the case this function exists for - and that
   * case is now the common one, because subscribing during the trial is the
   * path the panel offers. Pass the source a purchase writes and the wait
   * means what it says.
   */
  async waitForPlan({ tries = 8, wait = 1500, sleep = nap, wanted = 'premium', source = null } = {}) {
    let plan = null;
    const arrived = (seen) => seen?.tier === wanted && (!source || seen.source === source);
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      plan = await this.refreshPlan();
      if (arrived(plan)) return { ok: true, plan, attempts: attempt };
      if (attempt < tries) await sleep(wait);
    }
    return { ok: false, plan, attempts: tries };
  }

  /**
   * Hand a Google Play purchase to the server, which asks Google about it.
   *
   * Only the token travels. Which product it bought, which account it was
   * bought for and when it runs out are all read by play-billing from Google,
   * with credentials this app never holds - a body that said "premium until
   * 2099" would be a body anybody could write.
   *
   * The plan is re-read afterwards rather than taken from the answer, so what
   * the panel shows is what my_plan() says, the same as after a Stripe
   * checkout.
   */
  async confirmPlayPurchase({ purchaseToken = '' } = {}) {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    if (!purchaseToken) return { ok: false, reason: 'There was no purchase to record.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { data, error } = await client.functions.invoke(PLAY_FUNCTION, { body: { purchaseToken } });
    if (error) {
      const said = await readFunctionError(error);
      return { ok: false, reason: said || error.message };
    }
    if (!data?.ok) return { ok: false, reason: data?.error || 'Google Play\'s answer could not be recorded.', pending: Boolean(data?.pending) };
    await this.refreshPlan();
    return { ok: true };
  }

  /**
   * Open Stripe's billing portal, which is where a subscription is cancelled.
   *
   * Cancelling has to be as easy as subscribing and it has to be self-service.
   * Stripe's own pages handle ending it, switching between monthly and yearly,
   * changing a card and downloading invoices, so none of that is built here.
   */
  async openBilling() {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { data, error } = await client.functions.invoke(PORTAL_FUNCTION, { body: {} });
    if (error) {
      const said = await readFunctionError(error);
      return { ok: false, reason: said || error.message };
    }
    if (!data?.ok || !data.url) return { ok: false, reason: data?.error || 'The billing page did not open.' };
    return { ok: true, url: data.url };
  }

  /**
   * Ask the account tool to do something, and report what it said.
   *
   * One method for every action because the shape is identical - a body, a
   * yes or a sentence explaining the no - and because the function is where
   * the decisions live. Refusals arrive as prose meant to be read: "that
   * account subscribes through Stripe", not a status code.
   */
  async administer(action, payload = {}) {
    if (!this.user) return { ok: false, reason: 'Sign in first.' };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    const { data, error } = await client.functions.invoke(ADMIN_FUNCTION, {
      body: { action, ...payload },
    });
    if (error) {
      const said = await readFunctionError(error);
      return { ok: false, reason: said || error.message };
    }
    if (!data?.ok) return { ok: false, reason: data?.error || 'That did not work.' };
    return { ok: true, ...data };
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
   * Throw tickets away, for good.
   *
   * Deleted rather than hidden, because a support queue that only ever grows
   * is a support queue nobody can read, and a ticket marked done and kept
   * forever is a copy of somebody's email sitting in a database for no reason.
   *
   * No policy is added for this: the one on support_tickets is `for all`, so
   * the address that may read the queue is the address that may empty it, and
   * every other session is refused by the same rule that already refuses the
   * read. That is why this takes ids rather than a filter - a delete with a
   * filter and a policy that failed open would empty the table.
   *
   * @param {string[]} ids
   * @returns {{ok: boolean, reason?: string, deleted?: number}}
   */
  async deleteTickets(ids = []) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return { ok: true, deleted: 0 };
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'Accounts are not configured here.' };

    /*
     * Asked back for what it actually removed, rather than assuming.
     *
     * A delete refused by the policy is not an error - it matches no rows and
     * reports success - so without this, an unauthorised session would be told
     * the queue had been emptied while nothing had happened at all.
     */
    const { data, error } = await client.from(TICKETS).delete().in('id', wanted).select('id');
    if (error) return { ok: false, reason: error.message };
    const deleted = (data || []).length;
    if (!deleted) return { ok: false, reason: 'Nothing was deleted. That session may not be allowed to.' };
    return { ok: true, deleted };
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
    const { data, error } = await client.auth.updateUser(attributes, { emailRedirectTo: emailReturn() });
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
    if (!this.user || this.syncing || !this.syncs) return null;
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
      if (!can('folderSync', { tier: tierFor(this) })) {
        const onlyShared = await this.pullShared(client);
        if (onlyShared !== null) {
          const held = this.folders.snapshot().filter((folder) => !folder.sharedFrom);
          this.folders.replaceAll([...held, ...onlyShared]);
        }
        this.lastSyncAt = Date.now();
        this.syncing = false;
        this.setStatus('signed-in', gateReason('folderSync', { tier: tierFor(this) }));
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
      /*
       * Whose folders these are, decided before anything is merged or pushed.
       *
       * `replace` means they are another account's, so this device's beliefs
       * about them are that account's beliefs and must not be projected onto
       * these rows either - hence the empty map rather than `local`.
       */
      const disposition = folderDisposition(this.owner.read(), this.user.id);
      const held = new Map(disposition === 'replace' ? [] : local.map((folder) => [folder.id, folder]));
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

      /*
       * Another account's folders do not travel with the browser.
       *
       * Nothing local goes up and nothing local survives: this account's own
       * rows become what the device shows, which is the position a clean sign
       * out would have left it in. Safe because the stamp is written only
       * after a sync succeeded, so the set being dropped is one the other
       * account already holds.
       *
       * Said out loud, because folders disappearing without a word is the one
       * thing worse than folders appearing without a word.
       */
      if (disposition === 'replace') {
        this.folders.replaceAll([...remote, ...(shared || [])]);
        this.owner.write(this.user.id);
        this.lastSyncAt = Date.now();
        this.syncing = false;
        this.setStatus('signed-in',
          'The folders on this device belonged to another account, so they were not uploaded. '
          + 'This account\u2019s own folders are shown instead.');
        return null;
      }

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

      // Stamped only now, after the push went out. A stamp written before
      // the folders were safely on the server would be the guard promising
      // something it had not done.
      this.owner.write(this.user.id);
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
    if (!folder?.sharedFrom && !can('folderSync', { tier: tierFor(this) })) return;
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
