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
 */

import { SITE } from '../config.js';

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
 * Fill the footer's `data-site` slots from config.
 *
 * A no-op on a page with no footer - map.html is a full-screen map and has
 * none - so every entry module can call it without first asking whether it
 * applies.
 */
export function mountSiteFooter(root = document) {
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
}
