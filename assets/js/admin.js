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
import {
  STATUS_LABELS, nextStatuses, queueOrder, countWaiting, doneTickets, openByDefault, describeTicket,
} from './lib/support.js';

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

/**
 * Run a click handler, and say so when it throws.
 *
 * An async `onclick` that rejects produces nothing at all: no toast, no
 * change, no sign the button did anything. That is not a small thing here -
 * it is how "the delete button is broken" and "the delete button did nothing
 * because the page is running half of an old build" look identical, and the
 * error it was swallowing named the problem outright.
 *
 * The message is the raw one on purpose. This page has one reader, who can act
 * on "account.deleteTickets is not a function" and cannot act on "something
 * went wrong".
 */
const safely = (fn) => async (event) => {
  try {
    await fn(event);
  } catch (error) {
    console.error('[admin]', error);
    toast(`That did not work: ${error?.message || error}`, { tone: 'error', timeout: 12000 });
  }
};

/*
 * What this page needs the account module to be able to do.
 *
 * These two files are cached under different rules and can therefore be out of
 * step. admin.html loads this page as admin.js?v=<hash of its contents>, so a
 * change to it is picked up the moment it deploys; this page then imports
 * './lib/account.js', a URL that never changes, which the browser may answer
 * from its own cache for as long as the host's max-age says. So a fresh page
 * can be driving a stale module, and the first sign of it is a method that is
 * simply not there.
 *
 * Checked by name rather than by a version number, because the names are the
 * thing that actually has to be present, and a version constant is one more
 * thing to forget to raise.
 */
