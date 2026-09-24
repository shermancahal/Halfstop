/**
 * The native app, as seen from inside the page it wraps.
 *
 * The same files run on app.halfstop.app and inside the Capacitor shell, and
 * almost nothing needs to know which. Sign-in and payment do, and this is the
 * one place that asks.
 *
 * NO IMPORTS FROM NPM
 *
 * This project has no bundler, so `import { App } from '@capacitor/app'` is
 * not available. It is not needed either: the native side of Capacitor injects
 * `window.Capacitor.Plugins.<Name>` for every plugin compiled into the app,
 * with its methods and `addListener` already on it. So a plugin is either on
 * that object or not in this build, and "not in this build" is an answer to
 * give somebody plainly, not a crash - an app installed before a plugin was
 * added is exactly that.
 *
 * WHY LINKS COME BACK AS A NAVIGATION
 *
 * On the website, a link from an email or a round trip through Google lands
 * on a page with the session in the URL fragment, and supabase-js reads it
 * while the client is being built. Everything downstream is written against
 * that: the recovery form, the "that link did not work" message, the check
 * that a link was already used.
 *
 * In the app the same link arrives as an event, to a page that is already
 * running and has already built its client. docs/app-auth.md sketched
 * handling it there - parse the fragment, call setSession, remember that
 * setSession does not announce PASSWORD_RECOVERY and set that by hand - which
 * is a second implementation of everything above, written for a device this
 * repository cannot test on.
 *
 * So the event is turned into what the website would have received: the page
 * navigates to itself, or to the account page, with the fragment the link
 * carried. The app is then on the path the website has always been on, and
 * the parts of that path that are hard to get right are the ones that have
 * already been got right.
 */

/**
 * The address the app answers to.
 *
 * The appId in capacitor.config.json, and a test holds them together: the
 * Android intent filter is written from that file, and a link to any other
 * scheme would open nothing. Reverse-domain because the scheme has to be
 * unique across every app on the device.
 */
export const APP_SCHEME = 'com.halfstop.app';

/**
 * Where Supabase sends an emailed link, or a finished Google sign-in, when
 * the request came from the app.
 *
 * It must be on the project's Redirect URLs allow list as
 * `com.halfstop.app://**`. If it is not, Supabase does not refuse - it
 * quietly sends the link to the Site URL instead, which signs somebody in on
 * the website while the app they are holding stays signed out.
 */
export const APP_RETURN = `${APP_SCHEME}://account`;

/** The page to come back to after Google, held while somebody is away. */
export const RETURN_KEY = 'halfstop-oauth-return-v1';

/** The launch link already acted on, so a page load cannot act on it twice. */
export const LAUNCH_KEY = 'halfstop-launch-link-v1';

/** Where every emailed link lands, on the website and in the app. */
const ACCOUNT_PAGE = 'account.html';

/**
 * Whether this page is running inside the app, which platform, and a way to
 * reach a plugin.
 *
 * Every read is guarded. `Capacitor` is a global anything could define, and a
 * page that threw while deciding whether it was in an app would be broken in
 * every browser as well.
 *
 * @returns {{ native: boolean, platform: string, plugin: (name: string) => object|null }}
 */
export function appShell(g = globalThis) {
  const cap = g?.Capacitor;
  let native = false;
  let platform = 'web';
  try {
    native = Boolean(cap?.isNativePlatform?.());
    if (native) platform = String(cap.getPlatform?.() || 'unknown');
  } catch {
    native = false;
    platform = 'web';
  }
  return {
    native,
    platform,
    plugin: (name) => (native ? cap?.Plugins?.[name] || null : null),
  };
}

/** sessionStorage, or null where it is refused. */
export function sessionStore(g = globalThis) {
  try {
    return g?.sessionStorage || null;
  } catch {
    return null;
  }
}

/**
 * Keep the page somebody is leaving for Google, so the return can put them
 * back on it rather than on the account page.
 *
 * Path and query only. The query is where a shared map keeps its view, and
 * the fragment is where the session is about to arrive, so an old fragment
 * carried back would be a stale one.
 */
