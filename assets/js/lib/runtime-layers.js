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
const LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 8, 4.2, 14, 6];

/** Sources every runtime layer needs, all of them initially empty. */
export function runtimeSources() {
  return [FOLDER_SOURCE, REGION_SOURCE, LIGHT_SOURCE, STORM_SOURCE, SCRATCH_HIGHLIGHT, SCRATCH_CURSOR];
}

/**
 * In draw order, bottom to top: region outlines are context, the app's own
 * geometry sits above the basemap, and the sky bearings go over everything
 * because the whole point is to read them against the terrain.
 */
export function runtimeLayers({ labels = true } = {}) {
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
      'line-color': '#7b4fa8',
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
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
      'text-allow-overlap': false,
      'text-padding': 6,
    },
    paint: {
      'text-color': '#57327d',
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
      'text-color': ['match', ['get', 'body'], 'moon', '#274b75', 'core', '#57327d', '#8f5206'],
      'text-halo-color': 'rgba(255,255,255,0.95)',
      'text-halo-width': 2.2,
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
  return labels ? layers : layers.filter((layer) => !layer.layout?.['text-field']);
}
