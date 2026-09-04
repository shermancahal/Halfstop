/**
 * The Halfstop pin set: symbols for the places a back-roads atlas is about.
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
 * pin and the drawn set does not already cover, as a picker group of its own.
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
/**
 * Icons that were retired, and what they became.
 *
 * The library has a campground, a campsite and an RV campground; the drawn set
 * has a tent and a camper that mean exactly those things and look like this
 * app. Two pictures for one meaning is a worse picker, not a richer one, so the
 * sign is dropped and the drawn icon is the answer.
 *
 * The mapping is kept rather than the ids simply deleted, because a pin saved
 * last month may still name one: `getPinIcon` follows it so the pin keeps its
 * meaning, and the editor selects the drawn icon it now wears.
 */
const RETIRED_ICONS = {
  // Two abandoned pins became one; see the note on the icon itself.
  'abandoned-building': 'abandoned',
  'nps-campground': 'tent',
  'nps-campsite': 'tent',
  'nps-rv-campground': 'camper',
  'nps-campfire': 'campfire',
  'nps-cabin': 'cabin',
  'nps-shelter': 'cabin',
  'nps-lodging': 'lodging',
  'nps-picnic-area': 'picnic',
  'nps-drinking-water': 'water',
  'nps-spring': 'spring',
  'nps-waterfall': 'waterfall',
  'nps-fishing': 'fishing',
  'nps-dam': 'dam',
  'nps-lighthouse': 'lighthouse',
  'nps-caving': 'cave',
  'nps-deer-viewing': 'wildlife',
  'nps-scenic-viewpoint': 'viewpoint',
  'nps-photography': 'photo',
  'nps-trailhead': 'trailhead',
  'nps-parking': 'parking',
  'nps-four-wheel-drive-road': 'fourwd',
  'nps-bridge': 'bridge',
  'nps-tunnel': 'tunnel',
  'nps-gas-station': 'fuel',
  'nps-mechanic': 'mechanic',
  'nps-store': 'store',
  'nps-restrooms': 'restroom',
  'nps-showers': 'shower',
  'nps-sanitary-disposal-station': 'dump',
  'nps-cellular-signal': 'signal',
  'nps-ranger-station': 'ranger',
  'nps-historic-feature': 'historic',
  'nps-lookout-tower': 'tower',
  'nps-chapel': 'church',
  'nps-hospital': 'hospital',
  'nps-first-aid': 'firstaid',
  'nps-boat-launch': 'boat',
  'nps-boating': 'boat',
  'nps-canoe-access': 'paddle',
  'nps-kayaking': 'paddle',
  'nps-river-rafting': 'paddle',
  'nps-swimming': 'swimming',
  'nps-wading': 'swimming',
  'nps-geyser': 'geyser',
  'nps-bicycle-trail': 'bicycle',
  'nps-horseback-riding': 'horse',
  'nps-climbing': 'climbing',
  'nps-star-gazing': 'stars',
  'nps-museum': 'museum',
  'nps-monument': 'monument',
  'nps-falling-rocks': 'rockfall',
  'nps-marina': 'marina',
  'nps-vehicle-ferry': 'ferry',
  'nps-bear-viewing': 'bear',
  'nps-birding-wildlife-viewing': 'bird',
  'nps-waterfowl': 'bird',
  'nps-flower-viewing': 'flower',
  'nps-food-service': 'food',
  'nps-telephone': 'phone',
  'nps-wi-fi': 'wifi',
  'nps-airport': 'airport',
  'nps-airfield': 'airport',
  'nps-sea-plane': 'airport',
  'nps-rail-station': 'train',
  'nps-metro-station': 'train',
  'nps-construction': 'construction',
  'nps-information': 'ranger',
  'nps-interpretive-exhibit': 'museum',
  'nps-statue': 'monument',
  'nps-self-guiding-trail': 'trailhead',
  'nps-viewing-area': 'viewpoint',
  'nps-wilderness': 'forest',
  'nps-emergencies': 'firstaid',
  'nps-beach-access': 'beach',
  'nps-shipwreck': 'shipwreck',
  'nps-downhill-skiing': 'ski',
  'nps-cross-country-ski-trail': 'ski',
  'nps-playground': 'playground',
  'nps-stable': 'barn',
  'nps-cannon': 'cannon',
  'nps-bus-stop': 'bus',
  'nps-electric-car-charging': 'ev',
  'nps-rr-xing': 'rr-crossing',
  'nps-flagpole': 'flag',
  'nps-point-of-interest': 'star',
};