export function rememberReturn(store, where = globalThis.location) {
  if (!store || !where) return;
  try {
    store.setItem(RETURN_KEY, `${where.pathname || '/'}${where.search || ''}`);
  } catch {
    /* Without it the return lands on the account page, which is still signed in. */
  }
}

/** The page kept by rememberReturn, once. */
export function takeReturn(store) {
  if (!store) return '';
  try {
    const kept = String(store.getItem(RETURN_KEY) || '');
    store.removeItem(RETURN_KEY);
    // A path on this origin and nothing else. Storage is this origin's own, so
    // this is tidiness rather than a defence, but `//elsewhere` read as a path
    // is another host.
    return /^\/(?!\/)/.test(kept) ? kept : '';
  } catch {
    return '';
  }
}

/**
 * The page a link should open, with whatever it carried moved into the
 * fragment - or null for a link that is not the app's.
 *
 * Supabase puts a session in the fragment and a refusal in either place,
 * depending on which step refused. The page reads only the fragment, so a
 * query is carried across when there is no fragment. Reading both rather than
 * guessing which arrived is the lesson of the website's own link handling.
 *
 * Which page:
 *
 *   - Anything an email sent, and anything that failed, goes to the account
 *     page. An email link carries `type` (signup, recovery, magiclink,
 *     email_change, invite); a recovery has to reach the page with the
 *     new-password form on it; and a failure is only reported loudly there.
 *   - A finished Google or Apple sign-in carries no `type`, and goes back to
 *     the page somebody pressed the button on, if that was kept.
 */
export function landingFor(url, { remembered = '' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:`) return null;

  const carried = parsed.hash.replace(/^#/, '') || parsed.search.replace(/^\?/, '');
  const params = new URLSearchParams(carried);
  const toAccount = params.has('type') || params.has('error') || params.has('error_description');
  const page = (!toAccount && remembered) || ACCOUNT_PAGE;
  return carried ? `${page}#${carried}` : page;
}

/**
 * Go to a landing, reloading when it is the page already open.
 *
 * Assigning a URL that differs only in its fragment does not load anything:
 * it scrolls. supabase-js reads the fragment once, when the client is built,
 * so an arrival on the page that is already open has to be a reload or the
 * session in it is never seen.
 */
export function navigate(landing, where = globalThis.location) {
  const next = new URL(landing, where.href);
  if (next.pathname === where.pathname && next.search === where.search) {
    where.hash = next.hash;
    where.reload();
    return;
  }
  where.assign(next.href);
}

/**
 * Listen for the app being opened by one of its own links.
 *
 * Two ways in, and both are needed:
 *
 *   - `appUrlOpen`, for a link tapped while the app is running. Capacitor
 *     holds the event if no page is listening at that instant - between two
 *     pages, say - and hands it to the next listener, so a page that has just
 *     loaded can still receive it.
 *   - `getLaunchUrl()`, for a link that started the app from cold. That one
 *     never arrives as an event, and it keeps answering with the same URL for
 *     as long as the app runs - so it is acted on once, and the URL kept, or
 *     every page load after it would follow the same link again, forever.
 *
 * @returns {boolean} whether anything is listening
 */
export function watchAppLinks({ shell = appShell(), store = sessionStore(), go = navigate } = {}) {
  const app = shell.plugin('App');
  if (!app?.addListener) return false;

  const follow = (url) => {
    const landing = landingFor(url, { remembered: takeReturn(store) });
    if (!landing) return;
    // The in-app browser, if Google was opened in one. It closes itself on
    // Android when the app comes forward; iOS needs asking.
    Promise.resolve().then(() => shell.plugin('Browser')?.close?.()).catch(() => {});
    go(landing);
  };

  app.addListener('appUrlOpen', (event) => follow(event?.url));

  Promise.resolve()
    .then(() => app.getLaunchUrl?.())
    .then((launch) => {
      const url = String(launch?.url || '');
      // No storage means no memory of having followed it, and following it
      // again would loop. Not following it is the safe failure.
      if (!url || !store) return;
      try {
        if (store.getItem(LAUNCH_KEY) === url) return;
        store.setItem(LAUNCH_KEY, url);
      } catch {
        return;
      }
      follow(url);
    })
    .catch(() => {});

  return true;
}
