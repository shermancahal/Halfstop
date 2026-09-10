/**
 * The queue's own rules, which decide what an administrator looks at first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES, STATUS_LABELS, nextStatuses, queueOrder, countWaiting, describeTicket,
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
