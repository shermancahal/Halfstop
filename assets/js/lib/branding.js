/**
 * The name, the tagline and the parent organisation, written into any page.
 *
 * This lived in home.js while the landing page was the only one with a footer
 * to fill. The help page has the same footer now, and two copies of "write
 * SITE.tagline into #footer-tagline" is how one page ends up still calling
 * itself something the config stopped saying a release ago.
 *
 * Every id here is optional. A page carries the elements it has, and the ones
 * it does not are skipped rather than reported - which is what lets the same
 * function serve a landing page, a help page, and whatever comes next.
 */

import { SITE } from '../config.js';

export function applyBranding() {
  const set = (id, value) => { const node = document.getElementById(id); if (node && value) node.textContent = value; };
  set('brand-name', SITE.name);
  set('footer-name', SITE.name);
  set('footer-tagline', SITE.tagline);
  set('footer-holder', SITE.copyrightHolder);

  /*
   * Everything that names a parent organisation disappears when there is none.
   *
   * Three places can say it - the line under the brand, the hero's "A project
   * of ...", and a link in the footer - and each carries the old name in the
   * markup as a fallback. Writing only when there is a value would leave all
   * three showing a company that no longer publishes this.
   *
   * The hero line and the footer link are removed rather than emptied: an
   * eyebrow reading "A project of" with nothing after it, and a bullet with no
   * link in it, are worse than their absence.
   */
  const parent = SITE.parent?.name || '';
  const brandParent = document.getElementById('brand-parent');
  if (brandParent) { brandParent.textContent = parent; brandParent.hidden = !parent; }
  const eyebrow = document.getElementById('parent-name');
  if (eyebrow) {
    if (parent) eyebrow.textContent = parent;
    else eyebrow.closest('.eyebrow')?.remove();
  }
  const link = document.getElementById('footer-parent-link');
  if (link) {
    if (parent && SITE.parent?.url) { link.href = SITE.parent.url; link.textContent = parent; }
    else link.closest('li')?.remove();
  }
}
