/**
 * The Fieldstop pin set: symbols for the places a back-roads atlas is about.
 *
 * Icons are stored as SVG path data on a 24x24 grid and rasterised at runtime
 * into map images, drawn in ink on a white disc whose ring carries the pin's
 * colour - so N icons and M colours cost N images rather than N x M, and the
 * symbol keeps the contrast while the colour keeps the edge.
 *
 * A pin's colour is the pin's own - set in the editor, or carried in from the
 * file it was imported from, where people use it to mean things ("been there"
 * is one). A symbol never chooses it, and the default is ink.
 *
 * Adding an icon: append an entry with a unique id and 24x24 path data. It
 * appears in the pin editor automatically. Ids are stored in saved folders, so
 * renaming one orphans existing pins - add a new id instead.
 */

/** The ring's colour when a pin has none of its own: ink, like the glyph. */
export const PIN_INK = '#2A2118';

import { NPS_ICONS } from './nps-icons.js';

/**
 * @typedef {object} PinIcon
 * @property {string} id     stable key, stored on saved pins
 * @property {string} name   label in the picker
 * @property {string} group  picker section
 * @property {(string|[string, string])[]} d    stroked SVG paths on a 24x24 viewBox,
 *           each either the path or the path and the colour to draw it in
 * @property {(string|[string, string])[]} [f]  filled paths, drawn after the stroked ones
 * @property {string[]} [sym] GPX <sym> / KML icon names that map to this icon
 * @property {string[]} [tags] extra words the picker's search should find it by
 * @property {number} [grid] the grid the paths are drawn on, when it is not 24
 */

/**
 * Every National Park Service symbol the library has for a place worth a
 * pin, as a picker group of its own.
 *
 * These are the pictograms on trailhead and campground signs across the
 * country, so a reader has already learned them somewhere other than this
 * app. They are filled shapes on a 22-unit grid where the drawn set is
 * strokes on 24, so each carries `grid: 22` and is nudged into the middle
 * when drawn. Ids are prefixed, since "cabin" and "trailhead" already name
 * drawn icons and a saved pin has to keep meaning what it meant.
 *
 * Their groups come from the library build, so a search that turns up both
 * kinds lists them under headings that mean the same thing.
 */
const PARK_SIGNS = NPS_ICONS.map((icon) => ({
  id: `nps-${icon.symbol}`,
  name: icon.name,
  // Filed under the same headings as the drawn set rather than in one flat
  // list of a hundred and seven, so somebody looking for golf does not scan
  // past a fish ladder to reach it.
  group: icon.group,
  sign: true,
  grid: 22,
  f: icon.f,
}));

/**
 * The few colours a glyph may be drawn in.
 *
 * Muted on purpose: these are read at twenty pixels over contours and
 * woodland, where a saturated palette turns to mud. Each material has a base
 * and a darker tone for its shaded side, which is what makes a drawn shape
 * read as an object rather than a silhouette - and keeping them named means a
 * new glyph joins the same world rather than inventing a shade.
 */
export const GLYPH = {
  ink: '#2A2118',
  white: '#FFFFFF',

  wood: '#8A5A2B',
  woodLight: '#A87142',
  woodDark: '#6E4620',

  flame: '#D9500F',
  ember: '#F3A012',
  spark: '#FBD54A',

  water: '#4A7FA8',
  waterDeep: '#35648A',
  foam: '#CFE2EF',

  leaf: '#2E7D4F',
  leafDark: '#23623D',

  stone: '#9A958C',
  stoneDark: '#6E6A63',

  brick: '#A8442B',
  brickDark: '#8A3520',

  shell: '#E8E2D4',

  warn: '#D98A0B',
  aid: '#C0392B',
};

