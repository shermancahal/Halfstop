/**
 * Every map layer the viewer adds at runtime, as data.
 *
 * These used to be twelve object literals inline in addAppLayers, which meant
 * nothing could check them — the basemap style was validated against the real
 * Mapbox spec on every build and these were not. As a list they go through
 * tools/validate-style.mjs alongside it.
 *
 * Source ids are imported rather than repeated so a rename cannot silently
 * orphan a layer.
 */

export const FOLDER_SOURCE = 'folders';
export const REGION_SOURCE = 'offline-regions';
export const LIGHT_SOURCE = 'light-directions';
export const STORM_SOURCE = 'storm-warnings';
export const SCRATCH_HIGHLIGHT = 'scratch-highlight';
export const SCRATCH_CURSOR = 'scratch-cursor';
/** The drive the trip planner worked out, when a router has drawn one. */
export const TRIP_SOURCE = 'trip-route';

/** The image drawn at the end of a storm track, built by the viewer on demand. */
export const STORM_ARROW_IMAGE = 'abmap-storm-arrow';

/* Sun warm, moon cool, galactic core violet — matched exactly by the key in
   the panel, because a legend whose colours are close but not equal is worse
   than none. */
/* Geometry-type filters, shared so a layer cannot disagree with its source. */
export const IS_LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
export const IS_POLY = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
export const IS_POINT = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

const BODY_COLOUR = ['match', ['get', 'body'], 'moon', '#3d6ea8', 'core', '#7b4fa8', '#d87708'];
/* The same three, darkened until they hold up as text over the map. */
const LABEL_COLOUR = ['match', ['get', 'body'], 'moon', '#274b75', 'core', '#57327d', '#8f5206'];
const LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 8, 4.2, 14, 6];

/*
 * The drive is amber, not the brand's clay red.
 *
 * Reported: over West Virginia the route was invisible, because US and state
 * routes are drawn in almost exactly that red and the suggested drive
 * disappeared into the roads it was suggesting. Amber is nowhere in the road
 * palette, so nothing on the basemap competes with it, and it holds up on both
 * the light topo tan and the dark theme's green.
 *
 * The casing is dark rather than the white it was, because yellow on white
 * over pale ground is mush. Dark under amber reads on either theme.
 */
const TRIP_COLOUR = '#ffc21a';
const TRIP_CASING = '#3d2c00';

/** Sources every runtime layer needs, all of them initially empty. */
export function runtimeSources() {
  return [FOLDER_SOURCE, REGION_SOURCE, LIGHT_SOURCE, STORM_SOURCE, SCRATCH_HIGHLIGHT, SCRATCH_CURSOR,
    TRIP_SOURCE];
}

/**
 * In draw order, bottom to top: region outlines are context, the app's own
 * geometry sits above the basemap, and the sky bearings go over everything
 * because the whole point is to read them against the terrain.
 */
