/**
 * The queue's own rules, which decide what an administrator looks at first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES, STATUS_LABELS, nextStatuses, queueOrder, countWaiting, describeTicket,
  doneTickets, openByDefault,
} from '../assets/js/lib/support.js';

test('support: unfinished before finished, newest first inside that', () => {
  /*
   * Sorted by date alone, a week-old message somebody is still waiting on sits
   * below this morning's resolved ones - which is the queue telling you to
   * ignore the only thing on it that needs you.
   */
  const tickets = [
    { id: 'done-today', status: 'done', received_at: '2026-09-10T09:00:00Z' },
    { id: 'old-open', status: 'open', received_at: '2026-09-03T09:00:00Z' },
    { id: 'new-today', status: 'new', received_at: '2026-09-10T08:00:00Z' },
  ];
  assert.deepEqual(queueOrder(tickets).map((t) => t.id), ['new-today', 'old-open', 'done-today']);
  assert.equal(countWaiting(tickets), 2);
});

test('support: the buttons offered are never the state it is already in', () => {
  for (const status of STATUSES) {
    const offered = nextStatuses(status);
    assert.equal(offered.includes(status), false, `${status} offered itself`);
    assert.equal(offered.length, STATUSES.length - 1);
    for (const next of offered) assert.ok(STATUS_LABELS[next], `${next} has no label`);
  }
});

test('support: a sender with no name is still somebody', () => {
  assert.equal(describeTicket({ from_name: 'Sherman', subject: 'Pins' }), 'Sherman: Pins');
  assert.equal(describeTicket({ from_email: 'a@b.com', subject: '' }), 'a@b.com: (no subject)');
  assert.equal(describeTicket({}), 'Unknown sender: (no subject)');
});

/* ------------------------------------------- what the queue folds and clears */

const QUEUE = [
  { id: 'a', status: 'new', received_at: '2026-09-10T09:00:00Z' },
  { id: 'b', status: 'open', received_at: '2026-09-03T09:00:00Z' },
  { id: 'c', status: 'done', received_at: '2026-09-02T09:00:00Z' },
  { id: 'd', status: 'done', received_at: '2026-09-01T09:00:00Z' },
];

test('support: clearing out takes the finished ones and nothing else', () => {
  /*
   * The whole reason the bulk delete is scoped rather than "empty the queue".
   * Done is a state somebody put each of those tickets into by hand; new and
   * in-hand are messages nobody has answered, and a button that threw those
   * away would be the one thing this page exists to prevent.
   */
  assert.deepEqual(doneTickets(QUEUE).map((t) => t.id), ['c', 'd']);
  assert.deepEqual(doneTickets([]), []);
  // Not "everything except new", and not anything that merely has a note on it.
  assert.deepEqual(doneTickets([{ status: 'open', note: 'answered' }]), []);
  assert.deepEqual(doneTickets([{ status: 'Done' }]), [], 'and the state is the exact word');
});

test('support: the finished ones arrive folded and the rest do not', () => {
  /*
   * Which way round the fold goes, decided rather than left to whichever
   * looked tidier. A done ticket is one nobody is going to read again, so
   * folding it costs nothing; folding the ones still waiting would hide the
   * work behind a click each, which is the scrolling it was meant to save.
   */
  assert.equal(openByDefault({ status: 'new' }), true);
  assert.equal(openByDefault({ status: 'open' }), true);
  assert.equal(openByDefault({ status: 'done' }), false);
  // A status nobody taught this about is work until somebody says otherwise.
  assert.equal(openByDefault({ status: 'escalated' }), true);
  assert.equal(openByDefault({}), true);
});
