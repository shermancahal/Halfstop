/**
 * The help page: static prose, editable in place by whoever is allowed to.
 *
 * Nothing here runs before the page is readable. The markup in faq.html is the
 * page; the shared editor only replaces a section when a saved version exists,
 * and only offers a pencil when the signed-in account is an editor.
 *
 * The editor itself lives in lib/page-edit.js, because the home page needs the
 * same one and two copies of it would drift.
 */

import { initTheme } from './lib/ui.js';
import { SITE } from './config.js';
import { enablePageEditing } from './lib/page-edit.js';

const PAGE = 'faq';

initTheme(document.getElementById('theme-toggle'));
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

enablePageEditing(PAGE).catch((error) => console.warn('[faq]', error?.message || error));
