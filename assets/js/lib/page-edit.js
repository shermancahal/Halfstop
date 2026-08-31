/**
 * In-place editing for any page's prose, not just the help page.
 *
 * All of this lived in faq.js, which was right while one page could be edited
 * and wrong the moment a second could: the pencil, the save bar, the auth
 * wiring and the error handling are generic, and only the page's name and its
 * sections differ. Copying it would have meant two versions of "left in edit
 * mode on purpose, because closing it would throw away work the server has
 * just said it did not keep" - and one of them going stale.
 *
 * The permission story is unchanged and worth restating: the pencil is shown
 * only to a signed-in editor, and that is presentation. The row-level policy
 * on the table decides whether a write is accepted, server-side, where a
 * browser cannot reach it. Hiding a button stops an accident, not an attacker.
 */

import { Account, isConfigured } from './account.js';
import { mayEdit, editableSections, applySaved, bodyOf, loadSaved, saveSection } from './editable.js';

const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>'
  + '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

/** The section's current body, so a first edit has something to edit. */
function bodyHTML(section) {
  const parts = [...section.children].filter((node) => node.tagName !== 'H2');
  return parts.map((node) => node.outerHTML).join('\n');
}

/**
 * A pencil and a save bar on one section.
 *
 * `contenteditable` rather than a textarea of HTML: the person editing this is
 * writing prose, not markup, and asking them to hand-write <p> tags around it
 * is how a page ends up as one long paragraph.
 */
export function arm(section, { save, onError }) {
  if (section.querySelector('.faq-edit')) return;
  const body = bodyOf(section) || applySaved(section, bodyHTML(section));

  const pencil = document.createElement('button');
  pencil.type = 'button';
  pencil.className = 'faq-edit';
  pencil.title = 'Edit this section';
  pencil.setAttribute('aria-label', 'Edit this section');
  pencil.innerHTML = PENCIL;

  const bar = document.createElement('div');
  bar.className = 'faq-editbar';
  bar.hidden = true;
  const status = document.createElement('span');
  status.className = 'faq-status';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'button button-primary button-small';
  done.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button-ghost button-small';
  cancel.textContent = 'Cancel';
  bar.append(done, cancel, status);

  let before = '';
  const stop = () => {
    body.contentEditable = 'false';
    body.classList.remove('is-editing');
    bar.hidden = true;
    pencil.hidden = false;
  };

  pencil.addEventListener('click', () => {
    before = body.innerHTML;
    body.contentEditable = 'true';
    body.classList.add('is-editing');
    body.focus();
    bar.hidden = false;
    pencil.hidden = true;
    status.textContent = '';
  });

  cancel.addEventListener('click', () => { body.innerHTML = before; stop(); });

  done.addEventListener('click', async () => {
    done.disabled = true;
    status.textContent = 'Saving…';
    try {
      await save(section.dataset.editable, body.innerHTML);
      status.textContent = 'Saved.';
      stop();
    } catch (error) {
      // Left in edit mode on purpose: closing it would throw away work the
      // server has just said it did not keep.
      status.textContent = error.message || 'Could not save.';
      onError?.(error);
    } finally {
      done.disabled = false;
    }
  });

  /*
   * The bar goes directly after the body, so a section whose prose sits inside
   * layout does not get its controls stranded at the far end of the section -
   * and a section that IS its own body still puts them somewhere sensible.
   */
  body.insertAdjacentElement?.('afterend', bar) ?? (body.parentElement || section).append(bar);
  section.append(pencil);
}

/**
 * Load any saved copy for this page and offer a pencil to whoever may edit.
 *
 * Returns quietly when accounts are not configured or the library will not
 * load: the page is already readable, and this is the part that is allowed to
 * be missing.
 */
export async function enablePageEditing(page, root = document) {
  if (!isConfigured()) return;

  const account = new Account({ list: () => [], replaceAll() {} });
  let client;
  try {
    client = await account.getClient();
  } catch {
    return;
  }

  await loadSaved(client, page, root);

  const { data } = await client.auth.getSession();
  const armAll = (user) => {
    if (!mayEdit(user)) return;
    for (const section of editableSections(root)) {
      arm(section, {
        save: (slug, html) => saveSection(client, { page, slug, html, user }),
      });
    }
  };
  armAll(data?.session?.user || null);
  client.auth.onAuthStateChange((_event, session) => armAll(session?.user || null));
}
