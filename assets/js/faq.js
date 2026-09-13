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
// The parent line and the "A project of ..." note go when there is no parent
// to name; the markup's fallback would otherwise keep showing the old one.
const parentName = SITE.parent?.name || '';
for (const node of document.querySelectorAll('#brand-parent')) {
  node.textContent = parentName;
  node.hidden = !parentName;
}
for (const node of document.querySelectorAll('#parent-name-footer')) {
  if (parentName) node.textContent = parentName;
  else node.closest('p')?.remove();
}

