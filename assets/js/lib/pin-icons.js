/**
 * Pin icon set for trip planning and overlanding.
 *
 * Icons are stored as SVG path data on a 24x24 grid and rasterised at runtime
 * into map images. They are drawn in white only — the pin's colour comes from a
 * circle layer underneath, so N icons and M colours cost N images rather than
 * N x M. That is also why these are line drawings: a stroked glyph reads over
 * any circle colour, where a filled one would not.
 *
 * Adding an icon: append an entry with a unique id and 24x24 path data. It
 * appears in the pin editor automatically. Ids are stored in saved folders, so
 * renaming one orphans existing pins — add a new id instead.
 */

/**
 * @typedef {object} PinIcon
 * @property {string} id     stable key, stored on saved pins
 * @property {string} name   label in the picker
 * @property {string} group  picker section
 * @property {string[]} d    stroked SVG paths on a 24x24 viewBox
 * @property {string[]} [f]  filled SVG paths, drawn after the stroked ones
 * @property {string[]} [sym] GPX <sym> / KML icon names that map to this icon
 */

/** @type {PinIcon[]} */
export const PIN_ICONS = [
  /* ---------------------------------------------------------------- camp */
  {
    id: 'tent', name: 'Tent site', group: 'Camp',
    d: ['M12 4 3.5 20h17L12 4Z', 'M12 4v16'],
    sym: ['Campground', 'Camp', 'Tent', 'Campsite', 'RV Park'],
  },
  {
    id: 'camper', name: 'Camper / RV', group: 'Camp',
    d: ['M2 7h13a5 5 0 0 1 5 5v5H2V7Z', 'M6 10h5v3H6z', 'M2 17h20'],
    f: ['M7.5 20a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Z', 'M16.5 20a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Z'],
    sym: ['RV', 'Trailer Head', 'RV Park'],
  },
  {
    id: 'campfire', name: 'Campfire', group: 'Camp',
    d: ['M12 3c2.5 3 4 5 4 7.5a4 4 0 0 1-8 0C8 8 9.5 6 12 3Z', 'M4 20l16-4', 'M4 16l16 4'],
    sym: ['Fire', 'Campfire'],
  },
  {
    id: 'cabin', name: 'Cabin / shelter', group: 'Camp',
    d: ['M3 11 12 4l9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
    sym: ['Lodge', 'Cabin', 'Shelter', 'Hut'],
  },
  {
    id: 'picnic', name: 'Picnic area', group: 'Camp',
    d: ['M3 9h18', 'M6 9l-2 11', 'M18 9l2 11', 'M7 15h10'],
    sym: ['Picnic Area', 'Picnic'],
  },
  {
    id: 'lodging', name: 'Lodging', group: 'Camp',
    d: ['M3 18v-9', 'M3 12h12a5 5 0 0 1 5 5v1', 'M3 18h18'],
    f: ['M7 12a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 7 12Z'],
    sym: ['Hotel', 'Lodging'],
  },

  /* --------------------------------------------------------------- water */
  {
    id: 'water', name: 'Water source', group: 'Water',
    d: ['M12 3c4 5 6 7.5 6 10a6 6 0 0 1-12 0c0-2.5 2-5 6-10Z'],
    sym: ['Drinking Water', 'Water Source', 'Water'],
  },
  {
    id: 'spring', name: 'Spring', group: 'Water',
    d: ['M12 4v7', 'M8.5 7.5 12 4l3.5 3.5', 'M3 16c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2'],
    sym: ['Spring'],
  },
  {
    id: 'waterfall', name: 'Waterfall', group: 'Water',
    d: ['M6 3v11', 'M12 3v11', 'M18 3v11', 'M3 18c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2'],
    sym: ['Waterfall'],
  },
  {
    id: 'ford', name: 'River crossing', group: 'Water',
    d: ['M3 8c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2', 'M3 16c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2', 'M9 3v18'],
    sym: ['Ford', 'Crossing'],
  },
  {
    id: 'fishing', name: 'Fishing', group: 'Water',
    d: ['M3 12c4-5 10-5 14 0-4 5-10 5-14 0Z', 'M17 12l4-3v6l-4-3'],
    f: ['M8 11.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z'],
    sym: ['Fishing Area', 'Fishing'],
  },

  /* -------------------------------------------------------------- terrain */
  {
    id: 'peak', name: 'Summit', group: 'Terrain',
    d: ['M2 20 9.5 6l4.5 8 2.5-4L22 20H2Z'],
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
    sym: ['Scenic Area', 'Overlook', 'Viewpoint', 'Vista'],
  },
  {
    id: 'cave', name: 'Cave', group: 'Terrain',
    d: ['M3 20V13a9 9 0 0 1 18 0v7', 'M9 20v-4a3 3 0 0 1 6 0v4'],
    sym: ['Cave'],
  },
  {
    id: 'forest', name: 'Forest', group: 'Terrain',
    d: ['M9 3 4 12h10L9 3Z', 'M9 12v8', 'M17 7l-3.5 6h7L17 7Z', 'M17 13v7'],
    sym: ['Forest', 'Park', 'Tree'],
  },
  {
    id: 'wildlife', name: 'Wildlife', group: 'Terrain',
    d: ['M6 5 4 9l3 2', 'M18 5l2 4-3 2', 'M7 11c0 4 2 8 5 8s5-4 5-8', 'M9 11h6'],
    sym: ['Animal', 'Wildlife', 'Hunting Area'],
  },

  /* --------------------------------------------------------------- access */
  {
    id: 'trailhead', name: 'Trailhead', group: 'Access',
    d: ['M7 21c0-6 3-6 3-11S7 5 7 3', 'M17 21c0-5-3-5-3-9s3-4 3-6'],
    sym: ['Trail Head', 'Trailhead', 'Hiking', 'Trail'],
  },
  {
    id: 'parking', name: 'Parking', group: 'Access',
    d: ['M8 20V5h5a4.5 4.5 0 0 1 0 9H8'],
    sym: ['Parking Area', 'Parking'],
  },
  {
    id: 'gate', name: 'Gate', group: 'Access',
    d: ['M3 6v14', 'M21 6v14', 'M3 9h18', 'M3 16h18', 'M3 12.5h18'],
    sym: ['Gate'],
  },
  {
    id: 'gate-locked', name: 'Locked gate', group: 'Access',
    d: ['M4 6v14', 'M20 6v14', 'M4 9h16', 'M4 16h16', 'M9.5 14.5h5v4h-5z', 'M10.5 14.5v-1.5a1.5 1.5 0 0 1 3 0v1.5'],
    sym: ['Locked Gate', 'Closed'],
  },
  {
    id: 'fourwd', name: '4WD / high clearance', group: 'Access',
    d: ['M3 15h18', 'M5 15V9l3-3h6l3 4v5'],
    f: ['M7.5 19a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z', 'M16.5 19a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z'],
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
    sym: ['Bridge'],
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
    sym: ['Cell Tower', 'Signal', 'Telephone'],
  },

  /* ------------------------------------------------------------- interest */
  {
    id: 'historic', name: 'Historic site', group: 'Interest',
    d: ['M3 20h18', 'M5 20V9l7-5 7 5v11', 'M9 20v-6h6v6'],
    sym: ['Building', 'Historic', 'Museum', 'Monument'],
  },
  {
    id: 'ruins', name: 'Ruins / ghost town', group: 'Interest',
    d: ['M3 21V11l4-3v4l4-3v5l4-4v4l3-2v9', 'M2 21h20'],
    sym: ['Ghost Town', 'Ruins', 'Abandoned'],
  },
  {
    id: 'mine', name: 'Mine', group: 'Interest',
    d: ['M4 20 14 5', 'M9.5 12.5 20 20', 'M17 4l3 3', 'M15.5 5.5 18.5 8.5'],
    sym: ['Mine', 'Mining'],
  },
  {
    id: 'tower', name: 'Lookout tower', group: 'Interest',
    d: ['M6 21 12 3l6 18', 'M8.2 14h7.6', 'M9.6 9h4.8', 'M4 21h16'],
    sym: ['Tower', 'Lookout', 'Fire Tower'],
  },
  {
    id: 'photo', name: 'Photo spot', group: 'Interest',
    d: ['M3 8h4l2-3h6l2 3h4v12H3V8Z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
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
    d: ['M12 3.5 22 20.5H2L12 3.5Z', 'M12 10v4.5'],
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
    d: ['M3 7h18v12H3z', 'M12 10v6', 'M9 13h6'],
    sym: ['Medical Facility', 'Hospital', 'First Aid'],
  },

  /* ---------------------------------------------------------------- basic */
  {
    id: 'pin', name: 'Plain pin', group: 'Basic',
    d: ['M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z', 'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
    sym: ['Waypoint', 'Pin', 'Dot', 'Circle'],
  },
  {
    id: 'flag', name: 'Flag', group: 'Basic',
    d: ['M5 21V4', 'M5 5h12l-2.5 4L17 13H5'],
    sym: ['Flag', 'Flag, Blue', 'Flag, Green', 'Flag, Red'],
  },
  {
    id: 'star', name: 'Star', group: 'Basic',
    d: ['M12 3.5l2.6 5.6 6 .8-4.4 4.3 1.1 6.1-5.3-2.9-5.3 2.9 1.1-6.1L3.4 9.9l6-.8L12 3.5Z'],
    sym: ['Star', 'Favorite', 'Anchor'],
  },
  {
    id: 'marker', name: 'Cross-hair', group: 'Basic',
    d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4'],
    sym: ['Crosshair', 'Target'],
  },
];

export const DEFAULT_PIN_ICON = 'pin';

const BY_ID = new Map(PIN_ICONS.map((icon) => [icon.id, icon]));

export function getPinIcon(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_PIN_ICON);
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
const SYMBOL_LOOKUP = (() => {
  const lookup = new Map();
  for (const icon of PIN_ICONS) {
    for (const name of icon.sym || []) lookup.set(name.toLowerCase(), icon.id);
  }
  return lookup;
})();

/**
 * Best icon for a source symbol name. Falls back to a loose word match before
 * giving up, since exporters vary ("Campground" / "Camp Area" / "campsite").
 */
export function iconForSymbol(symbol) {
  const raw = String(symbol || '').trim().toLowerCase();
  if (!raw) return null;

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

/** Inline SVG markup for a UI button, sized to the caller's CSS. */
export function pinIconSVG(id, { size = 20, stroke = 1.7 } = {}) {
  const icon = getPinIcon(id);
  const strokes = (icon.d || []).map((d) => `<path d="${d}"/>`).join('');
  const fills = (icon.f || []).map((d) => `<path d="${d}" fill="currentColor" stroke="none"/>`).join('');
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"`
    + ` stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${strokes}${fills}</svg>`;
}

/**
 * Rasterise one icon to an ImageData for map.addImage().
 *
 * Drawn in ink, at `pixelRatio` scale. It sits on a white disc whose ring
 * carries the pin's colour, so it needs no shadow and no white - the symbol
 * is the contrast, the colour is the edge.
 */
export const PIN_INK = '#2A2118';

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
  ctx.strokeStyle = PIN_INK;
  ctx.fillStyle = PIN_INK;
  ctx.lineWidth = 2.1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const d of icon.d || []) ctx.stroke(new Path2D(d));
  for (const d of icon.f || []) ctx.fill(new Path2D(d));

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