const NEEDED = ['supportTickets', 'updateTicket', 'deleteTickets', 'administer'];
const missingFromAccount = () => NEEDED.filter((name) => typeof account[name] !== 'function');

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

  /*
   * A <details>, so the queue is a list you can see the shape of.
   *
   * Every ticket used to render in full: the sender, the subject, the address,
   * the whole body and a row of buttons. Ten of those is ten screens of
   * scrolling to find out which two need answering, and the finished ones -
   * which is eventually most of them - take exactly as much room as the ones
   * that do not.
   *
   * Native rather than a class and a click handler. <details> gets keyboard
   * behaviour, find-in-page that opens the section it matched, and the right
   * announcement to a screen reader, none of which is worth reimplementing.
   */
  return el('details', { class: `ticket is-${ticket.status}`, open: openByDefault(ticket) }, [
    /*
     * Who, what about, and when - the three things that decide whether this is
     * the one you are looking for. All on the summary line, because a fold
     * that shows only a name and a date is a fold you have to open one by one
     * to triage, which is the scrolling it was meant to save.
     *
     * The subject is a heading inside the summary, which is valid: <summary>
     * takes phrasing content intermixed with heading content. It is here
     * rather than repeated in the body so there is one copy of the text.
     */
    el('summary', { class: 'ticket-head' }, [
      /*
       * Every one of these came out of somebody else's mail client, so it is
       * set as text rather than markup. `el` assigns `text` to textContent,
       * which is the escaping.
       */
      el('span', { class: 'ticket-from', text: ticket.from_name || ticket.from_email || 'Unknown sender' }),
      el('h3', { class: 'ticket-subject', text: ticket.subject || '(no subject)' }),
      el('span', { class: 'ticket-when', text: formatDate(ticket.received_at) }),
    ]),
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
      /*
       * Confirmed before it happens, because there is nothing behind this.
       *
       * The row is gone from the database, the original is in whatever inbox
       * forwarded it, and this page has no undo. window.confirm is what the
       * rest of the app uses for a delete that cannot be taken back, and the
       * message names the sender so a mis-click on the wrong row is visible in
       * the dialog rather than afterwards.
       */
      el('button', {
        class: 'button button-ghost button-small is-danger', type: 'button', text: 'Delete',
        onclick: safely(async () => {
          if (!window.confirm(`Delete “${describeTicket(ticket)}”? This cannot be undone.`)) return;
          const result = await account.deleteTickets([ticket.id]);
          if (!result.ok) { toast(result.reason, { tone: 'error', timeout: 9000 }); return; }
          refresh();
        }),
      }),
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

  const rows = tickets.map((ticket) => ticketRow(ticket, drawQueue));

  /*
   * Open or shut the lot.
   *
   * The per-ticket default - finished ones folded, the rest not - is right for
   * arriving at the page and wrong the moment somebody wants the other thing:
   * reading back through a week of answered mail, or getting a queue of
   * fifteen down to something they can see at once. Written against the nodes
   * that are already on the page rather than by redrawing, so opening one by
   * hand and then pressing Collapse all does what it looks like it does.
   */
  const fold = el('button', {
    class: 'button button-ghost button-small', type: 'button', text: 'Collapse all',
    onclick: () => {
      const shutting = fold.textContent === 'Collapse all';
      for (const row of dom.queue.querySelectorAll('details.ticket')) row.open = !shutting;
      fold.textContent = shutting ? 'Expand all' : 'Collapse all';
    },
  });

  /*
   * Clearing out, and only the finished ones.
   *
   * A button that emptied the whole queue would be a button that throws away
   * the messages nobody has answered yet, which is the one thing this page
   * exists to stop happening. So the bulk delete is scoped to done, which is a
   * state somebody put each of those tickets into by hand.
   */
  const done = doneTickets(tickets);
  const clear = done.length
    ? el('button', {
      class: 'button button-ghost button-small is-danger', type: 'button',
      text: `Delete the ${done.length} finished`,
      onclick: safely(async () => {
        const ask = `Delete ${done.length} finished message${done.length === 1 ? '' : 's'}? `
          + 'This cannot be undone.';
        if (!window.confirm(ask)) return;
        clear.disabled = true;
        const result = await account.deleteTickets(done.map((ticket) => ticket.id));
        if (!result.ok) {
          clear.disabled = false;
          toast(result.reason, { tone: 'error', timeout: 9000 });
          return;
        }
        // The number it actually removed, not the number that was asked for.
        toast(`${result.deleted} deleted.`, { tone: 'ok' });
        drawQueue();
      }),
    })
    : null;

  dom.queue.replaceChildren(
    el('div', { class: 'picker-row queue-tools' }, [fold, clear].filter(Boolean)),
    ...rows,
  );
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
  // Free, and whether the free month is still there to be taken. The two are
  // the same plan and different situations: one is somebody who has not
  // decided yet, the other is somebody who tried it and did not subscribe.
  return row.trialUsed ? 'Free, trial spent' : 'Free';
}

/** The three plans, in the order they escalate. */
const PLANS = [
  { id: 'free', label: 'Free' },
  { id: 'trial', label: 'Trial' },
  { id: 'premium', label: 'Premium' },
];

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
    onclick: safely(async () => {
      remove.disabled = true;
      say(await account.administer('delete', {
        userId: row.id, email: row.email, confirm: typed.value.trim(),
      }));
    }),
  });
  typed.addEventListener('input', () => {
    remove.disabled = typed.value.trim().toLowerCase() !== row.email.toLowerCase();
  });

  /*
   * Three buttons that name the three plans, rather than one that toggles.
   *
   * This was a single Grant Premium / Revoke Premium button, which could only
   * ever express two of the three states - a trial was worked out from the
   * signup date back then, so there was nothing to set and no way to reach it.
   * A toggle also answers the wrong question: "is this on" has no answer when
   * there are three, and pressing Trial against an account already on Trial
   * should give it a trial rather than whatever the opposite of one is.
   *
   * The one it is already on is marked and does nothing, so the row says what
   * an account has without having to be read twice.
   */
  const plans = el('div', { class: 'picker-row admin-plans', role: 'group', 'aria-label': `Plan for ${row.email}` },
    PLANS.map(({ id, label }) => {
      const here = row.plan === id;
      const button = el('button', {
        class: `button button-small ${here ? 'button-primary is-on' : 'button-ghost'}`,
        type: 'button',
        text: label,
        // A bought subscription is not this tool's to change, and the row says
        // so before the function has to: revoking one takes access from
        // somebody who is still paying. The plan they are on is disabled too -
        // there is nothing for it to do.
        disabled: here || !row.changeable,
        'aria-pressed': String(here),
        title: row.changeable ? '' : `${row.source} manages this one`,
        onclick: safely(async () => {
          button.disabled = true;
          say(await account.administer('setPlan', { userId: row.id, plan: id }));
        }),
      });
      return button;
    }));

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
    plans,
    el('div', { class: 'picker-row admin-account-does' }, [typed, remove]),
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
  /*
   * Said once, here, rather than discovered one dead button at a time.
   *
   * This is the page running newer code than the module it drives - see
   * NEEDED above for why that can happen at all. Without this the symptom is a
   * button that does nothing whatever, which is indistinguishable from a
   * feature that was never built, and it took a database, a policy and a
   * request trace to rule those out the first time.
   */
  const missing = missingFromAccount();
  if (missing.length) {
    drawGate(`This page is running newer code than the rest of the build: `
      + `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from the account module. `
      + `Reload the page (hold Shift while you do it) and it will sort itself out.`);
    return;
  }
  drawQueue();
  drawAccounts();
}

account.addEventListener('change', render);
render();
account.init().catch((error) => console.warn('[admin]', error?.message || error));
