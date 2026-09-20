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
import { el, applyStoredTheme, formatDate, createToaster } from './lib/ui.js';
import { mountPageSettings } from './lib/page-settings.js';
import { Account, isConfigured } from './lib/account.js';
import { mayEdit } from './lib/editors.js';
import { STATUS_LABELS, nextStatuses, queueOrder, countWaiting } from './lib/support.js';

applyStoredTheme();
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
  accounts: document.getElementById('admin-accounts'),
  accountsLede: document.getElementById('accounts-lede'),
  accountsInvite: document.getElementById('accounts-invite'),
  accountsList: document.getElementById('accounts-list'),
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
// Same stub, same reason: the queue has no folder store, so a sync here
// fetches every row to merge into nothing.
const account = new Account(noFolders, { syncs: false });
// The same account the queue gates on, so signing out here does both.
mountPageSettings({ toast, account });

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

/* ---------------------------------------------------------------- accounts */

/** A date somebody reads, or a dash. Dates here are facts, not decorations. */
const on = (iso) => (iso ? formatDate(new Date(iso)) : '—');

/**
 * What an account has, in the words the rest of the app uses.
 *
 * A trial says so rather than reading Premium: it is the one state with a
 * clock on it, and this is where somebody decides whether to grant anything.
 */
function planLine(row) {
  if (row.plan === 'premium') {
    const until = row.until ? `, ${row.renews ? 'renews' : 'ends'} ${on(row.until)}` : '';
    return `Premium via ${row.source}${until}`;
  }
  if (row.plan === 'trial') return `Trial, ends ${on(row.until)}`;
  return 'Free';
}

function accountRow(row, reload) {
  const say = (result) => {
    toast(result.ok ? 'Done.' : result.reason, { tone: result.ok ? 'ok' : 'error', timeout: 9000 });
    if (result.ok) reload();
  };

  /*
   * Deleting asks for the address to be typed, and the button stays disabled
   * until it matches. The function checks the same thing again - this guard
   * lives in a page, and a page is skippable - but the typing is what stops
   * the mis-click, which is the failure this actually has.
   */
  const typed = el('input', {
    class: 'admin-confirm', type: 'text', placeholder: 'type the address to delete',
    'aria-label': `Type ${row.email} to confirm deleting it`,
  });
  const remove = el('button', {
    class: 'button button-ghost button-small is-danger', type: 'button', text: 'Delete',
    disabled: true,
    onclick: async () => {
      remove.disabled = true;
      say(await account.administer('delete', {
        userId: row.id, email: row.email, confirm: typed.value.trim(),
      }));
    },
  });
  typed.addEventListener('input', () => {
    remove.disabled = typed.value.trim().toLowerCase() !== row.email.toLowerCase();
  });

  const grant = el('button', {
    class: 'button button-secondary button-small', type: 'button',
    text: row.plan === 'premium' ? 'Revoke Premium' : 'Grant Premium',
    // A bought subscription is not this tool's to change, and the row says so
    // before the function has to: revoking one takes access from somebody who
    // is still paying.
    disabled: !row.changeable,
    title: row.changeable ? '' : `${row.source} manages this one`,
    onclick: async () => {
      grant.disabled = true;
      say(await account.administer(row.plan === 'premium' ? 'revoke' : 'grant', { userId: row.id }));
    },
  });

  return el('div', { class: 'admin-account' }, [
    el('div', { class: 'admin-account-who' }, [
      el('b', { text: row.email }),
      el('p', {
        class: 'hint',
        text: `${planLine(row)} · ${row.folders} folder${row.folders === 1 ? '' : 's'} · `
          + `joined ${on(row.created)} · ${row.confirmed ? 'confirmed' : 'never confirmed'}`
          + `${row.provider && row.provider !== 'email' ? ` · ${row.provider}` : ''}`,
      }),
    ]),
    el('div', { class: 'picker-row admin-account-does' }, [grant, typed, remove]),
  ]);
}

async function drawAccounts() {
  const result = await account.administer('list');
  if (!result.ok) {
    dom.accounts.hidden = false;
    dom.accountsList.replaceChildren(el('p', { class: 'hint', text: result.reason }));
    return;
  }

  const rows = [...(result.accounts || [])].sort((a, b) => String(b.created).localeCompare(String(a.created)));
  dom.accounts.hidden = false;
  dom.accountsLede.textContent = `${rows.length} account${rows.length === 1 ? '' : 's'}, newest first.`;

  const field = el('input', {
    class: 'admin-invite', type: 'email', placeholder: 'friend@example.com',
    'aria-label': 'Email address to invite',
  });
  dom.accountsInvite.replaceChildren(field, el('button', {
    class: 'button button-secondary button-small', type: 'button', text: 'Send an invitation',
    onclick: async () => {
      const result2 = await account.administer('invite', { email: field.value.trim() });
      toast(result2.ok ? `Invited ${field.value.trim()}.` : result2.reason,
        { tone: result2.ok ? 'ok' : 'error', timeout: 9000 });
      if (result2.ok) { field.value = ''; drawAccounts(); }
    },
  }));

  dom.accountsList.replaceChildren(...rows.map((row) => accountRow(row, drawAccounts)));
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
  drawAccounts();
}

account.addEventListener('change', render);
render();
account.init().catch((error) => console.warn('[admin]', error?.message || error));
