/**
 * Folder sync between the browser and Supabase.
 *
 * The merge is a pure function so it can be tested without a network or a
 * database — the part that decides whether your phone or your laptop wins is
 * exactly the part that must not be guesswork.
 *
 * Strategy: last write wins, per folder, on `updatedAt`.
 *
 * Per-folder rather than per-item because a folder is the unit people think in,
 * and because item-level merging needs either a server that understands the
 * data or a CRDT — neither is worth it for a trip-planning app where the same
 * folder is rarely edited on two devices at once. The cost is that simultaneous
 * edits to one folder on two devices keeps the newer folder whole; that is
 * predictable, and stated in the UI, which "merge both and hope" would not be.
 *
 * Deletions are tombstoned rather than inferred. A folder missing locally could
 * mean "deleted here" or "this device has never synced" — treating absence as
 * deletion would let a fresh sign-in wipe everything.
 */

import { canEdit } from './shares.js';
import { readRemovals } from './folders.js';

/** Rows Supabase returns, mapped to the shape FolderStore uses. */
export function rowToFolder(row) {
  return {
    id: row.client_id,
    name: row.name,
    color: row.color,
    // Older rows have no such column; a folder that has never been nested
    // reads as one at the top, which is what it is.
    parentId: row.parent_id || null,
    visible: row.visible !== false,
    collapsed: row.collapsed === true,
    created: row.created_at ? Date.parse(row.created_at) : null,
    updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
    deleted: row.deleted === true,
    // Null on a server that predates the column, which reads as "not a trip" -
    // and a folder that is one keeps its dates locally until the column is
    // there, rather than having them cleared by a database that cannot hold
    // them.
    trip: row.trip || null,
    removedItems: Array.isArray(row.removed_items) ? row.removed_items : [],
    items: Array.isArray(row.items) ? row.items : [],
  };
}

/**
 * Whether a rejection is the server saying it has never heard of a column.
 *
 * A schema that has not been migrated yet rejects the whole row, which meant
 * every push failed for anybody who had not run schema.sql again - not only
 * the nesting, everything. Recognising it lets the push go out again without
 * the column rather than losing the edit.
 */
export function missingColumn(message, column) {
  return new RegExp(`column .*${column}.* does not exist|'${column}' column`, 'i')
    .test(String(message || ''));
}

/** A folder, mapped to the row shape Supabase expects. */
export function folderToRow(folder, userId, { withParent = true, withTrip = true, withRemovals = true } = {}) {
  if (!withParent || !withTrip || !withRemovals) {
    // Dropped from the full row rather than assembled from the parts, so the
    // row a degraded server receives is the ordinary one minus a column, in
    // the order it would otherwise have had.
    const row = folderToRow(folder, userId);
    if (!withParent) delete row.parent_id;
    if (!withTrip) delete row.trip;
    if (!withRemovals) delete row.removed_items;
    return row;
  }
  return {
    user_id: userId,
    client_id: folder.id,
    name: folder.name,
    color: folder.color,
    parent_id: folder.parentId || null,
    visible: folder.visible !== false,
    collapsed: folder.collapsed === true,
    deleted: folder.deleted === true,
    // Photos live in IndexedDB on the device, so only their ids travel. A photo
    // taken on the phone will not appear on the laptop until file sync exists;
    // the alternative is uploading megabytes per pin without being asked.
    items: folder.items || [],
    // {from, to, retired}, or null when this folder is not a trip. Read back
    // through readTrip, so a shape this version does not recognise becomes
    // "not a trip" rather than an error on the next device to open it.
    trip: folder.trip || null,
    // Which items are gone, so the other side can tell a deletion from a pin
    // it has simply never been told about.
    removed_items: folder.removedItems || [],
    updated_at: new Date(folder.updatedAt || Date.now()).toISOString(),
  };
}

/**
 * Decide what each side needs.
 *
 * @param {object[]} local   folders from FolderStore
 * @param {object[]} remote  folders from rowToFolder()
 * @returns {{merged: object[], toPush: object[], pulled: number, pushed: number, conflicts: object[]}}
 */
