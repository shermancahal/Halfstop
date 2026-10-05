/**
 * Telling somebody there is a new version, and what is in it.
 *
 * Before this, a new build was announced by one line at the foot of the map's
 * side panel - under every folder, below the fold on a phone - and the other
 * pages took it up silently. So an update was something that happened to
 * people rather than something they were offered, and the release notes on
 * the help page were somewhere only the people who already knew went.
 *
 * Now, on the map, a box at the foot of the screen offers it: Update now,
 * What's new, or later. And on whichever page somebody first opens on a new
 * build - after pressing Update, after the other pages' silent reload, or
 * after the app store updated the app - a note says it was updated and links
 * to what changed. Once per build, not once per page.
 */

import { el } from './ui.js';

/** Where the release notes are: the What's new section of the help page. */
export const WHATS_NEW = 'faq.html#whats-new';

/** The last build this device ran, so the first load on a new one is known. */
export const SEEN_BUILD_KEY = 'halfstop-seen-build';

/** How often coming back to the app may ask the server about a new build. */
export const RECHECK_MS = 10 * 60 * 1000;

const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function localStore() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Whether this load is the first on a build this device had not run, and
 * remember this one either way.
 *
 * The very first visit is not an update - there was nothing before it - so
 * it says nothing and is remembered. No build (a source checkout) says
 * nothing. Neither does storage that will not answer.
 *
 * @param {string} build  window.ABMAP_BUILD
 */
export function arrivedOnNewBuild(build, store = localStore()) {
  if (!build || !store) return false;
  try {
    const seen = store.getItem(SEEN_BUILD_KEY);
    if (seen !== build) store.setItem(SEEN_BUILD_KEY, build);
    return Boolean(seen) && seen !== build;
  } catch {
    return false;
  }
}

/*
 * Where a box goes: in the page's toast stack when there is one, so it lines
 * up with what else the page is saying rather than landing on top of it.
 */
function noticeHost(doc = globalThis.document) {
  return doc?.querySelector?.('.toast-stack') || doc?.body || null;
}

/**
 * The build the server is publishing, or '' when it cannot be asked.
 *
 * build.json is fetched past every cache, so it is the current build even
 * when the page itself came out of one.
 */
export async function publishedBuild({ fetch: get = globalThis.fetch } = {}) {
  try {
    const response = await get('build.json', { cache: 'no-store' });
    if (!response.ok) return '';
    return String((await response.json())?.build || '');
  } catch {
    return '';
  }
}

/**
 * Say "updated" when this page is the first on a new build - and current.
 *
 * Current matters. A page served from a stale cache runs an older build than
 * the one this device saw last, and a note calling that an update would be
 * the opposite of true. So it is only said when the page's build is the one
 * the server is publishing.
 *
 * @returns {Promise<boolean>} whether the note went up
 */
export async function noteIfUpdated({
  build = globalThis.ABMAP_BUILD, latest = publishedBuild, store = localStore(), show = noteUpdated,
} = {}) {
  if (!build) return false;
  if ((await latest()) !== build) return false;
  if (!arrivedOnNewBuild(build, store)) return false;
  show();
  return true;
}

/** Remove a box, if it is up. */
function takeDown(node) {
  node?.remove();
}

/**
 * The box offering a new version.
 *
 * Shown once per page: pressing × means later, and the line at the foot of
 * the panel still offers it. A second notice of the same build - the service
 * worker and build.json can both find it - does not put up a second box.
 *
 * @param {object} options
 * @param {() => Promise<void>|void} options.update  takes up the new build and reloads
 * @returns {HTMLElement|null}  the box, or null when it is already up or was put away
 */
let offered = false;
export function offerUpdate({ update, parent = noticeHost(), whatsNew = WHATS_NEW } = {}) {
  if (offered || !parent) return null;
  offered = true;
  const box = el('div', { class: 'update-box', role: 'status', 'aria-live': 'polite' }, [
    el('p', { class: 'update-box-text' }, [
      el('b', { text: 'A new version of Halfstop is ready.' }),
      el('span', { text: ' Update to get it. It takes a moment, and nothing you have saved is lost.' }),
    ]),
    el('div', { class: 'update-box-actions' }, [
      el('button', {
        class: 'button button-primary button-small', type: 'button', text: 'Update now',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          event.currentTarget.textContent = 'Updating…';
          await update?.();
        },
      }),
      el('a', { class: 'button button-ghost button-small', href: whatsNew, text: 'What’s new' }),
      el('button', {
        class: 'icon-button update-box-close', type: 'button', 'aria-label': 'Not now', title: 'Not now',
        html: CLOSE, onclick: () => takeDown(box),
      }),
    ]),
  ]);
  parent.append(box);
  return box;
}

/**
 * The note that a page is running a version it had not before.
 *
 * Quieter than the offer - the update has already happened, so there is
 * nothing to decide - and it goes by itself.
 */
export function noteUpdated({ parent = noticeHost(), whatsNew = WHATS_NEW, timeout = 20000 } = {}) {
  if (!parent) return null;
  const box = el('div', { class: 'update-box is-done', role: 'status', 'aria-live': 'polite' }, [
    el('p', { class: 'update-box-text' }, [el('b', { text: 'Halfstop has been updated.' })]),
    el('div', { class: 'update-box-actions' }, [
      el('a', { class: 'button button-ghost button-small', href: whatsNew, text: 'See what’s new' }),
      el('button', {
        class: 'icon-button update-box-close', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss',
        html: CLOSE, onclick: () => takeDown(box),
      }),
    ]),
  ]);
  parent.append(box);
  if (timeout) setTimeout(() => takeDown(box), timeout);
  return box;
}

/**
 * Ask about a new build when somebody comes back to the app.
 *
 * An app left open on a phone - the installed site especially - can sit in
 * the background for days, and only looked for an update when it was opened
 * from cold. So coming back to it, or getting a signal back, asks again: the
 * service worker checks for a new sw.js, and `check` reads build.json. No
 * more than every RECHECK_MS, because a person flicking between apps is not a
 * reason to hit the server each time.
 *
 * @returns {() => void} stops watching
 */
export function watchForUpdates({
  registration = null, check = null, every = RECHECK_MS, doc = globalThis.document, win = globalThis,
  now = () => Date.now(),
} = {}) {
  let last = now();
  const look = () => {
    if (doc?.visibilityState === 'hidden') return;
    if (now() - last < every) return;
    last = now();
    try { registration?.update?.()?.catch?.(() => {}); } catch { /* offline, or no worker */ }
    try { check?.(); } catch { /* the check says nothing on failure */ }
  };
  doc?.addEventListener?.('visibilitychange', look);
  win?.addEventListener?.('online', look);
  return () => {
    doc?.removeEventListener?.('visibilitychange', look);
    win?.removeEventListener?.('online', look);
  };
}

/** For tests: forget that the box was offered. */
export function resetUpdateOffer() {
  offered = false;
}
