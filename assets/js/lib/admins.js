/**
 * Who administers this, as far as the browser can tell.
 *
 * The same shape and the same warning as lib/editors.js, and deliberately not
 * the same list. `editors` decides which basemaps are offered; this decides who
 * is shown the support queue. They held one address between them for a while,
 * which is how the admin page came to gate on `mayEdit` - fine until the day
 * somebody is given a basemap and gets the queue with it.
 *
 * Presentation, never a permission. SITE.admins is an array in a file served
 * to the browser; anybody can put their address in it in devtools and reach
 * admin.html. What they will find there is the page's furniture and no rows,
 * because the row-level policy on support_tickets and ADMIN_EMAILS in the
 * admin-accounts function both read the email off the verified JWT, server
 * side. This file decides what to draw. The server decides what exists.
 */

import { SITE } from '../config.js';

/** The address a user signs in with, normalised for comparison. */
const addressOf = (user) => String(user?.email || '').trim().toLowerCase();

export function mayAdminister(user) {
  const email = addressOf(user);
  if (!email) return false;
  return (SITE.admins || []).some((allowed) => String(allowed).trim().toLowerCase() === email);
}