const PARK_SIGNS = NPS_ICONS.filter((icon) => !RETIRED_ICONS[`nps-${icon.symbol}`]).map((icon) => ({
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
    f: [['M12 2.4 2 20.6h20ZM12 10.2c-1.1 0-3.7 6.6-3.7 8.2h7.4c0-1.6-2.6-8.2-3.7-8.2ZM1 21.2h22v1.6H1Z', GLYPH.leaf]],
    tags: ['camp', 'campground', 'campsite', 'recreation'],
    sym: ['Campground', 'Camp', 'Tent', 'Campsite'],
  },
  {
    id: 'camper', name: 'Camper / RV', group: 'Camp',
    f: [['M1.6 6.4h13.2l5 4.8v5.2h-1.5a3.4 3.4 0 0 0-6.8 0H9.9a3.4 3.4 0 0 0-6.8 0H1.6ZM3.6 8.4h5.2v3.6H3.6ZM15 9.2h2.4l1.8 2h-4.2Z', GLYPH.wood], ['M6.5 14a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm0 2.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2ZM16.5 14a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm0 2.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z', GLYPH.ink]],
    tags: ['rv', 'trailer', 'motorhome', 'camp', 'recreation'],
    sym: ['RV', 'Trailer Head', 'RV Park'],
  },
  {
    id: 'campfire', name: 'Campfire', group: 'Camp',
    f: [['M3.4 17.4 19.4 13.7l.8 3.2L4.2 20.6Z', GLYPH.wood], ['M4.2 14 20.2 17.7l-.8 3.2L3.4 17.2Z', GLYPH.wood], ['M12 1.8c3.7 4.1 5.7 6.8 5.7 9.6a5.7 5.7 0 0 1-11.4 0c0-2.8 2-5.5 5.7-9.6ZM12 6.6c1.9 2.2 2.9 3.7 2.9 5.2a2.9 2.9 0 0 1-5.8 0c0-1.5 1-3 2.9-5.2Z', GLYPH.flame]],
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
    f: [['M1.8 7.2h20.4v2.8H1.8ZM5.4 10.4h2.8L5.4 21.6H2.4ZM15.8 10.4h2.8l3 11.2h-3Z', GLYPH.woodLight], ['M3.8 13.8h16.4v2.6H3.8Z', GLYPH.wood]],
    sym: ['Picnic Area', 'Picnic'],
  },
  {
    id: 'lodging', name: 'Lodging', group: 'Camp',
    f: [['M1.6 6h2.8v15.4H1.6ZM4.4 11.6h17v6.2h-17ZM19.4 17.8h2v3.6h-2Z', GLYPH.wood], ['M5.8 12.9h4.8v3.4H5.8Z', GLYPH.shell]],
    sym: ['Hotel', 'Lodging'],
  },

  /* --------------------------------------------------------------- water */
  {
    id: 'water', name: 'Water source', group: 'Water',
    f: [['M12 2.4c4.5 6 7 9.1 7 12a7 7 0 0 1-14 0c0-2.9 2.5-6 7-12ZM9.5 11.8a3.1 3.1 0 0 0 2.7 4.8 3.7 3.7 0 0 1-2.7-4.8Z', GLYPH.water]],
    sym: ['Drinking Water', 'Water Source', 'Water'],
  },
  {
    id: 'spring', name: 'Spring', group: 'Water',
    f: [['M3 13.6h18v2.8a4.8 4.8 0 0 1-4.8 4.8H7.8A4.8 4.8 0 0 1 3 16.4ZM5.2 15.6v.8a2.6 2.6 0 0 0 2.6 2.6h8.4a2.6 2.6 0 0 0 2.6-2.6v-.8Z', GLYPH.water], ['M12 2.2c2.3 3.1 3.5 5 3.5 6.6a3.5 3.5 0 0 1-7 0c0-1.6 1.2-3.5 3.5-6.6ZM11 9.6h2v4.2h-2Z', GLYPH.water]],
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
    f: [['M1.4 9.4h21.2v5.2H1.4Z', GLYPH.wood], ['M8.6 1.4h6.8v21.2H8.6Zm1.4 3.6v1.6h4V5Zm0 4.4v1.6h4V9.4Zm0 4.4v1.6h4v-1.6Zm0 4.4v1.6h4V18Z', GLYPH.water]],
    tags: ['water', 'crossing', 'creek', 'stream'],
    sym: ['Ford', 'Crossing'],
  },
  {
    id: 'fishing', name: 'Fishing', group: 'Water',
    f: [['M2.4 12c4.1-5.8 10.5-5.8 14.6 0-4.1 5.8-10.5 5.8-14.6 0ZM7.4 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8ZM17.6 12 21.9 8.3c.4-.3 1.1 0 1.1.5v6.4c0 .5-.7.8-1.1.5Z', GLYPH.water]],
    tags: ['fish', 'angling', 'water', 'recreation'],
    sym: ['Fishing Area', 'Fishing'],
  },

  {
    id: 'boat', name: 'Boat launch', group: 'Water',
    f: [['M2 17.8c3.2-1.5 5.9-1.5 9.1 0 3.2 1.5 6.7 1.5 10.9 0v3.6c-4.2 1.5-7.7 1.5-10.9 0-3.2-1.5-5.9-1.5-9.1 0Z', GLYPH.water], ['M2.6 9.8h18.8l-2.6 5.8a1.8 1.8 0 0 1-1.6 1H6.8a1.8 1.8 0 0 1-1.6-1ZM17.8 3.6h2.6v6.2h-2.6Z', GLYPH.wood]],
    tags: ['boat', 'ramp', 'launch', 'water', 'recreation'],
    sym: ['Boat Launch', 'Boat Ramp', 'Boating', 'Boat'],
  },
  {
    id: 'paddle', name: 'Canoe / kayak', group: 'Water',
    f: [['M1.4 10.6c1.2 5.8 5.2 8.8 10.6 8.8s9.4-3 10.6-8.8c-2.6 2.9-6.4 4.3-10.6 4.3S4 13.5 1.4 10.6Z', GLYPH.wood], ['M8.6 12.6 7.4 11.4 14.4 4.9 15.6 6.1ZM16 6.6 14 4.4 17.5 1.1 19.5 3.3Z', GLYPH.ink]],
    tags: ['canoe', 'kayak', 'paddle', 'water', 'recreation'],
    sym: ['Canoe Access', 'Kayaking', 'Canoe', 'Kayak', 'Paddling'],
  },
  {
    id: 'swimming', name: 'Swimming', group: 'Water',
    f: [['M1.6 16.4c3.2-1.5 5.9-1.5 9.1 0 3.2 1.5 6.7 1.5 10.9 0v3.4c-4.2 1.5-7.7 1.5-10.9 0-3.2-1.5-5.9-1.5-9.1 0Z', GLYPH.water], ['M7.4 4.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM3.6 12.2h9.6l6.6-5.4 1.6 1.9-7.6 6.2H3.6Z', GLYPH.ink]],
    tags: ['swim', 'beach', 'water', 'recreation'],
    sym: ['Swimming', 'Swim Area', 'Wading', 'Swim'],
  },
  {
    id: 'geyser', name: 'Geyser / hot spring', group: 'Water',
    f: [['M8.8 17.6c-2.4-5.4-1.7-9.9 3.2-14.6 4.9 4.7 5.6 9.2 3.2 14.6Zm-4.2-.4c-1.2-2.8-.9-5.2.8-7.4 1 2.6.8 5-.8 7.4Zm14.8 0c1.2-2.8.9-5.2-.8-7.4-1 2.6-.8 5 .8 7.4Z', GLYPH.water], ['M2.4 21.8c0-2.9 4.3-4.5 9.6-4.5s9.6 1.6 9.6 4.5Z', GLYPH.stone]],
    tags: ['geyser', 'hot spring', 'thermal', 'water'],
    sym: ['Geyser', 'Hot Spring', 'Thermal'],
  },

  {
    id: 'marina', name: 'Marina', group: 'Water',
    f: [['M1.6 18.8c3.2-1.4 5.9-1.4 9.1 0 3.2 1.4 6.7 1.4 10.9 0v3.2c-4.2 1.4-7.7 1.4-10.9 0-3.2-1.4-5.9-1.4-9.1 0Z', GLYPH.water], ['M12.8 1.6 19.4 13h-6.6Zm-1.6 3.6V13H5.6ZM3 14.6h18l-2.4 4.2H5.4Z', GLYPH.ink]],
    tags: ['marina', 'harbour', 'harbor', 'dock', 'sail', 'water'],
    sym: ['Marina', 'Harbor', 'Harbour', 'Dock', 'Sailing'],
  },
  {
    id: 'ferry', name: 'Ferry', group: 'Water',
    f: [['M1.6 18.8c3.2-1.4 5.9-1.4 9.1 0 3.2 1.4 6.7 1.4 10.9 0v3.2c-4.2 1.4-7.7 1.4-10.9 0-3.2-1.4-5.9-1.4-9.1 0Z', GLYPH.water], ['M2.4 12.6h19.2l-2.4 5.4H4.8Zm4.4-8.4h8.4v2.8h2.4v4.2H6.8V7h2.2V4.2Zm2.2 2.8h4V6.4h-4Z', GLYPH.wood]],
    tags: ['ferry', 'crossing', 'boat', 'water'],
    sym: ['Vehicle Ferry', 'Ferry', 'Passenger Ferry'],
  },

  {
    id: 'beach', name: 'Beach', group: 'Water',
    f: [['M12 2.6c-5.2 0-9.4 3.4-9.4 7.6.9-1 1.9-1.5 3.1-1.5s2.2.5 3.1 1.5c.9-1 1.9-1.5 3.2-1.5s2.3.5 3.2 1.5c.9-1 1.9-1.5 3.1-1.5s2.2.5 3.1 1.5c0-4.2-4.2-7.6-9.4-7.6Z', GLYPH.flame], ['M11.1 9.6h1.8v10.2a2.4 2.4 0 0 0 4.8 0h1.8a4.2 4.2 0 0 1-8.4 0Z', GLYPH.ink]],
    tags: ['beach', 'shore', 'sand', 'swimming', 'water'],
    sym: ['Beach Access', 'Beach', 'Shore'],
  },
  {
    id: 'shipwreck', name: 'Shipwreck', group: 'Water',
    f: [['M1.6 17.4c3.2-1.4 5.9-1.4 9.1 0 3.2 1.4 6.7 1.4 10.9 0v3.4c-4.2 1.4-7.7 1.4-10.9 0-3.2-1.4-5.9-1.4-9.1 0Z', GLYPH.water], ['M11.6 1.6 14 2.4l-2.2 6.4 6.4-1.8 2 5.6c-4 3.4-8.6 4.6-13.8 3.4L3.8 6.2l5.6-1.6Z', GLYPH.wood]],
    tags: ['shipwreck', 'wreck', 'boat', 'water'],
    sym: ['Shipwreck', 'Wreck'],
  },

  /* -------------------------------------------------------------- terrain */
  {
    id: 'peak', name: 'Summit', group: 'Terrain',
    f: [['M12 2.4 22.6 21.6H1.4ZM12 7.4 8.2 13.6c2.5 1.3 5.1 1.3 7.6 0Z', GLYPH.stone]],
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
    f: [['M18.6 3.2c.1-.6 1-.5 1 .1l-.1 2.4 1.5-1.6c.4-.5 1.1.2.8.7l-1.9 2.4c-.3.4-.8.6-1.3.5l-1.1-.2-1 2.5c1.6 1 2.6 2.7 2.6 4.7 0 1.2-.4 2.4-1 3.3v3.6c0 .6-.4 1-1 1s-1-.4-1-1v-2.2c-.8.4-1.7.6-2.6.6h-2.7l-.6 2.4c-.1.5-.7.9-1.2.7-.5-.1-.9-.7-.7-1.2l.5-2h-1.6l-.6 2.4c-.1.5-.7.9-1.2.7-.5-.1-.9-.7-.7-1.2l.7-2.7c-1.6-1-2.6-2.7-2.6-4.6 0-3.2 2.9-5.6 6.4-5.6h4l1.1-2.8-1.3-1.9c-.4-.5.4-1.1.8-.6l1.4 1.7Z', GLYPH.wood]],
    sym: ['Animal', 'Wildlife', 'Hunting Area'],
  },

  /* ---------------------------------------------------------- recreation */
  {
    id: 'ski', name: 'Skiing', group: 'Recreation',
    f: [['M15.6 1.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM12.6 7.2h3l2.5 3.8 3.5 1.4-.9 2.3-4.3-1.7-1.4-2-1.3 3.5 2.8 3-.6 2.7-4.4-4.6.6-4.9-2.6 1.8-1.3-2ZM2.4 18.6l17.9-3 .4 2.3-17.9 3Z', GLYPH.ink]],
    tags: ['ski', 'skiing', 'snow', 'winter', 'nordic', 'recreation'],
    sym: ['Downhill Skiing', 'Cross Country Ski Trail', 'Skiing', 'Ski'],
  },
  {
    id: 'playground', name: 'Playground', group: 'Recreation',
    f: [['M3.8 4.4h16.4v2.2H3.8ZM4.6 5.6 2.2 21.4h2.3L6.9 5.6Zm14.8 0L21.8 21.4h-2.3L17.1 5.6Z', GLYPH.wood], ['M9 6.8h1.5v8.4H9Zm4.5 0H15v8.4h-1.5ZM7.8 15h8.4v2.2H7.8Z', GLYPH.ink]],
    tags: ['playground', 'swings', 'play', 'children', 'recreation'],
    sym: ['Playground', 'Play Area'],
  },
  {
    id: 'bear', name: 'Bear', group: 'Recreation',
    f: [['M6.6 3.2a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8Zm10.8 0a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8ZM12 5.2c-4.4 0-7.7 3.4-7.7 7.9S7.6 21.2 12 21.2s7.7-3.6 7.7-8.1S16.4 5.2 12 5.2Z', GLYPH.wood], ['M12 12.4c-2 0-3.5 1.3-3.5 3s1.5 3.1 3.5 3.1 3.5-1.4 3.5-3.1-1.5-3-3.5-3Zm0 1.4c.9 0 1.6.5 1.6 1.1s-.7 1.1-1.6 1.1-1.6-.5-1.6-1.1.7-1.1 1.6-1.1ZM8.9 9.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm6.2 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z', GLYPH.ink]],
    tags: ['bear', 'wildlife', 'animal', 'viewing', 'recreation'],
    sym: ['Bear Viewing', 'Bear'],
  },
  {
    id: 'bird', name: 'Birding', group: 'Recreation',
    f: [['M1.8 16c2.6-4.8 5.6-6.2 9-4.4l1.2.7 1.2-.7c3.4-1.8 6.4-.4 9 4.4-2.4-2.5-5-2.9-7.8-1.3L12 16.2l-2.4-1.5c-2.8-1.6-5.4-1.2-7.8 1.3Zm10.4-9c1.5-2.7 3.3-3.5 5.3-2.5l.7.4.7-.4c2-1 3.8-.2 5.3 2.5-1.4-1.4-2.9-1.6-4.6-.7l-1.4.8-1.4-.8c-1.7-.9-3.2-.7-4.6.7Z', GLYPH.ink]],
    tags: ['bird', 'birding', 'birdwatching', 'wildlife', 'recreation'],
    sym: ['Birding Wildlife Viewing', 'Birding', 'Birdwatching', 'Waterfowl'],
  },
  {
    id: 'flower', name: 'Wildflowers', group: 'Recreation',
    f: [['M12 1.8c1.9 0 3.1 1.4 2.9 3.2 1.6-1 3.4-.6 4.3 1s.3 3.4-1.3 4.3c1.6.9 2.2 2.7 1.3 4.3s-2.7 2-4.3 1c.2 1.8-1 3.2-2.9 3.2s-3.1-1.4-2.9-3.2c-1.6 1-3.4.6-4.3-1s-.3-3.4 1.3-4.3c-1.6-.9-2.2-2.7-1.3-4.3s2.7-2 4.3-1C8.9 3.2 10.1 1.8 12 1.8Zm0 6.2a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z', GLYPH.ember], ['M11.2 17.8h1.6v4.6h-1.6Zm-.6 1.4c-1.6-1.6-3.3-2.1-5.1-1.4.7 2 2.4 2.8 5.1 2.6Z', GLYPH.leaf]],
    tags: ['flower', 'wildflower', 'bloom', 'meadow', 'recreation'],
    sym: ['Flower Viewing', 'Wildflowers', 'Flowers'],
  },
  {
    id: 'bicycle', name: 'Cycling', group: 'Recreation',
    f: [['M5.8 12.4a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Zm0 2.2a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm12.4-2.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Zm0 2.2a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z', GLYPH.ink], ['M13.6 4.2h4.2v2h-2.1l.9 2.8h-6.9l-1.4 2 3.2 4.2-1.6 1.2-4.2-5.6 3-4.2h6l-.7-2.4ZM9.4 8.8h6.8l1.8 5.6-1.9.6-1.4-4.2H9.4Z', GLYPH.ink]],
    tags: ['bike', 'bicycle', 'cycling', 'mountain bike', 'recreation'],
    sym: ['Bicycle Trail', 'Biking', 'Bike', 'Cycling', 'Mountain Biking'],
  },
  {
    id: 'horse', name: 'Horseback riding', group: 'Recreation',
    f: [['M12.4 2 13.8 5.6 15.6 2.6 16.9 6.5c1.8 1.2 2.8 3 2.9 5.3L21 21.6H12.6c0-2.6-.6-4.8-1.8-6.6l-4.6.6c-1.4.2-2.4-.4-2.7-1.6-.3-1.3.3-2.2 1.6-2.7L11.6 4.4ZM13.6 7.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z', GLYPH.wood]],
    tags: ['horse', 'equestrian', 'riding', 'stable', 'recreation'],
    sym: ['Horseback Riding', 'Horse Trail', 'Equestrian', 'Horse'],
  },
  {
    id: 'climbing', name: 'Climbing', group: 'Recreation',
    f: [['M2.4 2.4h4.8v19.2H2.4Z', GLYPH.stoneDark], ['M14.6 2.4a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM12.6 8.2h3.2l1.6 4.6 2.8 2.6-1.6 1.8-2.6-2.4-.6 2.4 2.4 4.8-2.2 1.1-2.6-5.2-3.2 4.2-1.9-1.4 3.4-4.6-1.2-3.6-2.4 1.9-1.6-2Z', GLYPH.ink], ['M12.4 9.4 7 6.2l1.2-2 5.4 3.2Z', GLYPH.ink]],
    tags: ['climb', 'climbing', 'rock', 'bouldering', 'recreation'],
    sym: ['Climbing', 'Rock Climbing', 'Bouldering'],
  },
  {
    id: 'stars', name: 'Star gazing', group: 'Recreation',
    f: [['M9.6 1.8 11.4 6l4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2L3.6 7.8 7.8 6ZM18.2 9.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1ZM4.4 13.2l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8Z', GLYPH.ember], ['M1.6 21.6c1.8-3 4-4.5 6.6-4.5s4.4 1 5.4 3c1-1.4 2.4-2.1 4.2-2.1 2 0 3.7 1.2 5 3.6Z', GLYPH.stoneDark]],
    tags: ['stars', 'night sky', 'astronomy', 'dark sky', 'recreation'],
    sym: ['Star Gazing', 'Dark Sky', 'Astronomy'],
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
    id: 'food', name: 'Food', group: 'Services',
    f: [['M5.4 2.2h1.8v5.4h1.2V2.2h1.8v5.4h1.2V2.2h1.8v6.4c0 1.4-.9 2.4-2.2 2.7v10.5H7.6V11.3c-1.3-.3-2.2-1.3-2.2-2.7ZM16.6 2c1.9 1.5 2.8 3.8 2.8 6.9 0 1.9-.7 3.2-1.9 3.8v9.1h-2.2V12.7c-1.1-.6-1.7-1.8-1.7-3.6C13.6 5.9 14.7 3.4 16.6 2Z', GLYPH.ink]],
    tags: ['food', 'restaurant', 'cafe', 'diner', 'eat', 'services'],
    sym: ['Food Service', 'Restaurant', 'Cafe', 'Food'],
  },
  {
    id: 'phone', name: 'Telephone', group: 'Services',
    f: [['M4.8 3c1.9-.8 3.6-.2 4.6 1.7l1.4 2.6c.9 1.7.5 3.2-1.1 4.2l-.3.2c.9 1.9 2.3 3.3 4.2 4.2l.2-.3c1-1.6 2.5-2 4.2-1.1l2.6 1.4c1.9 1 2.5 2.7 1.7 4.6-.7 1.5-2 2.3-3.9 2.3-6.5 0-15.1-8.6-15.1-15.1 0-1.9.8-3.2 2.3-3.9Z', GLYPH.ink]],
    tags: ['phone', 'telephone', 'call', 'emergency', 'services'],
    sym: ['Telephone', 'Phone', 'Emergency Telephone'],
  },
  {
    id: 'wifi', name: 'Wi-Fi', group: 'Services',
    f: [['M12 17.2a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm0-5.8c2.3 0 4.4 1 5.9 2.5l-2.2 2.2a5.2 5.2 0 0 0-7.4 0l-2.2-2.2A8.3 8.3 0 0 1 12 11.4Zm0-5.8c3.8 0 7.3 1.6 9.8 4.1l-2.2 2.2A11 11 0 0 0 12 8.6c-3.1 0-5.8 1.2-7.6 3.3L2.2 9.7A13.8 13.8 0 0 1 12 5.6Z', GLYPH.ink]],
    tags: ['wifi', 'wi-fi', 'internet', 'wireless', 'services'],
    sym: ['Wi-Fi', 'WiFi', 'Wireless Internet', 'Internet'],
  },
  {
    id: 'signal', name: 'Cell signal', group: 'Services',
    d: ['M4 20V14', 'M9.3 20V10', 'M14.7 20V6', 'M20 20V3'],
    tags: ['cell', 'phone', 'reception', 'tower'],
    sym: ['Cell Tower', 'Signal', 'Cell Signal'],
  },

  /* ------------------------------------------------------------- interest */
  {
    id: 'historic', name: 'Historic site', group: 'Interest',
    d: ['M3 20h18', 'M5 20V9l7-5 7 5v11', 'M9 20v-6h6v6'],
    tags: ['building', 'landmark', 'heritage', 'monument', 'museum'],
    sym: ['Building', 'Historic', 'Historic Site', 'Landmark', 'Courthouse'],
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
    id: 'construction', name: 'Roadworks', group: 'Hazard',
    f: [['M10.8 2.4h2.4l5.8 16.6H5ZM9.2 8.6h5.6l.9 2.6H8.3Z', GLYPH.flame], ['M2.4 19.6h19.2v2.6H2.4Z', GLYPH.ink]],
    tags: ['construction', 'roadworks', 'closed', 'works', 'hazard'],
    sym: ['Construction', 'Road Work', 'Roadworks'],
  },
  {
    id: 'rockfall', name: 'Falling rocks', group: 'Hazard',
    f: [['M2.2 2.4h4.4l3.6 19.2H2.2Z', GLYPH.ink], ['M14.4 4.2 17.6 6l-.8 3.6-3.6.4-1.6-3.2ZM18.6 11.4l2.8 1.6-.7 3.2-3.2.3-1.4-2.8ZM12 15.6l2.4 1.4-.6 2.8-2.8.3-1.2-2.5Z', GLYPH.stone]],
    tags: ['rockfall', 'falling rocks', 'slide', 'hazard', 'danger'],
    sym: ['Falling Rocks', 'Rockfall', 'Rock Slide'],
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
    id: 'abandoned', name: 'Abandoned', group: 'Places',
    /*
     * One crossed-out building, for all of it.
     *
     * There were two: a storefront with an awning for "abandoned business"
     * and this one for "abandoned building". Nobody standing in front of a
     * shut place decides which of those it is - a boarded-up store is both -
     * and two pictures for one meaning is a worse picker, not a richer one.
     * The building is the general shape, so it is the one that stayed.
     */
    d: ['M4 21V9l8-5 8 5v12', 'M2 21h20', 'M7.5 12.5l9 6', 'M16.5 12.5l-9 6'],
    tags: ['building', 'store', 'shop', 'business', 'derelict', 'boarded', 'condemned',
      'vacant', 'closed', 'empty', 'ruin', 'house', 'decay'],
    sym: ['Abandoned', 'Abandoned Building', 'Abandoned Business', 'Derelict', 'Derelict Building',
      'Boarded Up', 'Condemned', 'Vacant', 'Out of Business'],
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
    id: 'barn', name: 'Barn / stable', group: 'Places',
    f: [['M12 1.6 18.2 5.6 21.6 9.2v12.6H2.4V9.2L5.8 5.6ZM9.4 13.4h5.2v8.4H9.4Z', GLYPH.brick]],
    tags: ['barn', 'stable', 'farm', 'horse', 'building'],
    sym: ['Stable', 'Barn', 'Farm'],
  },
  {
    id: 'cannon', name: 'Cannon', group: 'Places',
    f: [['M5.6 6.4 20.6 2.2l1.2 4.2-15 4.2Z', GLYPH.ink], ['M2.2 11.2h19v2.6H2.2ZM7.6 13a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Zm0 3.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z', GLYPH.wood]],
    tags: ['cannon', 'battlefield', 'artillery', 'civil war', 'historic'],
    sym: ['Cannon', 'Artillery', 'Gun Emplacement'],
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
    id: 'museum', name: 'Museum', group: 'Places',
    f: [['M12 1.8 23 8.2H1ZM3.4 9.8h2.8v9.2H3.4Zm4.8 0H11v9.2H8.2Zm4.8 0h2.8v9.2H13Zm4.8 0h2.8v9.2h-2.8Z', GLYPH.stone], ['M1.6 19.6h20.8v2.6H1.6Z', GLYPH.ink]],
    tags: ['museum', 'gallery', 'exhibit', 'visitor center', 'historic'],
    sym: ['Museum', 'Interpretive Exhibit', 'Gallery', 'Exhibit'],
  },
  {
    id: 'monument', name: 'Monument', group: 'Places',
    f: [['M12 1.4 14.9 6.6V17H9.1V6.6Z', GLYPH.stone], ['M6.8 17.8h10.4v1.8H6.8ZM4.4 20.2h15.2v2.2H4.4Z', GLYPH.ink]],
    tags: ['monument', 'obelisk', 'memorial', 'statue', 'historic'],
    sym: ['Monument', 'Memorial', 'Statue'],
  },
  {
    id: 'covered-bridge', name: 'Covered bridge', group: 'Ways',
    f: [['M1.4 10.4 12 3.6l10.6 6.8-1.4 2.2L12 6.6l-9.2 6ZM3.6 11.8h16.8v7.4H3.6Zm5 2.2v5.2h6.8V14Z', GLYPH.brick], ['M1.6 19.4c4.6 1.6 16.2 1.6 20.8 0v2.8c-4.6 1.6-16.2 1.6-20.8 0Z', GLYPH.water]],
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
    id: 'bus', name: 'Bus stop', group: 'Ways',
    f: [['M3.2 3.4h17.6v13.4H3.2Zm2.4 2.4v5.4h12.8V5.8Z', GLYPH.warn], ['M6.8 16.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Zm10.4 0a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2ZM5.6 12.8h3.2v2.2H5.6Zm9.6 0h3.2v2.2h-3.2Z', GLYPH.ink]],
    tags: ['bus', 'stop', 'transit', 'coach', 'shuttle'],
    sym: ['Bus Stop', 'Bus', 'Shuttle', 'Transit'],
  },
  {
    id: 'ev', name: 'EV charging', group: 'Ways',
    f: [['M5.6 3.6a3 3 0 0 1 3-3h6.8a3 3 0 0 1 3 3v18.8H5.6Z', GLYPH.ink], ['M13.4 5.4H9.8l-2.6 6.6h2.8l-.9 4.8 5-7.2h-3Z', GLYPH.spark]],
    tags: ['ev', 'electric', 'charging', 'charger', 'car'],
    sym: ['Electric Car Charging', 'EV Charging', 'Charging Station'],
  },
  {
    id: 'rr-crossing', name: 'Railroad crossing', group: 'Ways',
    f: [['M11 5.4h2V22h-2Z', GLYPH.wood], ['M3.6 2.3 4.8.5 20.4 11.7l-1.2 1.8Zm16.8 0L19.2.5 3.6 11.7l1.2 1.8Z', GLYPH.ink]],
    tags: ['railroad', 'crossing', 'crossbuck', 'grade crossing', 'rail'],
    sym: ['Railroad Crossing', 'RR Xing', 'Grade Crossing', 'Crossbuck'],
  },
  {
    id: 'airport', name: 'Airfield', group: 'Ways',
    f: [['M12 1.4c1.1 0 2 1.3 2 3v4.9l8.4 5v2.7L14 14.4v4.8l2.6 2v1.9L12 21.7l-4.6 1.4v-1.9l2.6-2v-4.8l-8.4 2.6v-2.7l8.4-5V4.4c0-1.7.9-3 2-3Z', GLYPH.stoneDark]],
    tags: ['airport', 'airfield', 'airstrip', 'plane', 'landing'],
    sym: ['Airport', 'Airfield', 'Airstrip', 'Sea Plane'],
  },
  {
    id: 'train', name: 'Rail station', group: 'Ways',
    f: [['M4.4 2.6h15.2v11.6H4.4Zm2.4 2.6v4.8h10.4V5.2ZM7 15a2.7 2.7 0 1 0 0 5.4A2.7 2.7 0 0 0 7 15Zm10 0a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z', GLYPH.ink], ['M1.6 21.2h20.8v1.8H1.6Z', GLYPH.stone]],
    tags: ['train', 'rail', 'station', 'depot', 'railway'],
    sym: ['Rail Station', 'Train Station', 'Depot', 'Metro Station', 'Train', 'Station'],
  },
  {
    id: 'railroad', name: 'Railroad', group: 'Ways',
    d: ['M7 3v18', 'M17 3v18', 'M5 7h14', 'M5 12h14', 'M5 17h14'],
    tags: ['rail', 'railway', 'train', 'trestle', 'depot', 'grade'],
    sym: ['Railroad', 'Railway', 'Rail', 'Trestle', 'Track'],
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
  return BY_ID.get(id) || BY_ID.get(RETIRED_ICONS[id]) || BY_ID.get(DEFAULT_PIN_ICON);
}

/**
 * The drawn icon a retired park sign became, if it was one.
 *
 * Used when a saved pin is opened so the editor selects the icon actually on
 * the map rather than showing nothing selected, and when a pin is written back
 * so the retired id is not carried forward for ever.
 */
export function resolvePinIconId(id) {
  return RETIRED_ICONS[id] || id;
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

/*
 * What a pin is called, and what folder it is in, are evidence too.
 *
 * A GaiaGPS export gives every pin the same generic symbol, so the only thing
 * that tells one from another is what the person typed. These rules read that,
 * and they are deliberately a short explicit list rather than a general
 * word-match: a title is free text, and guessing at it wrongly across a whole
 * folder is worse than leaving the pins alone.
 *
 * Order matters. "Covered bridge" is a bridge, so it has to be asked first, or
 * every covered bridge becomes a plain one.
 */
const TITLE_RULES = [
  // "CB" on its own, or with a number after it - CB 12, CB-4 - is how covered
  // bridges get written down in the field. Guarded by word boundaries so it
  // does not fire on "CBS Tower" or a word that happens to contain the letters.
  { icon: 'covered-bridge', test: /\bcovered[\s-]*bridge\b|\bcb\b(?!\s*radio)/i },
  { icon: 'bridge', test: /\bbridges?\b/i },
];

/*
 * And what the folder says, for the pins whose own names say nothing.
 *
 * Weaker than a title on purpose: somebody who filed a covered bridge in
 * "Abandoned" meant it to be a covered bridge in the abandoned folder.
 */
const FOLDER_RULES = [
  { icon: 'abandoned', test: /\babandoned\b/i },
];

const firstRule = (rules, text) => (text
  ? (rules.find((rule) => rule.test.test(text))?.icon || null)
  : null);

/** The icon a pin's own name calls for, or null if it says nothing useful. */
export function iconForTitle(title) {
  return firstRule(TITLE_RULES, String(title || '').trim());
}

/** The icon a folder's name calls for, for pins that have no better claim. */
export function iconForFolderName(name) {
  return firstRule(FOLDER_RULES, String(name || '').trim());
}

/**
 * Everything known about one pin, resolved to a single icon.
 *
 * The pin's own name first, then the symbol its source file carried, then the
 * folder it was filed in. Returns null when nothing has an opinion, which the
 * caller reads as "leave this pin as it is" rather than as "use the plain pin"
 * - a symbol somebody chose by hand must survive a re-match.
 */
export function iconForPin({ name, symbol, folderName } = {}) {
  return iconForTitle(name) || iconForSymbol(symbol) || iconForFolderName(folderName);
}

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
