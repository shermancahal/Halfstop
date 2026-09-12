/**
 * Folders somebody else owns, and the invitations that reach them.
 *
 * Everything here is pure, and that is deliberate: the rules about what a
 * shared folder is allowed to do are the rules that keep one person's edit out
 * of another person's collection, and they should be testable without a
 * network, a database or a browser.
 *
 * The grant is an email address rather than a token in a link. A bearer link
 * is forwardable - one "look at this" into a group chat and a folder of
 * somebody's saved places is public - so the row names an address and the
 * row-level policy matches it against the address on the reader's own session.
 */

/** Addresses are compared lower-cased; an invitation to Sherm@ must match sherm@. */
export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Loose on purpose: the real check is whether the invitation arrives. */
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(value));
}

/**
 * What an invitation allows.
 *
 * Two words rather than a permission set, because there are two things people
 * actually mean: come and look at this, and come and work on this with me.
 */
export const ROLES = ['viewer', 'editor'];

/**
 * The narrower reading of anything unrecognised.
 *
 * An invitation written before roles existed has no role at all, and a row
 * that says something this version has never heard of is not a reason to grant
 * more than was asked for.
 */
export function readRole(value) {
  return String(value || '').trim().toLowerCase() === 'editor' ? 'editor' : 'viewer';
}

/**
 * Stamp a folder as somebody else's.
 *
 * The marker is what every other rule reads, so it goes on once, here, rather
 * than being inferred from a user id in five places that could each get it
 * wrong. A folder without it is the reader's own.
 */
export function markShared(folder, { ownerId = '', ownerName = '', role = 'viewer' } = {}) {
  return { ...folder, sharedFrom: { ownerId, ownerName, role: readRole(role) } };
}

/**
 * Whether this device may change this folder.
 *
 * True for a folder of your own, which is the ordinary case and the reason
 * this reads the way it does: the question is not "is it shared" but "may I
 * write", and for everything you own the answer is yes.
 */
export function canEdit(folder) {
  return folder?.sharedFrom ? folder.sharedFrom.role === 'editor' : true;
}

/** What to call the arrangement, in a sentence about one person. */
export function describeRole(role) {
  return readRole(role) === 'editor' ? 'can edit it' : 'can view it';
}

/** Whether this folder belongs to somebody else. */
export function isShared(folder) {
  return Boolean(folder?.sharedFrom);
}

/**
 * The folders this device may push, and the ones it may only look at.
 *
 * Sync pushes what it believes is local, so a shared folder left in that list
 * would be sent back to the server under the reader's own user id. The
 * row-level policy refuses it - inserts and updates are owner-only - so the
 * failure is a rejected write rather than a stolen folder. That is the
 * database being careful, not this code, and it is still no reason to ask.
 */
export function splitOwned(folders = []) {
  const owned = [];
  const shared = [];
  for (const folder of folders) (isShared(folder) ? shared : owned).push(folder);
  return { owned, shared };
}

/**
 * What the invitation says.
 *
 * Here rather than only in the Edge Function so the app can show the sender
 * exactly what is about to go out over their name, and so the wording is
 * covered by a test rather than by somebody remembering to read a deployed
 * function.
 */
export function invitationLine({ from, folder, what, role = 'viewer' }) {
  const who = String(from || 'Somebody').trim();
  const named = String(folder || 'a folder').trim();
  const asked = readRole(role) === 'editor'
    ? `work on ${named} with them`
    : `view ${named}`;
  return `${who} has invited you to ${asked} on Halfstop, ${what}. `
    + 'It will require you to create a free account on Halfstop.';
}

/**
 * One line about who can see a folder, for the row that says so.
 *
 * Counted rather than listed: a folder shared with eleven people should not
 * push its own name off the screen.
 */
export function describeShares(shares = []) {
  const live = shares.filter((share) => !share.revoked);
  if (!live.length) return 'Not shared with anybody.';
  if (live.length === 1) return `Shared with ${live[0].invited_email}.`;
  return `Shared with ${live.length} people.`;
}
