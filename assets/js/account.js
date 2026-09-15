/**
 * The account page: one address for everything an account is.
 *
 * The gear on every page still signs people in - that is a preference about
 * this device and it belongs where the other preferences are. What lives here
 * is everything after that: the profile, the password, the plan, and the way
 * out of a subscription. See lib/account-page.js for why it is a page at all,
 * which is mostly about emailed links needing a destination somebody chose.
 */

import { applyStoredTheme, createToaster } from './lib/ui.js';
import { Account } from './lib/account.js';
import { NO_FOLDERS, mountPageSettings } from './lib/page-settings.js';
import { mountAccountPage } from './lib/account-page.js';
import { registerServiceWorker, reloadOntoNewBuild } from './lib/pwa.js';
import { SITE } from './config.js';

applyStoredTheme();
const toast = createToaster(document.body);

/*
 * One account for both, built here rather than by either.
 *
 * The header gear and the page below it are two views of the same thing. Two
 * Accounts would mean two clients, two init() calls and two subscriptions to
 * onAuthStateChange - so signing in on one would redraw twice and the other
 * would be a second listener nobody asked for. admin.js has done it this way
 * since the queue shipped, for the same reason.
 */
const account = new Account(NO_FOLDERS, { syncs: false });

/*
 * The gear here is only a gear.
 *
 * Every other page opens it when a reset link lands, because the panel inside
 * it is the only place the new-password form exists. On this page the form is
 * already on the page - opening the menu as well would put a second one in a
 * dropdown over the top of it, which is what it did before this flag.
 */
mountPageSettings({ toast, account, handlesInboxLinks: false });

const where = document.getElementById('account-page');
if (where) mountAccountPage({ container: where, account, toast });

// Ours to start, since neither mount above owns an account it was handed.
account.init().catch((error) => {
  toast(error?.message || 'The account service did not start.', { tone: 'error' });
});

registerServiceWorker({ onUpdate: reloadOntoNewBuild });

for (const node of document.querySelectorAll('#brand-name')) node.textContent = SITE.name;
const parentName = SITE.parent?.name || '';
for (const node of document.querySelectorAll('#brand-parent')) {
  node.textContent = parentName;
  node.hidden = !parentName;
}
