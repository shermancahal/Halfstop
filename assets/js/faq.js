/**
 * The help page: static prose, editable in place by whoever is allowed to.
 *
 * Nothing here runs before the page is readable. The markup in faq.html is the
 * page; this only replaces a section when a saved version exists, and only
 * offers a pencil when the signed-in account is an editor.
 */

import { initTheme } from './lib/ui.js';
import { SITE } from './config.js';
import { Account, isConfigured } from './lib/account.js';
import { mayEdit, editableSections, applySaved, loadSaved, saveSection } from './lib/editable.js';

const PAGE = 'faq';

initTheme(document.getElementById('theme-toggle'));
for (const node of document.querySelectorAll('#brand-name')) node.textContent = SITE.name;
for (const node of document.querySelectorAll('#brand-parent')) node.textContent = SITE.parent.name;
for (const node of document.querySelectorAll('#parent-name-footer')) node.textContent = SITE.parent.name;

/*
 * A pencil per section, shown only once an editor is signed in.
 *
 * `contenteditable` rather than a textarea of HTML: the person editing this is
 * writing prose, not markup, and asking them to hand-write <p> tags around it
 * is how a help page ends up as one long paragraph.
 */
function arm(section, { save, onError }) {
  if (section.querySelector('.faq-edit')) return;
  const body = section.querySelector('.faq-body') || applySaved(section, bodyHTML(section));

  const pencil = document.createElement('button');
  pencil.type = 'button';
  pencil.className = 'faq-edit';
  pencil.title = 'Edit this section';
  pencil.setAttribute('aria-label', 'Edit this section');
  pencil.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>'
    + '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

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

  section.append(pencil, bar);
}

/** The section's current body, so a first edit has something to edit. */
function bodyHTML(section) {
  const parts = [...section.children].filter((node) => node.tagName !== 'H2');
  return parts.map((node) => node.outerHTML).join('\n');
}

async function main() {
  if (!isConfigured()) return;

  const account = new Account({ list: () => [], replaceAll() {} });
  let client;
  try {
    client = await account.getClient();
  } catch {
    // No accounts library, no editing. The page is already readable.
    return;
  }

  await loadSaved(client, PAGE);

  const { data } = await client.auth.getSession();
  const armAll = (user) => {
    if (!mayEdit(user)) return;
    for (const section of editableSections()) {
      arm(section, {
        save: (slug, html) => saveSection(client, { page: PAGE, slug, html, user }),
      });
    }
  };
  armAll(data?.session?.user || null);
  client.auth.onAuthStateChange((_event, session) => armAll(session?.user || null));
}

main().catch((error) => console.warn('[faq]', error?.message || error));
