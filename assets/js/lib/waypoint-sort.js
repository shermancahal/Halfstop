/**
 * The orders the Waypoints tab can list pins in.
 *
 * Alphabetical was the only one, which answers "where is the spring called
 * Bear Wallow" and nothing else. The questions people actually bring to a list
 * of saved places in the field are "what did I just add", "what is near
 * here" and "what is in that folder" - so those are orders too.
 *
 * Pure: the rows, the sort and whatever it needs (the map's centre, the order
 * folders are listed in) come in as arguments, so every order is tested
 * without a browser.
 */
import { haversine } from './geo.js';
import { DEFAULT_PIN_ICON, getPinIcon } from './pin-icons.js';
import { FOLDER_COLORS, readColor } from './folders.js';

/** The choices, in the order the menu offers them. */
export const WAYPOINT_SORTS = [
  { id: 'name', label: 'Name, A to Z' },
  { id: 'name-desc', label: 'Name, Z to A' },
  { id: 'newest', label: 'Recently added' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'nearest', label: 'Nearest the middle of the map' },
  { id: 'folder', label: 'Folder' },
  { id: 'symbol', label: 'Symbol' },
  { id: 'color', label: 'Color' },
];

const SORT_IDS = new Set(WAYPOINT_SORTS.map((sort) => sort.id));

/** A sort this module knows, or the default. */
export function readSort(value) {
  return SORT_IDS.has(value) ? value : 'name';
}

/**
 * When a pin was added, read from its id.
 *
 * Items carry no timestamp of their own, but every id is minted as
 * `i_<milliseconds in base 36>_<counter>` at the moment the pin is filed - and
 * an id travels with the pin through sync, so the answer is the same on every
 * device. An id in another shape sorts as the oldest rather than throwing.
 */
export function addedAt(item) {
  const match = /^i_([0-9a-z]+)_([0-9a-z]+)$/.exec(String(item?.id || ''));
  if (!match) return { time: 0, step: 0 };
  return { time: parseInt(match[1], 36) || 0, step: parseInt(match[2], 36) || 0 };
}

const collate = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
const nameOf = (row) => row.item?.feature?.properties?.name || '';
const symbolOf = (row) => getPinIcon(row.item?.feature?.properties?.icon || DEFAULT_PIN_ICON)?.name || '';
const colorRank = (row) => {
  const color = row.item?.feature?.properties?.color;
  return color ? FOLDER_COLORS.findIndex((hex) => readColor(hex) === readColor(color)) : -1;
};
const positionOf = (row) => {
  const coordinates = row.item?.feature?.geometry?.coordinates;
  return Array.isArray(coordinates) && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])
    ? coordinates : null;
};

/**
 * Rows of `{folder, item}` in the chosen order. A new array; the input is
 * left as it was.
 *
 * @param {string} sort One of WAYPOINT_SORTS' ids.
 * @param {object} [options]
 * @param {[number, number]} [options.centre] [lon, lat], for 'nearest'.
 * @param {string[]} [options.folderOrder] Folder ids in the order the Folders
 *   list draws them, for 'folder'.
 */
export function sortWaypoints(rows = [], sort = 'name', { centre = null, folderOrder = [] } = {}) {
  const byName = (a, b) => collate(nameOf(a), nameOf(b));
  const added = (a, b) => {
    const x = addedAt(a.item);
    const y = addedAt(b.item);
    return (x.time - y.time) || (x.step - y.step);
  };
  const folderRank = new Map(folderOrder.map((id, index) => [id, index]));
  const rankOf = (row) => (folderRank.has(row.folder?.id) ? folderRank.get(row.folder.id) : Number.MAX_SAFE_INTEGER);
  const distance = (row) => {
    const at = positionOf(row);
    return at && centre ? haversine(centre, at) : Number.POSITIVE_INFINITY;
  };

  const compare = {
    name: byName,
    'name-desc': (a, b) => byName(b, a),
    newest: (a, b) => added(b, a) || byName(a, b),
    oldest: (a, b) => added(a, b) || byName(a, b),
    // A pin with no position, or no centre to measure from, goes last.
    nearest: (a, b) => {
      const gap = distance(a) - distance(b);
      return (Number.isNaN(gap) ? 0 : gap) || byName(a, b);
    },
    folder: (a, b) => (rankOf(a) - rankOf(b)) || collate(a.folder?.name, b.folder?.name) || byName(a, b),
    symbol: (a, b) => collate(symbolOf(a), symbolOf(b)) || byName(a, b),
    // Around the wheel rather than by the alphabet, as the table does: red
    // beside orange is what somebody scanning for "the warm ones" expects.
    color: (a, b) => (colorRank(a) - colorRank(b)) || byName(a, b),
  }[readSort(sort)];

  return [...rows].sort(compare);
}
