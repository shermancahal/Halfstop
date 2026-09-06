/**
 * The help page: static prose, and the little that has to be filled in.
 *
 * Nothing here runs before the page is readable. The markup in faq.html is the
 * page - the words are in the file, in git, and change by a commit like every
 * other change does.
 */

import { initTheme } from './lib/ui.js';
import { SITE } from './config.js';

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

