/**
 * Editing a page's own prose, in place, for the people allowed to.
 *
 * The FAQ ships as static HTML. That is deliberate: it has to be readable with
 * no account, no network round trip and no JavaScript at all, which rules out
 * fetching it from a table on load. So the markup in the file is the default,
 * and a saved version - if one exists - replaces it afterwards.
 *
 * Consequences worth being clear about:
 *
 *   - Someone with no connection, or with JavaScript off, reads what is in the
 *     file. That is the right failure: stale prose beats a blank page.
 *   - A saved section shows a moment after load rather than in the first paint.
 *   - The file's copy is never rewritten by a save, so it drifts once a section
 *     is edited. Whoever edits the file has to know that.
 *
 * The pencil is shown only to a signed-in editor, and that is presentation
 * rather than protection: the table's row-level policy is what decides whether
 * a write is accepted, and it checks the user server-side. Hiding a button
 * stops an accident, not an attacker.
 */

import { SITE } from '../config.js';

const TABLE = 'page_sections';

/** Whether this account may edit, as far as the browser can tell. */
export function mayEdit(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return (SITE.editors || []).some((allowed) => String(allowed).trim().toLowerCase() === email);
}

/** The sections on this page that can carry saved copy. */
export function editableSections(root = document) {
  return [...root.querySelectorAll('[data-editable]')];
}

/**
 * Replace a section's body with saved copy, keeping its heading.
 *
 * The h2 stays because it is what the page's own navigation and anchors point
 * at; an edit that could rename it would break a link somebody had shared.
 */
export function applySaved(section, html) {
  /*
   * A section may name the element that holds its prose.
   *
   * The help page is a flat section - a heading and paragraphs - so "keep the
   * h2, replace the rest" describes it exactly. The home page is not: its
   * sections wrap their content in layout, and replacing everything but the
   * heading would throw that away and leave the prose full-bleed.
   *
   * So a page can mark the body it means. Without one the old rule stands, and
   * the help page's saved rows keep applying to the same place.
   */
  const named = bodyOf(section);
  if (named) {
    named.innerHTML = html;
    return named;
  }
  const heading = section.querySelector('h2');
  section.innerHTML = '';
  if (heading) section.append(heading);
  const body = document.createElement('div');
  body.className = 'faq-body';
  body.innerHTML = html;
  section.append(body);
  return body;
}

/**
 * The element holding a section's prose, whichever shape it is.
 *
 * `matches` before `querySelector`, because querySelector searches descendants
 * only. A section whose whole content is its body - a single paragraph marked
 * editable - would otherwise fall through to the "keep the h2, replace the
 * rest" path and be replaced by itself, emptied. Nearly shipped exactly that.
 */
export function bodyOf(section) {
  if (section.matches?.('[data-editable-body]')) return section;
  return section.querySelector('[data-editable-body]') || section.querySelector('.faq-body') || null;
}

/** Load whatever has been saved for this page and swap it in. */
export async function loadSaved(client, page, root = document) {
  const { data, error } = await client.from(TABLE).select('slug, html').eq('page', page);
  if (error || !Array.isArray(data)) return new Map();
  const saved = new Map(data.map((row) => [row.slug, row.html]));
  for (const section of editableSections(root)) {
    const html = saved.get(section.dataset.editable);
    if (typeof html === 'string' && html.trim()) applySaved(section, html);
  }
  return saved;
}

/**
 * Save one section immediately.
 *
 * No draft state: what you save is what the next reader gets. That is what was
 * asked for, and it is the honest shape for a one-person site - a draft that
 * nobody reviews is a published page with an extra step.
 */
export async function saveSection(client, { page, slug, html, user }) {
  const { error } = await client.from(TABLE).upsert([{
    page,
    slug,
    html,
    updated_at: new Date().toISOString(),
    updated_by: user?.email || '',
  }], { onConflict: 'page,slug' });
  if (error) throw new Error(error.message);
  return true;
}
