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
import { applyBranding } from './lib/branding.js';
import { enablePageEditing } from './lib/page-edit.js';

const PAGE = 'faq';

initTheme(document.getElementById('theme-toggle'));
/*
 * The same branding call the homepage makes, because this page now carries the
 * same header and the same three-column footer. It used to do its own smaller
 * version of this - brand name, brand parent, and a #parent-name-footer that
 * no longer exists in the markup - which is exactly the drift the shared
 * function is there to stop.
 */
applyBranding();

enablePageEditing(PAGE).catch((error) => console.warn('[faq]', error?.message || error));
