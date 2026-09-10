/**
 * The support queue: what a ticket is, and what may be done to it.
 *
 * Pure, so the rules can be tested without a database. The gate itself is not
 * here and cannot be: an array in a file served to the browser decides what to
 * draw, and the row-level policy on the table decides what is allowed. This
 * module is only the first of those.
 */

/** Where a ticket can be in its life. Order matters: it is the display order. */
export const STATUSES = ['new', 'open', 'done'];

/** What each one means to whoever is looking at the queue. */
export const STATUS_LABELS = {
  new: 'New',
  open: 'In hand',
  done: 'Done',
};

/** The next thing to press, which is never the state it is already in. */
export function nextStatuses(status) {
  return STATUSES.filter((value) => value !== status);
}

/**
 * Newest first, but unfinished before finished.
 *
 * A queue sorted only by date buries a week-old message somebody is still
 * waiting on under this morning's resolved ones. Done sinks; everything else
 * keeps its place in time.
 */
export function queueOrder(tickets = []) {
  const rank = (ticket) => (ticket.status === 'done' ? 1 : 0);
  return [...tickets].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return String(b.received_at || '').localeCompare(String(a.received_at || ''));
  });
}

/** How many are waiting, which is the only number worth putting in a heading. */
export function countWaiting(tickets = []) {
  return tickets.filter((ticket) => ticket.status !== 'done').length;
}

/**
 * A one-line summary of who wrote and what about.
 *
 * Both halves are somebody else's text, arriving from an inbox. Whoever draws
 * this must escape it; this only decides what it says.
 */
export function describeTicket(ticket = {}) {
  const who = String(ticket.from_name || '').trim() || String(ticket.from_email || 'Unknown sender').trim();
  const subject = String(ticket.subject || '').trim() || '(no subject)';
  return `${who}: ${subject}`;
}
