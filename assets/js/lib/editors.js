/**
 * Who counts as an editor, as far as the browser can tell.
 *
 * This used to gate editing page copy in place, which is gone: the site's own
 * words live in the HTML, in git, and change by a commit and a deploy - the
 * same review every other change gets. What is left decides two much smaller
 * things, both of them presentation: which basemaps are offered, and whether a
 * layer's source note names the service behind it.
 *
 * Presentation, and never a permission. SITE.editors is an array in a file
 * served to the browser and anybody can edit it in devtools; nothing here
 * decides what a server accepts. Row-level security does that.
 */

import { SITE } from '../config.js';

export function mayEdit(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return (SITE.editors || []).some((allowed) => String(allowed).trim().toLowerCase() === email);
}
