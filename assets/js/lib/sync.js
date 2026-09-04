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
export function folderToRow(folder, userId, { withParent = true } = {}) {
  if (!withParent) {
    const { parent_id: _dropped, ...rest } = folderToRow(folder, userId);
    return rest;
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
export function mergeFolders(local, remote) {
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