export function runtimeLayers({ labels = true, font } = {}) {
  const layers = [
  {
    id: 'storm-area', type: 'fill', source: STORM_SOURCE,
    filter: ['==', ['get', 'kind'], 'area'],
    paint: {
      'fill-color': ['match', ['get', 'severity'], 'Extreme', '#b3261e', 'Severe', '#d97706', '#6b7280'],
      'fill-opacity': 0.16,
    },
      },
  {
    id: 'storm-outline', type: 'line', source: STORM_SOURCE,
    filter: ['==', ['get', 'kind'], 'area'],
    paint: {
      'line-color': ['match', ['get', 'severity'], 'Extreme', '#b3261e', 'Severe', '#d97706', '#6b7280'],
      'line-width': 1.8,
    },
      },
  {
    id: 'storm-motion', type: 'line', source: STORM_SOURCE,
    filter: ['==', ['get', 'kind'], 'motion'],
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': '#b3261e',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.4, 12, 4],
      'line-opacity': 0.95,
    },
      },
  {
    id: 'storm-head', type: 'symbol', source: STORM_SOURCE,
    filter: ['==', ['get', 'kind'], 'head'],
    layout: {
      'icon-image': STORM_ARROW_IMAGE,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 0.95],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
    },
      },
  {
    id: 'storm-motion-label', type: 'symbol', source: STORM_SOURCE,
    filter: ['==', ['get', 'kind'], 'motion'],
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'label'],
      'text-size': 11.5,
      'text-offset': [0, -0.9],
    },
    paint: {
      'text-color': '#8c1d18',
      'text-halo-color': 'rgba(255,255,255,0.95)',
      'text-halo-width': 2.2,
    },
      },
  {
    /*
     * A casing exists to separate the line from whatever it crosses, not to be
     * the line. At 5.5px under a 2.8px stroke it was doing the second: the
     * colour survived as a thin stripe inside a fat white one, which is
     * exactly what "the lines are not coloured" looks like. Narrower than the
     * stroke plus a couple of pixels, and softer.
     */
    id: 'light-line-casing', type: 'line', source: LIGHT_SOURCE,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': 'rgba(255,255,255,0.75)',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6.4, 14, 9],
      'line-opacity': 0.75,
    },
      },
  {
    /*
     * Where the core goes across the whole night.
     *
     * Under the band, thinner and dashed, because it is context rather than the
     * subject: the band is what you will photograph, and this is where it is
     * heading. Drawn first so the band and the bearings sit on top of it.
     */
    id: 'light-track',
    type: 'line',
    source: LIGHT_SOURCE,
    filter: ['==', ['get', 'kind'], 'track'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      // By body, not fixed violet: the eclipse panel draws the moon's path
      // through the same layer, and a moon track in the core's colour would
      // disagree with both the spoke pointing at it and the key beside it.
      'line-color': BODY_COLOUR,
      'line-width': 1.6,
      'line-dasharray': [1.5, 2],
      'line-opacity': 0.6,
    },
  },
  {
    // An hour at a time along that track. Without them the curve says where the
    // core goes and not when, which is half an answer for someone deciding what
    // time to leave.
    id: 'light-track-hour',
    type: 'symbol',
    source: LIGHT_SOURCE,
    filter: ['==', ['get', 'kind'], 'hour'],
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 10,
      'text-allow-overlap': false,
      'text-padding': 6,
    },
    paint: {
      'text-color': LABEL_COLOUR,
      'text-halo-color': 'rgba(255,255,255,0.95)',
      'text-halo-width': 2,
    },
  },
  {
    /*
     * The Milky Way's band, which is a curve rather than a bearing.
     *
     * Its own layer because it is the one feature here that is not a straight
     * line from the observer: the dash and the round cap that suit a bearing
     * make a sampled arc look like a dotted mess, and a heavier stroke reads as
     * a band rather than as a direction.
     */
    id: 'light-arc',
    type: 'line',
    source: LIGHT_SOURCE,
    filter: ['==', ['get', 'kind'], 'arc'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#7b4fa8',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.2, 14, 5.5],
      'line-opacity': 0.75,
      'line-blur': 1.2,
    },
  },
  {
    /*
     * One label on the band, at its middle.
     *
     * The bearings each carry their own name along themselves; the band did
     * not, because a label repeated along a sampled curve is a dotted mess —
     * which left a wide violet line across the map that nothing on screen
     * explained. `symbol-placement: line-center` puts exactly one on it.
     */
    id: 'light-arc-label',
    type: 'symbol',
    source: LIGHT_SOURCE,
    filter: ['==', ['get', 'kind'], 'arc'],
    layout: {
      'symbol-placement': 'line-center',
      'text-field': 'The Milky Way band',
      'text-size': 12,
      'text-offset': [0, -0.9],
      'text-letter-spacing': 0.04,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#57327d',
      'text-halo-color': 'rgba(255,255,255,0.95)',
      'text-halo-width': 2.2,
    },
  },
  {
    id: 'light-line',
    type: 'line',
    source: LIGHT_SOURCE,
    // The arc is drawn by its own layer above; without this it would also be
    // drawn here as a dashed bearing, doubled and wrong.
    filter: ['all', ['!', ['get', 'now']], ['!=', ['get', 'kind'], 'arc']],
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': BODY_COLOUR,
      'line-width': LINE_WIDTH,
      'line-dasharray': [2.2, 1.3],
      'line-opacity': 1,
    },
  },
  {
    /*
     * Where a body is RIGHT NOW, drawn solid — that is the one you can check by
     * looking up. It is a second layer rather than a `case` on the dash pattern
     * because `line-dasharray` is not a data-driven property: GL rejects the
     * whole layer at addLayer time, which showed up as the white casing drawing
     * and the coloured line simply never appearing. No error, no layer.
     */
    id: 'light-line-now',
    type: 'line',
    source: LIGHT_SOURCE,
    filter: ['==', ['get', 'now'], true],
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': BODY_COLOUR,
      'line-width': LINE_WIDTH,
      'line-opacity': 1,
    },
  },
  {
    id: 'light-label', type: 'symbol', source: LIGHT_SOURCE,
    // Bearings are labelled; the arc is not — a label repeated along a sampled
    // curve is the "dotted mess" this layer split off to avoid.
    filter: ['!=', ['get', 'kind'], 'arc'],
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'label'],
      'text-size': 12.5,
      'text-offset': [0, -0.9],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': LABEL_COLOUR,
      'text-halo-color': 'rgba(255,255,255,0.95)',
      'text-halo-width': 2.2,
    },
      },
  /*
   * The drive, under everything the app draws on top of it.
   *
   * A casing and a line, the way a road is drawn, because a single stroke over
   * a topo basemap disappears into the contours exactly where the road is
   * hardest to follow. Under the folder geometry deliberately: the route is
   * context for the stops, and a saved track the reader imported should not be
   * hidden by a suggestion.
   */
  {
    id: 'trip-route-casing', type: 'line', source: TRIP_SOURCE, filter: IS_LINE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': TRIP_CASING,
      'line-opacity': 0.85,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 14, 11],
    },
      },
  {
    id: 'trip-route-line', type: 'line', source: TRIP_SOURCE, filter: IS_LINE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': TRIP_COLOUR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.4, 14, 6],
    },
      },
  /*
   * And the bit you walk, dashed, because it is not the same claim.
   *
   * A pin by a waterfall gets routed to the nearest road Valhalla can reach and
   * the response says nothing about the gap. Drawing that gap in the same solid
   * line as the drive would assert the car goes there. Dashed, and thinner, so
   * it reads as "and then on foot" rather than as more road.
   */
  {
    id: 'trip-walk-line', type: 'line', source: TRIP_SOURCE, filter: ['all', IS_LINE, ['get', 'walk']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      // The same amber, because it is the same trip. The dashes and the width
      // are what say it is not the driving.
      'line-color': TRIP_COLOUR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 14, 3.4],
      'line-dasharray': [1.5, 1.5],
    },
      },
  {
    id: 'region-fill', type: 'fill', source: REGION_SOURCE,
    paint: {
      'fill-color': '#1d4ed8',
      'fill-opacity': ['case', ['get', 'highlight'], 0.18, 0.05],
    },
      },
  {
    id: 'region-line', type: 'line', source: REGION_SOURCE,
    paint: {
      'line-color': '#1d4ed8',
      'line-width': ['case', ['get', 'highlight'], 2.6, 1.4],
      'line-dasharray': [3, 2],
    },
      },
  {
    id: 'scratch-highlight-line', type: 'line', source: 'scratch-highlight', filter: IS_LINE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.55, 'line-blur': 1 },
      },
  {
    id: 'scratch-cursor-point', type: 'circle', source: 'scratch-cursor',
    paint: {
      'circle-radius': 6, 'circle-color': '#ffffff',
      'circle-stroke-color': '#b4441f', 'circle-stroke-width': 3,
    },
      },
  ];

  /*
   * Text needs glyphs, and a style with no glyphs URL rejects the layer rather
   * than dropping the label — so on a basemap that cannot carry text these are
   * left out instead of failing. The lines and tracks still draw; only their
   * labels are missing, and the panel lists the same bearings in words.
   */
  const carried = labels ? layers : layers.filter((layer) => !layer.layout?.['text-field']);

  /*
   * And the font is stamped on here, in one place, rather than written on each
   * layer.
   *
   * Three of the five symbol layers below named no font at all, which is not
   * neutral: GL then asks for its default stack, and Protomaps' font server
   * has that no more than it has Mapbox's. The two that did name one named
   * Mapbox's. Every one of them 404s on the vector basemap, and a glyph range
   * that 404s rejects the whole tile parse - so `light-directions` sat at
   * loaded=false in every report for a day, and this was read as a label
   * problem rather than as the source never loading.
   *
   * Doing it at the single exit that already knows which layers carry text
   * means a symbol layer added below cannot forget, and cannot disagree with
   * the style it is added to.
   */
  if (!font) return carried;
  return carried.map((layer) => (layer.layout?.['text-field'] === undefined ? layer : {
    ...layer,
    layout: { ...layer.layout, 'text-font': [...font] },
  }));
}
