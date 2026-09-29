/**
 * The banner on the homepage that invites people to test the Android app.
 *
 * Built here rather than written into index.html, for three reasons. The
 * pages ship inside the app as well, and a banner asking somebody to install
 * the app they are already using is the kind of thing that makes an app look
 * unattended - so it is only ever drawn in a browser. On an iPhone a Google
 * Play link goes nowhere, so it is not drawn there either. And once somebody
 * has closed it, it stays closed on that browser, which is remembered in
 * localStorage: a convenience for one reader, and nothing breaks if the
 * browser forgets.
 *
 * The link and whether the app is still in testing come from SITE.androidApp
 * in config.js.
 */

import { el } from './ui.js';

export const DISMISS_KEY = 'halfstop-android-invite-closed-v1';

/** A phone, drawn in the same stroke as the rest of the page's icons. */
const PHONE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/**
 * Whether to draw the banner at all.
 *
 * @param {object} options
 * @param {object} options.app        SITE.androidApp
 * @param {boolean} options.native    running inside the app
 * @param {string} options.userAgent
 * @param {boolean} options.dismissed closed before on this browser
 */
export function inviteWanted({ app, native = false, userAgent = '', dismissed = false } = {}) {
  if (!app?.url || !app.testing) return false;
  if (native || dismissed) return false;
  // iPhones and iPads, including an iPad that says it is a Mac: a Play
  // Store link is a dead end on any of them.
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return false;
  return true;
}

function readDismissed(store) {
  try {
    return store?.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(store) {
  try {
    store?.setItem(DISMISS_KEY, '1');
  } catch {
    /* It comes back on the next visit, which is all that is lost. */
  }
}

/** The banner itself; `onClose` runs when it is closed. */
export function inviteBanner(app, { onClose = () => {} } = {}) {
  const banner = el('aside', { class: 'app-invite', 'aria-label': 'The Android app' });
  banner.append(el('div', { class: 'wrap app-invite-row' }, [
    el('span', { class: 'app-invite-mark', html: PHONE_ICON }),
    el('p', { class: 'app-invite-text' }, [
      el('b', { text: 'Halfstop for Android is open for testing.' }),
      ' ',
      el('span', { text: 'Install it from Google Play, and tell us what breaks.' }),
    ]),
    el('a', {
      class: 'button button-small button-primary app-invite-go',
      href: app.url,
      target: '_blank',
      rel: 'noopener',
      text: 'Join on Google Play',
    }),
    el('button', {
      class: 'app-invite-close',
      type: 'button',
      title: 'Hide this',
      'aria-label': 'Hide the Android app banner',
      html: CLOSE_ICON,
      onclick: () => {
        banner.remove();
        onClose();
      },
    }),
  ]));
  return banner;
}

/**
 * Draw the banner under the site header, if it is wanted.
 *
 * @returns {HTMLElement|null} the banner, or null when none was drawn
 */
export function mountAppInvite({
  app, native = false, doc = globalThis.document, store = null, userAgent = globalThis.navigator?.userAgent || '',
} = {}) {
  const header = doc?.querySelector('.site-header');
  if (!header) return null;
  if (!inviteWanted({ app, native, userAgent, dismissed: readDismissed(store) })) return null;
  const banner = inviteBanner(app, { onClose: () => rememberDismissed(store) });
  header.after(banner);
  return banner;
}