/**
 * One folder, worked on by two people, reconciled item by item.
 *
 * This is the whole of what co-editing is. Everywhere else the unit is the
 * folder and the newer save wins it entire, which is right for one person on
 * two devices and quietly destructive for two people on one folder: you add a
 * pin, I rename a different one, and whoever saved second takes the folder
 * whole and throws the other's work away without saying so.
 *
 * So items are merged one at a time, by the stamp each carries, and removals
 * are read from the tombstones rather than from absence. An item edited after
 * it was deleted comes back, deliberately: the edit is the later statement of
 * what somebody wanted, and undoing a deletion is recoverable where discarding
 * an edit is not.
 *
 * The folder's own fields - its name, its colour, its trip dates - are still
 * one decision rather than several, and go with the newer save whole. A name
 * and a colour chosen together should not be able to arrive half from each
 * side.
 */
export function mergeCoEdited(mine, theirs, { now = Date.now() } = {}) {
  const removedItems = readRemovals(
    [...(mine.removedItems || []), ...(theirs.removedItems || [])],
    { now },
  );
  const buriedAt = new Map(removedItems.map((gone) => [gone.id, gone.at]));

  // Their order first, so both devices settle on the order the server holds
  // and anything only this one knows about is appended in the order it was
  // made, rather than the two of them shuffling on every sync.
  const byId = new Map();
  for (const item of theirs.items || []) byId.set(item.id, item);
  for (const item of mine.items || []) {
    const held = byId.get(item.id);
    if (!held || (item.updatedAt || 0) > (held.updatedAt || 0)) byId.set(item.id, item);
  }

  const items = [...byId.values()].filter((item) => {
    const at = buriedAt.get(item.id);
    return at === undefined || (item.updatedAt || 0) > at;
  });

  const newer = (theirs.updatedAt || 0) > (mine.updatedAt || 0) ? theirs : mine;
  return {
    ...newer,
    // Always the server's word on who owns this and what they allowed. Taking
    // it from the newer side would let a withdrawn editor invitation keep
    // working for as long as that device kept saving.
    sharedFrom: theirs.sharedFrom || mine.sharedFrom || null,
    items,
    removedItems,
    updatedAt: Math.max(mine.updatedAt || 0, theirs.updatedAt || 0),
  };
}

/**
 * What a folder's items add up to, for asking whether anything moved.
 *
 * Compared rather than trusted to the clock: a merge that took one pin from
 * this device leaves the folder's own timestamp reading exactly as the
 * server's does, and a push decided on timestamps alone would never send it.
 */
function itemSignature(folder) {
  const items = (folder.items || [])
    .map((item) => `${item.id}@${item.updatedAt || 0}`).sort().join(',');
  const gone = (folder.removedItems || [])
    .map((entry) => `${entry.id}@${entry.at || 0}`).sort().join(',');
  return `${items}|${gone}`;
}

/**
 * Decide what each side needs.
 *
 * @param {object[]} local   folders from FolderStore
 * @param {object[]} remote  the reader's own folders, from rowToFolder()
 * @param {object[]|null} shared  folders shared with them, already marked, or
 *   null when that read failed and the ones already in hand should stand
 * @returns {{merged, toPush, toPushShared, pulled, pushed, conflicts}}
 */
export function mergeFolders(local, remote, shared = null, { now = Date.now() } = {}) {
  /*
   * A folder somebody else shared is not this device's to offer up.
   *
   * It arrives through the same store as everything else so the map and the
   * folder list can draw it without special cases, which means it also reaches
   * this function looking exactly like a local folder the server has not heard
   * of - and mergeOwnFolders would offer it back under the reader's own user
   * id. The row policy refuses that write, so the failure is a rejected upsert
   * rather than a stolen folder, but a sync that reports "failed" every time
   * somebody looks at a shared trip is its own bug.
   *
   * So they are taken out of the ownership merge entirely and settled
   * separately below, against the server's current view of what is shared.
   */
  const localShared = local.filter((folder) => folder?.sharedFrom);
  const mine = local.filter((folder) => !folder?.sharedFrom);
  const result = mergeOwnFolders(mine, remote);

  // The read of what is shared failed. Keep what is already in hand rather
  // than concluding from silence that every invitation was withdrawn.
  if (shared === null) {
    return { ...result, merged: [...result.merged, ...localShared], toPushShared: [] };
  }

  const held = new Map(localShared.map((folder) => [folder.id, folder]));
  const toPushShared = [];

  const settled = shared.map((theirs) => {
    const ours = held.get(theirs.id);
    // Nothing of ours to reconcile, or nothing we are allowed to have changed.
    if (!ours || !canEdit(theirs)) return theirs;

    const merged = mergeCoEdited(ours, theirs, { now });
    const renamedHere = (ours.updatedAt || 0) > (theirs.updatedAt || 0);
    if (renamedHere || itemSignature(merged) !== itemSignature(theirs)) toPushShared.push(merged);
    return merged;
  });

  return {
    ...result,
    merged: [...result.merged, ...settled],
    toPushShared,
    pushed: result.pushed + toPushShared.length,
  };
}

