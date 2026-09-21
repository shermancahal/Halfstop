/**
 * The help page: static prose, and the little that has to be filled in.
 *
 * Nothing here runs before the page is readable. The markup in faq.html is the
 * page - the words are in the file, in git, and change by a commit like every
 * other change does.
 */

import { applyStoredTheme, createToaster } from './lib/ui.js';
import { mountPageSettings } from './lib/page-settings.js';
import { mountDeleteAccount } from './lib/delete-account.js';
import { registerServiceWorker, reloadOntoNewBuild } from './lib/pwa.js';
import { mountSiteFooter } from './lib/site-footer.js';
import { SITE } from './config.js';

/*
 * The theme before anything else, so the page does not flash the wrong one
 * while the settings menu is being built.
 */
applyStoredTheme();
const toast = createToaster(document.body);
const { account } = mountPageSettings({ toast });

/*
 * Closing the account, where somebody had to come looking for it.
 *
 * The button itself rather than instructions pointing elsewhere: Apple wants
 * deletion reachable from inside the app, and "go and email us" is not that.
 * What it is no longer is one tap from Sign out in a menu opened to change a
 * theme. The account is shared with the settings panel above, so the button
 * knows whose account it would close and says so.
 */
const closing = document.getElementById('delete-account-mount');
if (closing) mountDeleteAccount({ container: closing, account, toast });

/*
 * An answer somebody was sent to has to be open when they get there.
 *
 * Every answer here is a closed <details>, and a link to one of them - from
 * the account page, from the settings panel, from an email - scrolled to a
 * shut summary. The content is in the DOM either way, which is why nothing
 * caught it: the checks that look for the button inside "Closing your account"
 * find it whether or not anybody can see it.
 */
function openTargetedAnswer() {
  const id = decodeURIComponent(String(location.hash || '').slice(1));
  if (!id) return;
  const found = document.getElementById(id);
  const answer = found?.closest('details');
  if (!answer) return;
  answer.open = true;
  // Opening it changes the height of everything above, so the browser's own
  // scroll landed in the wrong place - it happened before the answer existed.
  answer.scrollIntoView({ block: 'start' });
}
openTargetedAnswer();
window.addEventListener('hashchange', openTargetedAnswer);

/*
 * This page serves itself, terms and privacy, and never registered a worker.
 *
 * It was still controlled by the one home.js or the map registered - scope is
 * the whole origin - so it was served from the cache without ever being the
 * page that checked whether the cache was current. Somebody who lands here
 * first, from a link, got whatever build was cached the last time they opened
 * something else.
 */
registerServiceWorker({ onUpdate: reloadOntoNewBuild });
for (const node of document.querySelectorAll('#brand-name')) node.textContent = SITE.name;
// The parent line goes when there is no parent to name; the markup's fallback
// would otherwise keep showing the old one. The footer is filled from the same
// config by the module that owns it - this page, About, Terms and Privacy all
// run this file, and all four carry the one shared footer.
const parentName = SITE.parent?.name || '';
for (const node of document.querySelectorAll('#brand-parent')) {
  node.textContent = parentName;
  node.hidden = !parentName;
}
mountSiteFooter({ account });

