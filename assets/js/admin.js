/**
 * The support queue, for one address.
 *
 * Three states and only ever one on screen: signed out, signed in as somebody
 * who is not an administrator, or the queue itself.
 *
 * The check in here is presentation. Hiding a page stops an accident, not an
 * attacker: anybody can edit SITE.editors in their devtools, and the rows still
 * will not arrive, because the row-level policy on support_tickets reads the
 * signed-in email as the server sees it. This file decides what to draw; the
 * database decides what exists.
 */

import { SITE } from './config.js';
import { el, initTheme, formatDate, createToaster } from './lib/ui.js';
import { Account, isConfigured } from './lib/account.js';
import { mayEdit } from './lib/editors.js';
import { STATUS_LABELS, nextStatuses, queueOrder, countWaiting } from './lib/support.js';

initTheme(document.getElementById('theme-toggle'));
// The same two lines every other page runs: the name from the config, and the
// parent line removed when there is no parent to name.
for (const node of document.querySelectorAll('#brand-name')) node.textContent = SITE.name;
const parentName = SITE.parent?.name || '';
for (const node of document.querySelectorAll('#brand-parent')) {
  node.textContent = parentName;
  node.hidden = !parentName;
}

const dom = {
  gate: document.getElementById('admin-gate'),
  queue: document.getElementById('admin-queue'),
  lede: document.getElementById('queue-lede'),
};
const toast = createToaster(document.body);

/*
 * The folder store the Account wants, reduced to the three calls it makes.
 *
 * This page has no folders and no map, and hydrating the real store here would
 * pull IndexedDB, the photo vault and the sync loop onto a page that lists
 * email. Account only ever asks it for a snapshot and hands back a merge.
 */
const noFolders = { list: () => [], snapshot: () => [], replaceAll() {}, toGeoJSON: () => ({ features: [] }) };
const account = new Account(noFolders);

function show(node, hidden) { node.hidden = hidden; }

function drawGate(message, { showSignIn = false } = {}) {
  show(dom.queue, true);
  show(dom.gate, false);
  /*
   * Filtered rather than passed straight in: replaceChildren turns a null into
   * the text "null" on the page, where el() would have dropped it. The two do
   * not behave the same and this one is the raw DOM.
   */
  dom.gate.replaceChildren(...[
    el('p', { class: 'hint', text: message }),
    showSignIn
      ? el('p', { class: 'hint', html: 'Sign in on the <a href="map.html">map</a>, then come back.' })
      : null,
  ].filter(Boolean));
}

/** One ticket, as a row you can act on without leaving the page. */
function ticketRow(ticket, refresh) {
  const note = el('input', {
    type: 'text', value: ticket.note || '', placeholder: 'Note to self',
    'aria-label': `Note on ${ticket.subject || 'this message'}`,
  });
  const save = async (patch) => {
    const result = await account.updateTicket(ticket.id, patch);
    if (!result.ok) { toast(result.reason, { tone: 'error' }); return; }
    refresh();
  };

  return el('article', { class: `ticket is-${ticket.status}` }, [
    el('div', { class: 'ticket-head' }, [
      /*
       * Every one of these came out of somebody else's mail client, so it is
       * set as text rather than markup. `el` assigns `text` to textContent,
       * which is the escaping.
       */
      el('span', { class: 'ticket-from', text: ticket.from_name || ticket.from_email || 'Unknown sender' }),
      el('span', { class: 'ticket-when', text: formatDate(ticket.received_at) }),
    ]),
    el('h3', { class: 'ticket-subject', text: ticket.subject || '(no subject)' }),
    ticket.from_email
      ? el('p', { class: 'ticket-address' }, [
        el('a', { href: `mailto:${encodeURIComponent(ticket.from_email)}`, text: ticket.from_email }),
      ])
      : null,
    ticket.body ? el('p', { class: 'ticket-body', text: ticket.body }) : null,
    el('div', { class: 'ticket-actions' }, [
      note,
      el('button', {
        class: 'button button-ghost button-small', type: 'button', text: 'Save note',
        onclick: () => save({ note: note.value }),
      }),
      ...nextStatuses(ticket.status).map((status) => el('button', {
        class: 'button button-secondary button-small', type: 'button',
        text: STATUS_LABELS[status],
        onclick: () => save({ status }),
      })),
    ]),
  ]);
}

async function drawQueue() {
  const result = await account.supportTickets();
  if (!result.ok) {
    // A refused read is the policy doing its job, which is worth saying plainly
    // rather than reporting as an empty queue.
    drawGate(`The queue could not be read: ${result.reason}`);
    return;
  }

  show(dom.gate, true);
  show(dom.queue, false);

  const tickets = queueOrder(result.tickets);
  const waiting = countWaiting(tickets);
  dom.lede.textContent = tickets.length
    ? `${waiting} waiting, ${tickets.length} in all.`
    : 'Nothing has come in yet.';

  if (!tickets.length) {
    dom.queue.replaceChildren(el('p', {
      class: 'hint',
      text: 'Nothing yet. Anything written to support@halfstop.app arrives here once the '
        + 'inbound webhook is pointed at this project.',
    }));
    return;
  }

  dom.queue.replaceChildren(...tickets.map((ticket) => ticketRow(ticket, drawQueue)));
}

function render() {
  if (!isConfigured()) {
    drawGate('Accounts are not configured on this build, so there is no queue to read.');
    return;
  }
  const user = account.user;
  if (!user) { drawGate('This page is for administrators.', { showSignIn: true }); return; }
  if (!mayEdit(user)) { drawGate(`Signed in as ${user.email}, which is not an administrator.`); return; }
  drawQueue();
}

account.addEventListener('change', render);
render();
account.init().catch((error) => console.warn('[admin]', error?.message || error));