function mergeOwnFolders(local, remote) {
  const byId = new Map();
  const conflicts = [];

  for (const folder of local) {
    byId.set(folder.id, { local: folder, remote: null });
  }
  for (const folder of remote) {
    const entry = byId.get(folder.id);
    if (entry) entry.remote = folder;
    else byId.set(folder.id, { local: null, remote: folder });
  }

  const merged = [];
  const toPush = [];
  let pulled = 0;

  for (const { local: mine, remote: theirs } of byId.values()) {
    // Only on this device — push it up.
    if (mine && !theirs) {
      if (!mine.deleted) merged.push(mine);
      toPush.push(mine);
      continue;
    }

    // Only on the server — take it, unless it is a tombstone.
    if (!mine && theirs) {
      if (!theirs.deleted) { merged.push(theirs); pulled++; }
      continue;
    }

    const mineAt = mine.updatedAt || 0;
    const theirsAt = theirs.updatedAt || 0;

    if (theirsAt > mineAt) {
      if (!theirs.deleted) merged.push(theirs);
      pulled++;
      // Both sides changed since the last sync, and the server was later.
      if (mineAt > 0) conflicts.push({ id: mine.id, name: mine.name, kept: 'server' });
    } else if (mineAt > theirsAt) {
      if (!mine.deleted) merged.push(mine);
      toPush.push(mine);
      if (theirsAt > 0) conflicts.push({ id: mine.id, name: mine.name, kept: 'this device' });
    } else if ((mine.parentId || null) !== (theirs.parentId || null)
      && (!mine.parentId || !theirs.parentId)) {
      /*
       * Identical timestamps that disagree about where a folder is filed.
       *
       * That cannot happen from two people editing: the same instant means
       * the same state. It happens when the server could not hold the answer.
       * A database that predates parent_id took the push, dropped the column,
       * and handed back a row that is byte-for-byte the one that went up
       * except for the nesting - so both sides then sat on the same timestamp
       * for ever, each quietly sure it was up to date, and running the
       * migration afterwards changed nothing because nothing had a reason to
       * be sent again.
       *
       * So whichever side still knows where the folder goes is the one that
       * is right, in either direction: the laptop that did the filing pushes
       * it, and the phone that was handed the flattened copy takes it back.
       * Only when one side is null - two different parents at one instant is
       * not this, and falls through to keeping local.
       */
      if (mine.parentId) {
        if (!mine.deleted) merged.push(mine);
        toPush.push(mine);
      } else {
        if (!theirs.deleted) merged.push(theirs);
        pulled++;
      }
    } else {
      // Identical timestamps: same state, or a clock that did not move. Either
      // way there is nothing to choose between them, so keep local and be quiet.
      if (!mine.deleted) merged.push(mine);
    }
  }

  merged.sort((a, b) => (a.created || 0) - (b.created || 0));
  return { merged, toPush, pulled, pushed: toPush.length, conflicts };
}

/** Human summary of a sync, for the status line. */
export function describeSync({ pulled, pushed, conflicts }) {
  const parts = [];
  if (pulled) parts.push(`${pulled} in`);
  if (pushed) parts.push(`${pushed} out`);
  if (!parts.length) return 'Up to date';
  let text = `Synced ${parts.join(', ')}`;
  if (conflicts?.length) {
    const kept = conflicts[0].kept;
    text += conflicts.length === 1
      ? ` — “${conflicts[0].name}” changed in both places, kept the ${kept} copy`
      : ` — ${conflicts.length} folders changed in both places, kept the newer copy of each`;
  }
  return text;
}