/** @type {PinIcon[]} */
export const PIN_ICONS = [
  /* ---------------------------------------------------------------- camp */
  {
    id: 'tent', name: 'Tent site', group: 'Camp',
    f: [['M12 3c1.4 0 9.6 16.2 9.6 17.4 0 .8-19.2.8-19.2 0C2.4 19.2 10.6 3 12 3Zm0 8.2c-.8 0-3.8 8.4-3.8 9.2 0 .5 7.6.5 7.6 0 0-.8-3-9.2-3.8-9.2Z', GLYPH.leaf]],
    tags: ['camp', 'campground', 'campsite', 'recreation'],
    sym: ['Campground', 'Camp', 'Tent', 'Campsite'],
  },
  {
    id: 'camper', name: 'Camper / RV', group: 'Camp',
    f: [['M1.8 6.6h13.4l5 4.8v6.2H1.8Z', GLYPH.shell], ['M1.8 12.4h18.4v2.6H1.8Z', GLYPH.brick], ['M3.6 8.2h6.2v3.8H3.6Z', GLYPH.water], ['M15.2 8.8h2.8l1.9 2.6h-4.7Z', GLYPH.water], ['M6.6 15.4a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Zm9.8 0a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z', GLYPH.ink], ['M6.6 17.6a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Zm9.8 0a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z', GLYPH.shell]],
    tags: ['rv', 'trailer', 'motorhome', 'camp', 'recreation'],
    sym: ['RV', 'Trailer Head', 'RV Park'],
  },
  {
    id: 'campfire', name: 'Campfire', group: 'Camp',
    f: [['M3.4 17.4 19.4 13.7l.8 3.2L4.2 20.6Z', GLYPH.wood], ['M4.2 14 20.2 17.7l-.8 3.2L3.4 17.2Z', GLYPH.woodLight], ['M4.1 15.6a1.1 1.7 0 1 0 0 3.4 1.1 1.7 0 0 0 0-3.4Z', GLYPH.woodDark], ['M19.9 13.7a1 1.6 0 1 0 0 3.2 1 1.6 0 0 0 0-3.2Z', GLYPH.woodDark], ['M12 2.4c3.2 3.5 5.1 5.9 5.1 8.7a5.1 5.1 0 0 1-10.2 0c0-2.8 1.9-5.2 5.1-8.7Z', GLYPH.flame], ['M12 6.2c1.9 2.3 3 3.8 3 5.4a3 3 0 0 1-6 0c0-1.6 1.1-3.1 3-5.4Z', GLYPH.ember], ['M12 9.6c.9 1.2 1.4 1.9 1.4 2.7a1.4 1.4 0 0 1-2.8 0c0-.8.5-1.5 1.4-2.7Z', GLYPH.spark]],
    tags: ['fire', 'camp', 'ring', 'recreation'],
    sym: ['Fire', 'Campfire'],
  },
  {
    id: 'cabin', name: 'Cabin / shelter', group: 'Camp',
    f: [['M16.2 2.6h2.6v3l-2.6-1.9ZM12 3.4 23 11.5l-1.3 1.8L12 6.1 2.3 13.3 1 11.5ZM4.4 12.6h15.2v9.8H4.4Zm2 1.9v2.4h4.2v-2.4Zm7 0v2.4h4.2v-2.4Zm-3.1 4.3v3.6h3.4v-3.6Z', GLYPH.wood]],
    tags: ['building', 'lodge', 'shelter', 'hut', 'camp'],
    sym: ['Lodge', 'Cabin', 'Shelter', 'Hut'],
  },
  {
    id: 'picnic', name: 'Picnic area', group: 'Camp',
    f: [['M1.8 7.4h20.4v3.4H1.8Z', GLYPH.woodLight], ['M5.2 10.8h3.6L5.6 21.4H1.9Z', GLYPH.wood], ['M15.2 10.8h3.6l3.3 10.6h-3.7Z', GLYPH.wood], ['M3.2 14h17.6v3H3.2Z', GLYPH.wood]],
    sym: ['Picnic Area', 'Picnic'],
  },
  {
    id: 'lodging', name: 'Lodging', group: 'Camp',
    f: [['M1.8 6.4h3.2v14H1.8Z', GLYPH.woodDark], ['M5 11.8h16.2v5.6H5Z', GLYPH.shell], ['M11.4 11.8h9.8v5.6h-9.8Z', GLYPH.water], ['M6.2 13h4.8v3.2H6.2Z', GLYPH.white], ['M5 17.4h2.4v3.4H5Zm13.8 0h2.4v3.4h-2.4Z', GLYPH.woodDark]],
    sym: ['Hotel', 'Lodging'],
  },

  /* --------------------------------------------------------------- water */
  {
    id: 'water', name: 'Water source', group: 'Water',
    f: [['M12 3.2c4.2 5.4 6.4 8.2 6.4 10.8a6.4 6.4 0 0 1-12.8 0c0-2.6 2.2-5.4 6.4-10.8Z', GLYPH.water], ['M9.4 12.4a2.8 2.8 0 0 0 2.8 4.8 3.6 3.6 0 0 1-2.8-4.8Z', GLYPH.foam]],
    sym: ['Drinking Water', 'Water Source', 'Water'],
  },
  {
    id: 'spring', name: 'Spring', group: 'Water',
    f: [['M3.4 14.4h17.2v2.4a4.2 4.2 0 0 1-4.2 4.2H7.6a4.2 4.2 0 0 1-4.2-4.2Z', GLYPH.stone], ['M4.8 15.4h14.4v1.8a3.2 3.2 0 0 1-3.2 3.2H8a3.2 3.2 0 0 1-3.2-3.2Z', GLYPH.water], ['M11.1 8.6h1.8v6.2h-1.8Z', GLYPH.water], ['M12 2.6c1.9 2.7 2.9 4.3 2.9 5.8a2.9 2.9 0 0 1-5.8 0c0-1.5 1-3.1 2.9-5.8Z', GLYPH.water], ['M10.6 6.6a1.4 1.4 0 0 0 1.4 2.4 1.8 1.8 0 0 1-1.4-2.4Z', GLYPH.foam]],
    tags: ['water', 'seep', 'source'],
    sym: ['Spring'],
  },
  {
    id: 'waterfall', name: 'Waterfall', group: 'Water',
    f: [['M2.4 2.6h19.2v2.6c-2.4.9-4.6.7-7-.3-2.8-1.2-5.4-1.2-8.1-.1-1.3.5-2.6.7-4.1.5ZM6.2 6.6h2.1l-.4 9.6H5.8Zm4.7-.2h2.2l.1 9.8h-2.3Zm4.7.4h2.1l.5 9.4h-2.3ZM2 17.8c3.2-1.5 5.9-1.5 9.1 0 3.2 1.5 6.7 1.5 10.9 0v3.6c-4.2 1.5-7.7 1.5-10.9 0-3.2-1.5-5.9-1.5-9.1 0Z', GLYPH.water]],
    tags: ['water', 'falls', 'cascade', 'cataract'],
    sym: ['Waterfall', 'Falls', 'Cascade'],
  },
  {
    id: 'ford', name: 'River crossing', group: 'Water',
    f: [['M2 5.8h20v2.4H2Z', GLYPH.wood], ['M6.6 22 9 8.2h6L17.4 22Z', GLYPH.wood], ['M11.4 18.6h1.3v3h-1.3Zm.4-4.4h1.3v3h-1.3Zm.4-4.4h1.3v3h-1.3Z', GLYPH.shell], ['M2 8.2h20v6.2H2Z', GLYPH.water], ['M2.8 9.6h18.4v1.2H2.8Zm0 2.6h18.4v1.2H2.8Z', GLYPH.foam]],
    tags: ['water', 'crossing', 'creek', 'stream'],
    sym: ['Ford', 'Crossing'],
  },
  {
    id: 'fishing', name: 'Fishing', group: 'Water',
    f: [['M2.8 12c3.9-5.4 9.9-5.4 13.8 0-3.9 5.4-9.9 5.4-13.8 0Zm14.6 0 4.3-3.6c.4-.3 1 0 1 .5v6.2c0 .5-.6.8-1 .5Z', GLYPH.water], ['M7.6 10.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z', GLYPH.white]],
    tags: ['fish', 'angling', 'water', 'recreation'],
    sym: ['Fishing Area', 'Fishing'],
  },

  /* -------------------------------------------------------------- terrain */
  {
    id: 'peak', name: 'Summit', group: 'Terrain',
    f: [['M12 2.8c.9 0 4 6.2 5.6 9.2 1.5 2.9 4.4 8 3.9 8.8-.4.7-18.6.7-19 0-.5-.8 2.4-5.9 3.9-8.8C8 9 11.1 2.8 12 2.8Zm0 4.6-2.4 4.6c1.6.8 3.2.8 4.8 0Z', GLYPH.stone]],
    tags: ['summit', 'mountain', 'high point', 'recreation'],
    sym: ['Summit', 'Peak', 'Mountain'],
  },
  {
    id: 'pass', name: 'Pass / gap', group: 'Terrain',
    d: ['M2 20 8 9l4 6', 'M22 20 16 9l-4 6', 'M12 15v5'],
    sym: ['Pass', 'Gap', 'Saddle'],
  },
  {
    id: 'viewpoint', name: 'Overlook', group: 'Terrain',
    d: ['M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
    tags: ['view', 'vista', 'scenic', 'overlook', 'recreation'],
    sym: ['Scenic Area', 'Overlook', 'Viewpoint', 'Vista'],
  },
  {
    id: 'cave', name: 'Cave', group: 'Terrain',
    d: ['M3 20V13a9 9 0 0 1 18 0v7', 'M9 20v-4a3 3 0 0 1 6 0v4'],
    tags: ['cavern', 'karst', 'grotto', 'recreation'],
    sym: ['Cave'],
  },
  {
    id: 'forest', name: 'Forest', group: 'Terrain',
    f: [['M12 1.6 8.1 7.4h1.6L6.5 12h1.9l-4 5.8h6.5v4.6h2.2v-4.6h6.5l-4-5.8h1.9l-3.2-4.6h1.6Z', GLYPH.leaf]],
    sym: ['Forest', 'Park', 'Tree'],
  },
  {
    id: 'wildlife', name: 'Wildlife', group: 'Terrain',
    d: [['M6 5 4 9l3 2', GLYPH.wood], ['M18 5l2 4-3 2', GLYPH.wood], ['M7 11c0 4 2 8 5 8s5-4 5-8', GLYPH.wood], ['M9 11h6', GLYPH.wood]],
    sym: ['Animal', 'Wildlife', 'Hunting Area'],
  },

  /* --------------------------------------------------------------- access */
  {
    id: 'trailhead', name: 'Trailhead', group: 'Access',
    d: ['M7 21c0-6 3-6 3-11S7 5 7 3', 'M17 21c0-5-3-5-3-9s3-4 3-6'],
    tags: ['hike', 'hiking', 'walk', 'recreation', 'trail'],
    sym: ['Trailhead', 'Trail Head', 'Hiking', 'Hiker', 'Trail', 'Recreation', 'Recreation Area'],
  },
  {
    id: 'parking', name: 'Parking', group: 'Access',
    d: ['M8 20V5h5a4.5 4.5 0 0 1 0 9H8'],
    sym: ['Parking Area', 'Parking'],
  },
  {
    id: 'gate', name: 'Gate', group: 'Access',
    d: ['M3 6v14', 'M21 6v14', 'M3 9h18', 'M3 16h18', 'M3 12.5h18'],
    tags: ['access', 'barrier'],
    sym: ['Gate'],
  },
  {
    id: 'gate-locked', name: 'Locked gate', group: 'Access',
    d: ['M4 6v14', 'M20 6v14', 'M4 9h16', 'M4 16h16', 'M9.5 14.5h5v4h-5z', 'M10.5 14.5v-1.5a1.5 1.5 0 0 1 3 0v1.5'],
    tags: ['access', 'barrier', 'closed', 'private'],
    sym: ['Locked Gate', 'Closed'],
  },
  {
    id: 'fourwd', name: '4WD / high clearance', group: 'Access',
    d: ['M3 15h18', 'M5 15V9l3-3h6l3 4v5'],
    f: ['M7.5 19a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z', 'M16.5 19a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z'],
    tags: ['4wd', 'four wheel drive', 'high clearance', 'offroad'],
    sym: ['Four Wheel Drive', '4WD', 'Off Road'],
  },
  {
    id: 'obstacle', name: 'Rough section', group: 'Access',
    d: ['M2 19h20', 'M5 19l3-6 3 6', 'M12 19l3-8 4 8'],
    sym: ['Rock', 'Obstacle'],
  },
  {
    id: 'bridge', name: 'Bridge', group: 'Access',
    d: ['M2 9h20', 'M3 9v10', 'M21 9v10', 'M3 15c4.5-5 13.5-5 18 0'],
    tags: ['crossing', 'span', 'trestle', 'viaduct'],
    sym: ['Bridge', 'Trestle Bridge', 'Truss'],
  },
  {
    id: 'junction', name: 'Junction', group: 'Access',
    d: ['M12 21V8', 'M12 8 5 3', 'M12 8l7-5'],
    sym: ['Junction', 'Intersection'],
  },
  {
    id: 'steep', name: 'Steep grade', group: 'Access',
    d: ['M3 20h18', 'M3 20 19 6', 'M19 6v6'],
    sym: ['Steep', 'Grade'],
  },

  /* ------------------------------------------------------------- services */
  {
    id: 'fuel', name: 'Fuel', group: 'Services',
    d: ['M4 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16', 'M3 21h11', 'M4 10h9', 'M13 8h3l2 2v7a2 2 0 0 0 2-2v-6l-2-3'],
    sym: ['Gas Station', 'Fuel'],
  },
  {
    id: 'air', name: 'Air / tyres', group: 'Services',
    d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M12 3v5.5', 'M4.5 17l4.7-2.7', 'M19.5 17l-4.7-2.7'],
    sym: ['Air', 'Tire'],
  },
  {
    id: 'mechanic', name: 'Mechanic', group: 'Services',
    d: ['M15.5 3.5a5 5 0 0 0-6.2 6.7L3 16.5 7.5 21l6.3-6.3a5 5 0 0 0 6.7-6.2l-3.2 3.2-2.8-.7-.7-2.8 3.2-3.2Z'],
    sym: ['Car Repair', 'Mechanic'],
  },
  {
    id: 'store', name: 'Store / supplies', group: 'Services',
    d: ['M3 7h18l-1.5 4H4.5L3 7Z', 'M5 11v9h14v-9', 'M9 20v-5h6v5'],
    sym: ['Shopping Center', 'Store', 'Convenience Store', 'Grocery'],
  },
  {
    id: 'restroom', name: 'Restroom', group: 'Services',
    d: ['M8 21v-6H6l2-6h3l1.5 4', 'M16.5 21v-5h2l-2-6h-2', 'M12 3v18'],
    f: ['M8.5 7.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z', 'M16 7.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z'],
    sym: ['Restroom', 'Toilet', 'Restrooms'],
  },
  {
    id: 'shower', name: 'Shower', group: 'Services',
    d: ['M5 13V7a3 3 0 0 1 6 0', 'M3 13h11', 'M6 17v2', 'M9 16v3', 'M12 17v2', 'M17 6h4', 'M19 6v7'],
    sym: ['Shower'],
  },
  {
    id: 'dump', name: 'Dump station', group: 'Services',
    d: ['M4 6h12v8H4z', 'M16 9h3l2 3v2h-5', 'M7 18v2', 'M13 18v2', 'M4 14v2h15v-2'],
    sym: ['Dump Station'],
  },
  {
    id: 'signal', name: 'Cell signal', group: 'Services',
    d: ['M4 20V14', 'M9.3 20V10', 'M14.7 20V6', 'M20 20V3'],
    tags: ['cell', 'phone', 'reception', 'tower'],
    sym: ['Cell Tower', 'Signal', 'Telephone'],
  },

  /* ------------------------------------------------------------- interest */
  {
    id: 'historic', name: 'Historic site', group: 'Interest',
    d: ['M3 20h18', 'M5 20V9l7-5 7 5v11', 'M9 20v-6h6v6'],
    tags: ['building', 'landmark', 'heritage', 'monument', 'museum'],
    sym: ['Building', 'Historic', 'Historic Site', 'Museum', 'Monument', 'Landmark', 'Courthouse'],
  },
  {
    id: 'ruins', name: 'Ghost town / ruins', group: 'Interest',
    d: ['M3 21V11l4-3v4l4-3v5l4-4v4l3-2v9', 'M2 21h20'],
    tags: ['building', 'ghost town', 'abandoned', 'derelict', 'historic'],
    sym: ['Ghost Town', 'Ruins', 'Ruin', 'Abandoned Town'],
  },
  {
    id: 'mine', name: 'Mine', group: 'Interest',
    d: ['M4 20 14 5', 'M9.5 12.5 20 20', 'M17 4l3 3', 'M15.5 5.5 18.5 8.5'],
    tags: ['mining', 'quarry', 'shaft', 'adit', 'industry'],
    sym: ['Mine', 'Mining'],
  },
  {
    id: 'tower', name: 'Fire lookout tower', group: 'Interest',
    f: [['M5.2 3.1h13.6l-1.5 2.2h-1v2.2h1.1v2.1H6.6V7.5h1.1V5.3h-1ZM9.5 5.3v2.2h5V5.3ZM6.6 10.4h10.8v1.5H6.6ZM8.9 12.4h1.7l-1.2 4.1h4.2l-1.2-4.1h1.7l2.6 9h-1.8l-.6-2.1H8.7l-.6 2.1H6.3ZM9.2 17.9h5.6l.4 1.4H8.8ZM4.4 21.4h15.2v1.5H4.4Z', GLYPH.wood]],
    tags: ['building', 'fire lookout', 'watchtower', 'historic'],
    sym: ['Tower', 'Lookout', 'Fire Tower', 'Fire Lookout', 'Lookout Tower', 'Observation Tower'],
  },
  {
    id: 'photo', name: 'Photo spot', group: 'Interest',
    d: ['M3 8h4l2-3h6l2 3h4v12H3V8Z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
    tags: ['camera', 'picture', 'photography'],
    sym: ['Photo', 'Camera'],
  },
  {
    id: 'ranger', name: 'Ranger / info', group: 'Interest',
    d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v6'],
    f: ['M12 8.4a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3Z'],
    sym: ['Information', 'Ranger Station', 'Info', 'Visitor Center'],
  },

  /* --------------------------------------------------------------- hazard */
  {
    id: 'hazard', name: 'Hazard', group: 'Hazard',
    d: [['M12 3.5 22 20.5H2L12 3.5Z', GLYPH.warn], 'M12 10v4.5'],
    f: ['M12 18.3a1.05 1.05 0 1 0 0-2.1 1.05 1.05 0 0 0 0 2.1Z'],
    sym: ['Danger', 'Hazard', 'Warning'],
  },
  {
    id: 'private', name: 'Private / no entry', group: 'Hazard',
    d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M5.6 5.6l12.8 12.8'],
    sym: ['Private', 'No Entry', 'Restricted', 'Prohibited'],
  },
  {
    id: 'firstaid', name: 'First aid', group: 'Hazard',
    d: ['M3 7h18v12H3z', ['M12 10v6', GLYPH.aid], ['M9 13h6', GLYPH.aid]],
    sym: ['Medical Facility', 'First Aid'],
  },

  /* ---------------------------------------------------------------- basic */
  {
    id: 'pin', name: 'Plain pin', group: 'Basic',
    d: ['M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z', 'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
    tags: ['marker', 'generic', 'other', 'misc', 'default'],
    sym: ['Waypoint', 'Pin', 'Dot', 'Circle'],
  },
  {
    id: 'flag', name: 'Flag', group: 'Basic',
    d: ['M5 21V4', 'M5 5h12l-2.5 4L17 13H5'],
    tags: ['marker', 'generic', 'other', 'misc'],
    sym: ['Flag', 'Flag, Blue', 'Flag, Green', 'Flag, Red'],
  },
  {
    id: 'star', name: 'Star', group: 'Basic',
    d: ['M12 3.5l2.6 5.6 6 .8-4.4 4.3 1.1 6.1-5.3-2.9-5.3 2.9 1.1-6.1L3.4 9.9l6-.8L12 3.5Z'],
    tags: ['marker', 'favourite', 'favorite', 'generic', 'other', 'misc'],
    sym: ['Star', 'Favorite', 'Anchor'],
  },
  {
    id: 'marker', name: 'Cross-hair', group: 'Basic',
    d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4'],
    tags: ['generic', 'other', 'misc', 'crosshair'],
    sym: ['Crosshair', 'Target'],
  },
  /* -------------------------------------------------------------- places */
  {
    id: 'house', name: 'House', group: 'Places',
    d: ['M3 12 12 4l9 8', 'M5 10.5V21h14V10.5', 'M10 21v-5h4v5', 'M17 5v3.5'],
    tags: ['building', 'home', 'residence', 'farmhouse', 'dwelling'],
    sym: ['House', 'Home', 'Residence', 'Farmhouse'],
  },
  {
    id: 'abandoned', name: 'Abandoned business', group: 'Places',
    d: ['M3 21V9', 'M21 21V9', 'M2 9l2-4h16l2 4', 'M2 21h20', 'M9 21v-7h6v7', 'M9 14l6 7', 'M15 14l-6 7'],
    tags: ['building', 'store', 'shop', 'business', 'derelict', 'vacant', 'closed'],
    sym: ['Abandoned', 'Abandoned Business', 'Derelict', 'Vacant', 'Out of Business'],
  },
  {
    id: 'abandoned-building', name: 'Abandoned building', group: 'Places',
    // A building crossed out, where 'abandoned' is a storefront with its
    // awning: one is a shut shop, the other is a boarded-up house or works.
    d: ['M4 21V9l8-5 8 5v12', 'M2 21h20', 'M7.5 12.5l9 6', 'M16.5 12.5l-9 6'],
    tags: ['building', 'derelict', 'boarded', 'condemned', 'empty', 'ruin', 'house', 'decay'],
    sym: ['Abandoned Building', 'Derelict Building', 'Boarded Up', 'Condemned'],
  },
  {
    id: 'hospital', name: 'Hospital', group: 'Places',
    d: ['M4 21V6h16v15', 'M2 21h20', 'M12 8.5v6', 'M9 11.5h6', 'M10 21v-3.5h4V21'],
    tags: ['building', 'medical', 'asylum', 'sanatorium', 'clinic'],
    sym: ['Hospital', 'Medical', 'Clinic', 'Asylum', 'Sanatorium'],
  },
  {
    id: 'school', name: 'School', group: 'Places',
    d: ['M2 9l10-4 10 4-10 4L2 9Z', 'M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5', 'M22 9v5'],
    tags: ['building', 'schoolhouse', 'college', 'university'],
    sym: ['School', 'Schoolhouse', 'College', 'University', 'Academy'],
  },
  {
    id: 'church', name: 'Church', group: 'Places',
    d: ['M12 2v5', 'M9.5 4.5h5', 'M6 21V12l6-5 6 5v9', 'M2 21h20', 'M10 21v-4h4v4'],
    tags: ['building', 'chapel', 'religious', 'worship', 'meetinghouse'],
    sym: ['Church', 'Chapel', 'Religious', 'Place of Worship', 'Mission', 'Temple'],
  },
  {
    id: 'industry', name: 'Industry', group: 'Places',
    d: ['M3 21V10l5 3v-3l5 3v-3l5 3v8', 'M2 21h20', 'M4 10V4h3v7'],
    tags: ['building', 'factory', 'mill', 'plant', 'works', 'furnace'],
    sym: ['Industry', 'Factory', 'Mill', 'Plant', 'Industrial', 'Furnace', 'Works'],
  },
  {
    id: 'military', name: 'Military', group: 'Places',
    d: ['M12 3 4 6v6c0 4.5 3.5 7.6 8 9 4.5-1.4 8-4.5 8-9V6l-8-3Z'],
    f: ['M12 8l1.2 2.4 2.6.4-1.9 1.8.5 2.6L12 14l-2.4 1.2.5-2.6-1.9-1.8 2.6-.4L12 8Z'],
    tags: ['building', 'fort', 'base', 'armory', 'battlefield'],
    sym: ['Military', 'Fort', 'Base', 'Armory', 'Battlefield', 'Bunker'],
  },
  {
    id: 'cemetery', name: 'Cemetery', group: 'Places',
    d: ['M6 21V9a6 6 0 0 1 12 0v12', 'M3 21h18', 'M12 8v7', 'M9 11h6'],
    tags: ['grave', 'graveyard', 'burial', 'headstone', 'historic'],
    sym: ['Cemetery', 'Grave', 'Graveyard', 'Burial', 'Tomb'],
  },
  {
    id: 'lighthouse', name: 'Lighthouse', group: 'Places',
    d: ['M9 21l1.5-11h3L15 21', 'M8 10h8', 'M10 10V6h4v4', 'M6 21h12', 'M2.5 8h3.5', 'M18 8h3.5', 'M9.8 15.5h4.4'],
    tags: ['building', 'beacon', 'light', 'water', 'coast'],
    sym: ['Lighthouse', 'Light', 'Beacon'],
  },
  {
    id: 'scenic', name: 'Scenic view', group: 'Places',
    d: ['M2 20l6-9 4 6 3-4 7 7H2Z'],
    f: ['M17.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
    tags: ['view', 'vista', 'overlook', 'landscape', 'recreation'],
    sym: ['Scenic', 'Scenic View', 'Scenery', 'Landscape', 'View'],
  },

  /* ---------------------------------------------------------------- ways */
  {
    id: 'covered-bridge', name: 'Covered bridge', group: 'Ways',
    f: [['M1.6 17.8c4.6 1.7 16.2 1.7 20.8 0v3.4c-4.6 1.7-16.2 1.7-20.8 0Z', GLYPH.water], ['M3.4 10.2h17.2v8.4H3.4Z', GLYPH.brick], ['M8.4 12.6h7.2v6H8.4Z', GLYPH.woodDark], ['M1.8 10.6 12 4 22.2 10.6l-1.5 2.3L12 7.1 3.3 12.9Z', GLYPH.woodDark]],
    tags: ['bridge', 'crossing', 'historic', 'timber', 'kissing bridge'],
    sym: ['Covered Bridge'],
  },
  {
    id: 'canal', name: 'Canal / lock', group: 'Ways',
    d: ['M4 3v18', 'M20 3v18', 'M4 9l8 4 8-4', 'M7 17c1.7 1.2 3.3 1.2 5 0s3.3-1.2 5 0'],
    tags: ['water', 'lock', 'towpath', 'aqueduct', 'navigation'],
    sym: ['Canal', 'Lock', 'Canal Lock', 'Aqueduct'],
  },
  {
    id: 'dam', name: 'Dam', group: 'Ways',
    d: ['M3 21V5h5l4 16H3Z', 'M14 21h7', 'M13 10c2.5 1.5 5.5 1.5 8 0', 'M13 15c2.5 1.5 5.5 1.5 8 0'],
    tags: ['water', 'reservoir', 'spillway', 'impoundment'],
    sym: ['Dam', 'Reservoir', 'Spillway'],
  },
  {
    id: 'railroad', name: 'Railroad', group: 'Ways',
    d: ['M7 3v18', 'M17 3v18', 'M5 7h14', 'M5 12h14', 'M5 17h14'],
    tags: ['rail', 'railway', 'train', 'trestle', 'depot', 'grade'],
    sym: ['Railroad', 'Railway', 'Rail', 'Train', 'Depot', 'Station', 'Trestle'],
  },
  {
    id: 'road', name: 'Road', group: 'Ways',
    d: ['M4 21 9 3h6l5 18', 'M12 6v3', 'M12 12v3', 'M12 18v3'],
    tags: ['highway', 'byway', 'alignment', 'turnpike', 'route'],
    sym: ['Road', 'Highway', 'Old Road', 'Alignment', 'Byway'],
  },
  {
    id: 'tunnel', name: 'Tunnel', group: 'Ways',
    d: ['M3 21V12a9 9 0 0 1 18 0v9', 'M2 21h20', 'M7 21v-8a5 5 0 0 1 10 0v8'],
    tags: ['portal', 'bore', 'underpass', 'railroad'],
    sym: ['Tunnel', 'Portal', 'Underpass'],
  },
  ...PARK_SIGNS,
];

export const DEFAULT_PIN_ICON = 'pin';

const BY_ID = new Map(PIN_ICONS.map((icon) => [icon.id, icon]));

export function getPinIcon(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_PIN_ICON);
}

/**
 * The colour a pin wears: its own, else ink.
 *
 * Its own means the colour on the pin - chosen in the editor, or carried in
 * from GaiaGPS, where a person may have coloured every visited tower blue.
 * Nothing else decides it: not the symbol, not the folder. One function so
 * the five places that draw a pin agree.
 */
export function pinColorFor(props = null, fallback = PIN_INK) {
  return props?.color || fallback;
}

/**
 * Words that stand for a family of symbols.
 *
 * Typing "building" should not have to match the word "building": it should
 * bring back the house, the church, the mill and the courthouse. So the query
 * is expanded rather than the icons being tagged with every word somebody
 * might reach for - one table here beats forty lists spread through the set.
 */
export const ICON_SYNONYMS = {
  building: ['building', 'house', 'home', 'church', 'chapel', 'school', 'hospital', 'industry',
    'factory', 'mill', 'historic', 'ruin', 'cabin', 'lodging', 'tower', 'lighthouse', 'museum',
    'library', 'store', 'shelter', 'station', 'office', 'theater', 'stable', 'cemetery',
    'abandoned', 'visitor', 'ranger', 'amphitheater'],
  abandoned: ['abandoned', 'ruin', 'ghost', 'derelict', 'vacant', 'decay', 'shipwreck'],
  historic: ['historic', 'monument', 'museum', 'statue', 'cannon', 'ruin', 'cemetery', 'covered',
    'stagecoach', 'shipwreck', 'tower', 'mine', 'mill'],
  water: ['water', 'lake', 'river', 'falls', 'waterfall', 'spring', 'ford', 'fishing', 'boat',
    'marina', 'canal', 'dam', 'swim', 'kayak', 'canoe', 'raft', 'pier', 'lighthouse', 'ferry',
    'tidepool', 'wading', 'whale', 'waterfowl', 'fish'],
  recreation: ['trail', 'hike', 'camp', 'ski', 'golf', 'climb', 'fish', 'swim', 'bicycle', 'bike',
    'horse', 'playground', 'sled', 'skating', 'boat', 'kayak', 'raft', 'picnic', 'viewing',
    'hunting', 'caving', 'star', 'scenic', 'snowmobile'],
  rail: ['rail', 'train', 'railroad', 'tunnel', 'trestle', 'depot', 'station', 'crossing'],
  road: ['road', 'highway', 'byway', 'bridge', 'tunnel', 'ford', 'gate', 'parking', 'four'],
  danger: ['hazard', 'falling', 'rattlesnake', 'construction', 'emergencies', 'private', 'steep',
    'obstacle', 'locked'],
  food: ['food', 'store', 'picnic', 'coffee', 'restaurant', 'supplies', 'snack'],
  sleep: ['lodging', 'cabin', 'camp', 'tent', 'shelter', 'trailer', 'campsite'],
  car: ['fuel', 'gas', 'mechanic', 'air', 'parking', 'towing', 'charging', 'dump', 'rv'],
};

/**
 * Every word a search should be able to find one icon by.
 *
 * Words, not one long string: matching a raw substring made "rail" find every
 * ski *trail*, which is the kind of result that teaches somebody the search
 * does not work. A term matches a word it starts - so "build" finds
 * "building" and "rail" finds "railroad", and neither finds "trail".
 */
const haystack = (icon) => [icon.id, icon.name, icon.group, ...(icon.tags || []), ...(icon.sym || [])]
  .join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The icons a typed query should offer, in the order the picker shows them.
 *
 * Every typed word has to match (so "covered bridge" is narrower than either
 * word alone), and a word matches if it or any of its synonyms appears. A
 * name that starts with the query sorts first, because somebody typing "camp"
 * means the campsite before the campfire ring.
 */
export function searchPinIcons(query, icons = PIN_ICONS) {
  const words = String(query || '').toLowerCase().replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const matches = icons.filter((icon) => {
    const text = haystack(icon);
    return words.every((word) => [word, ...(ICON_SYNONYMS[word] || [])]
      .some((term) => text.some((held) => held.startsWith(term))));
  });

  const first = words[0];
  const rank = (icon) => {
    const name = icon.name.toLowerCase();
    if (name === first) return 0;
    if (name.startsWith(first)) return 1;
    if (name.includes(first)) return 2;
    return 3;
  };
  return matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function pinIconGroups() {
  const groups = new Map();
  for (const icon of PIN_ICONS) {
    if (!groups.has(icon.group)) groups.set(icon.group, []);
    groups.get(icon.group).push(icon);
  }
  return groups;
}

/**
 * GPX <sym> and KML icon names, lowercased, mapped to our icon ids.
 *
 * GaiaGPS and Garmin both write a free-text symbol name on every waypoint. It
 * is the only styling hint most GPX files carry, so honouring it means an
 * import arrives already looking right instead of as a field of identical dots.
 */
/**
 * "Fire-Lookout", "fire_lookout" and "Fire Lookout" are one name. Gaia writes
 * the hyphenated form; a person types the spaced one; the table holds it once.
 */
const plainName = (name) => String(name || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');

const SYMBOL_LOOKUP = (() => {
  const lookup = new Map();
  for (const icon of PIN_ICONS) {
    for (const name of icon.sym || []) lookup.set(plainName(name), icon.id);
  }
  return lookup;
})();

/**
 * Best icon for a source symbol name. Falls back to a loose word match before
 * giving up, since exporters vary ("Campground" / "Camp Area" / "campsite").
 */
/**
 * Gaia lets a pin be an emoji, and writes it as "emoji-" plus the character.
 * The handful that mean a place here are named; the rest resolve to nothing
 * and keep their emoji as the symbol text beside the plain pin.
 */
const EMOJI_ICONS = new Map([
  ['\u{1F3ED}', 'industry'],   // factory
  ['\u{1F3E5}', 'hospital'],
  ['\u{1F3E0}', 'house'],
  ['\u{26EA}', 'church'],
  ['\u{1F3EB}', 'school'],
  ['\u{1F309}', 'bridge'],
  ['\u{1F682}', 'railroad'],   // locomotive
  ['\u{1F6E4}', 'railroad'],   // railway track
  ['\u{1F6E3}', 'road'],
  ['\u{1F30A}', 'waterfall'],
  ['\u{2693}', 'lighthouse'],
  ['\u{1FAA6}', 'cemetery'],   // headstone
  ['\u{26FA}', 'tent'],
  ['\u{1F525}', 'campfire'],
  ['\u{1F3F0}', 'historic'],   // castle
  ['\u{1F3DA}', 'abandoned'],  // derelict house
  ['\u{1F396}', 'military'],   // medal
  ['\u{1F6A7}', 'hazard'],
  ['\u{26F0}', 'peak'],
  ['\u{1F304}', 'scenic'],     // sunrise over mountains
]);

export function iconForSymbol(symbol) {
  const typed = String(symbol || '').trim().toLowerCase();
  if (!typed) return null;

  if (typed.startsWith('emoji-')) {
    // Variation selectors ride along with some emoji; the table has the bare character.
    const character = typed.slice('emoji-'.length).replace(/[\ufe0e\ufe0f]/g, '');
    return EMOJI_ICONS.get(character) || null;
  }
  const raw = plainName(typed);

  const exact = SYMBOL_LOOKUP.get(raw);
  if (exact) return exact;

  // Garmin writes things like "Flag, Blue"; take the part before the comma.
  const head = raw.split(',')[0].trim();
  if (head !== raw && SYMBOL_LOOKUP.has(head)) return SYMBOL_LOOKUP.get(head);

  /*
   * The longest alias that overlaps wins, not the first.
   *
   * Taking the first hit in table order sent "fire lookout" to the campfire,
   * because "fire" is listed before "lookout". The more of the reader's word
   * an alias accounts for, the more likely it is the one they meant.
   */
  let best = null;
  for (const [name, id] of SYMBOL_LOOKUP) {
    if (!(raw.includes(name) || name.includes(raw))) continue;
    if (!best || name.length > best.name.length) best = { name, id };
  }
  return best ? best.id : null;
}

/**
 * A path entry, which is either the path or the path and the colour to draw it.
 *
 * Written this way so an icon that wants no colour stays a list of strings -
 * most of them do, and a uniform `{d, colour}` shape would have added a
 * wrapper to a hundred and sixty glyphs to serve ten.
 */
const pathAndColour = (entry) => (Array.isArray(entry) ? entry : [entry, null]);

/** Inline SVG markup for a UI button, sized to the caller's CSS. */
export function pinIconSVG(id, { size = 20, stroke = 1.7 } = {}) {
  const icon = getPinIcon(id);
  const strokes = (icon.d || []).map((entry) => {
    const [d, colour] = pathAndColour(entry);
    return `<path d="${d}"${colour ? ` stroke="${colour}"` : ''}/>`;
  }).join('');
  /*
   * even-odd, because the detail in a drawn symbol is a hole.
   *
   * A cabin's windows and a lookout's cab are subpaths inside the outline,
   * and under the default non-zero rule whether they punch through depends
   * on which way each was wound - which is invisible in the data and was
   * true by luck for the two that already had holes. Stating the rule makes
   * a hole a hole.
   */
  const fills = (icon.f || []).map((entry) => {
    const [d, colour] = pathAndColour(entry);
    return `<path d="${d}" fill="${colour || 'currentColor'}" fill-rule="evenodd" stroke="none"/>`;
  }).join('');
  // A 22-grid glyph sits one unit in from each edge of the 24 box.
  const shift = icon.grid && icon.grid !== 24 ? (24 - icon.grid) / 2 : 0;
  const body = shift ? `<g transform="translate(${shift} ${shift})">${strokes}${fills}</g>` : `${strokes}${fills}`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"`
    + ` stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/**
 * Rasterise one icon to an ImageData for map.addImage().
 *
 * Drawn in ink, at `pixelRatio` scale. It sits on a white disc whose ring
 * carries the pin's colour, so it needs no shadow and no white - the symbol
 * is the contrast, the colour is the edge.
 */

export function rasterizePinIcon(id, { size = 22, pixelRatio = 2 } = {}) {
  const icon = getPinIcon(id);
  const px = Math.round(size * pixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const scale = px / 24;
  ctx.scale(scale, scale);
  if (icon.grid && icon.grid !== 24) {
    const shift = (24 - icon.grid) / 2;
    ctx.translate(shift, shift);
  }
  ctx.strokeStyle = PIN_INK;
  ctx.fillStyle = PIN_INK;
  ctx.lineWidth = 2.1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const entry of icon.d || []) {
    const [d, colour] = pathAndColour(entry);
    ctx.strokeStyle = colour || PIN_INK;
    ctx.stroke(new Path2D(d));
  }
  for (const entry of icon.f || []) {
    const [d, colour] = pathAndColour(entry);
    ctx.fillStyle = colour || PIN_INK;
    // Same rule as the SVG above, or the map image and the panel disagree.
    ctx.fill(new Path2D(d), 'evenodd');
  }

  return ctx.getImageData(0, 0, px, px);
}

/** Map image id for an icon; kept in one place so layer specs and adds agree. */
export const pinImageId = (id) => `pin-${id}`;

/**
 * Register every icon as a map image. Safe to call again after a style change,
 * which discards all images.
 */
export function registerPinImages(map, { pixelRatio = 2 } = {}) {
  let added = 0;
  for (const icon of PIN_ICONS) {
    const imageId = pinImageId(icon.id);
    if (map.hasImage && map.hasImage(imageId)) continue;
    const data = rasterizePinIcon(icon.id, { pixelRatio });
    if (!data) continue;
    try {
      map.addImage(imageId, data, { pixelRatio });
      added++;
    } catch {
      // Already present, or the style was swapped mid-loop; neither is fatal.
    }
  }
  return added;
}
