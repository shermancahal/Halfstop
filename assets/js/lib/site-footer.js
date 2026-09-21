/**
 * The one footer, filled in.
 *
 * WHY THIS EXISTS
 *
 * There were five different footers. The homepage had a brand block and seven
 * links; the help page had five links; About, Terms and Privacy had three; the
 * account page had a different three; the admin page had two. Nothing was
 * wrong with any of them individually, which is exactly how they drifted -
 * each page was written on its own day and nothing compares one against
 * another.
 *
 * So the markup is now identical on every page that has a footer, byte for
 * byte, and test/pages.test.mjs asserts that. What the markup cannot do is
 * know the operator's name, tagline and legal entity, since those live in
 * config.js so a fork can change them in one file. That is this module's job,
 * and it is a module rather than a copied-out loop because the old copied-out
 * loop ran only on the homepage - every other page showed whatever the markup
 * happened to say.
 *
 * The markup carries the real values as its fallback rather than empty
 * elements. A page whose JavaScript has not run yet, or has failed, then shows
 * the right footer rather than a blank one with stray punctuation in it.
 *
 * THE ONE LINK THAT IS NOT IN THE MARKUP
 *
 * admin.html is the only page nothing links to, which made it a URL its own
 * administrator had to remember. It has a link now, and that link is built
 * here rather than shipped hidden in the HTML: the footer is meant to be the
 * same bytes on every page, and an admin entry that is present-but-hidden
 * would either break that or have to be excused from it.
 *
 * It appears when the signed-in address is one config names, and goes again
 * on sign-out. That is presentation and nothing more - see lib/admins.js.
 */

import { SITE } from '../config.js';
import { mayAdminister } from './admins.js';

/**
 * The year on the copyright line.
 *
 * Only ever moved forward. The markup says the year the notice was written,
 * and a clock that is wrong - a device set to 2019, a fork opened in a
 * container with no NTP - must not be able to age the notice backwards.
 */
function copyrightYear(printed) {
  const now = new Date().getFullYear();
  return Number.isFinite(now) && now > printed ? now : printed;
}

/**
 * Fill the footer's `data-site` slots from config, and watch for an admin.
 *
 * A no-op on a page with no footer - map.html is a full-screen map and has
 * none - so every entry module can call it without first asking whether it
 * applies. `account` is optional; pass it and the admin link follows whoever
 * is signed in.
 */
export function mountSiteFooter({ account = null, root = document } = {}) {
  const values = {
    name: SITE.name,
    tagline: SITE.tagline,
    holder: SITE.copyrightHolder,
  };

  for (const [slot, value] of Object.entries(values)) {
    if (!value) continue;
    for (const node of root.querySelectorAll(`[data-site="${slot}"]`)) {
      node.textContent = value;
    }
  }

  for (const node of root.querySelectorAll('[data-site="year"]')) {
    const printed = Number.parseInt(node.textContent, 10);
    if (Number.isFinite(printed)) node.textContent = String(copyrightYear(printed));
  }

  /*
   * Without an account there is nobody to be an administrator, which is the
   * right answer for a page that has not built one rather than a reason to
   * fail.
   */
  if (account) watchAdminLink(root, account);
}

/* ------------------------------------------------------- the way in to admin */

/**
 * The page the admin link points at.
 *
 * Exported so test/pages.test.mjs can check it against the list of pages the
 * build actually ships. A link built in JavaScript is invisible to the check
 * that reads the markup, and a footer link to a 404 is the failure that whole
 * check exists for.
 */
export const ADMIN_PAGE = 'admin.html';

/**
 * Show the admin link while an administrator is signed in.
 *
 * Added and removed rather than hidden and shown, so a reader who is not
 * signed in has no admin link in their DOM to find. That is tidiness rather
 * than security - the URL is in the build either way - but there is no reason
 * to put it in front of somebody it will not work for.
 */
function watchAdminLink(root, account) {
  // The first column is where the pages of the site are listed; the second is
  // help and legal. Admin is a page, and a fourth entry there also squares the
  // two columns off at four apiece.
  const list = root.querySelector('.footer-menu > ul');
  if (!list) return;

  let item = null;
  const paint = () => {
    const allowed = mayAdminister(account?.user);
    if (allowed === Boolean(item)) return;

    if (!allowed) {
      item.remove();
      item = null;
      return;
    }
    const link = document.createElement('a');
    link.href = ADMIN_PAGE;
    link.textContent = 'Admin';
    item = document.createElement('li');
    item.className = 'footer-admin';
    item.append(link);
    list.append(item);
  };

  paint();
  account.addEventListener('change', paint);
}
